import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable fake PTYs. Each pty.spawn() pushes one here so the test can drive
// its onExit precisely (reproducing the kill->respawn race timing).
interface FakePty {
  pid: number;
  _exitCode: number | null;
  _killCalled: boolean;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  _errorCb?: (err: Error) => void;
  fireExit: () => void;
  /** Fire a PTY-master socket error (e.g. EIO) WITHOUT firing onExit — the
   *  issue #18 failure mode where the transport dies but the proc never exits. */
  fireError: (err?: Error) => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 1000 + ptys.length,
    _exitCode: null,
    _killCalled: false,
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() { p._killCalled = true; }, // signal sent; real exit is async (fireExit)
    write() {},
    resize() {},
    on(event, cb) { if (event === "error") p._errorCb = cb as (err: Error) => void; },
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
    fireError(err) { p._errorCb?.(err ?? Object.assign(new Error("read EIO"), { code: "EIO" })); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
}));
// Avoid real sockets: the SSE proxy is exercised empirically elsewhere (Item A).
vi.mock("../sse-pty-proxy.js", () => ({
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41000; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { logger } from "../../shared/logger.js";

const flush = () => new Promise((r) => setTimeout(r, 15));
const mockWarn = vi.mocked(logger.warn);
const mockDebug = vi.mocked(logger.debug);

describe("InteractiveClaudeEngine — kill->respawn race (Item C)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  it("a stale PTY's exit does not kill or poison the freshly-respawned turn", async () => {
    // Turn 1 (cold spawn).
    const p1 = engine.run({ sessionId: "s1", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const ptyA = ptys[0];
    expect(ptyA).toBeDefined();

    // api.ts interrupts the in-flight turn for a new message.
    engine.kill("s1", "Interrupted: new message received");
    const r1 = await p1;
    expect(r1.error).toBe("Interrupted: new message received");

    // Turn 2 (cold spawn — releaseSession cleared the warm entry).
    let r2: any;
    void engine.run({ sessionId: "s1", prompt: "b", cwd: "/tmp" } as any).then((v) => { r2 = v; });
    await flush();
    const ptyB = ptys[1];
    expect(ptyB).toBeDefined();
    expect(ptyB).not.toBe(ptyA);

    // The OLD PTY's SIGTERM finally takes effect — its exit fires AFTER ptyB was adopted.
    ptyA.fireExit();
    await flush();

    // Fix assertions: the stale exit neither killed ptyB nor settled turn 2.
    expect(ptyB._killCalled).toBe(false);
    expect(r2).toBeUndefined();

    // Turn 2 then completes normally via its own hooks — no double-error.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c2" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done2" });
    await flush();
    expect(r2.result).toBe("done2");
    expect(r2.error).toBeUndefined();
  });

  it("a genuine crash of the current turn's PTY still interrupts (no hang)", async () => {
    const p = engine.run({ sessionId: "s2", prompt: "c", cwd: "/tmp" } as any);
    await flush();
    const ptyC = ptys[0];
    ptyC.fireExit(); // current PTY dies mid-turn with no Stop hook
    const r = await p;
    expect(r.error).toMatch(/claude process exited/);
  });
});

describe("InteractiveClaudeEngine — PTY socket error / EIO (issue #18)", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  const completeTurn = (sid: string) => {
    hookCb!({ hook_event_name: "SessionStart", session_id: sid });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "ok" });
  };

  it("cold-respawns a warm PTY when authoritative instructions change", async () => {
    const first = engine.run({
      sessionId: "instruction-refresh",
      prompt: "first",
      systemPrompt: "persona-v1",
      cwd: "/tmp",
    } as any);
    await flush();
    const firstPty = ptys[0];
    completeTurn("instruction-cli-1");
    await first;
    expect(lifecycle.getWarm("instruction-refresh")).toBeDefined();

    let secondResult: any;
    void engine.run({
      sessionId: "instruction-refresh",
      prompt: "second",
      systemPrompt: "persona-v2",
      resumeSessionId: "instruction-cli-1",
      cwd: "/tmp",
    } as any).then((value) => { secondResult = value; });
    await flush();

    expect(firstPty._killCalled).toBe(true);
    expect(ptys[1]).toBeDefined();
    expect(ptys[1]).not.toBe(firstPty);
    completeTurn("instruction-cli-1");
    await flush();
    expect(secondResult.result).toBe("ok");
  });

  it("an EIO with no onExit still interrupts the active turn AND evicts the warm handle", async () => {
    const p = engine.run({ sessionId: "s3", prompt: "x", cwd: "/tmp" } as any);
    await flush();
    const pty = ptys[0];
    expect(lifecycle.getWarm("s3")).toBeDefined();

    pty.fireError(); // socket dies (EIO); onExit is NOT fired
    const r = await p;

    // Turn settles (no hang until the watchdog) and the corpse is evicted so the
    // next turn can't reuse it.
    expect(r.error).toMatch(/socket error/);
    expect(lifecycle.getWarm("s3")).toBeUndefined();
    expect(pty._killCalled).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session s3: read EIO"),
    );
  });

  it("does not warn when intentional teardown emits EIO synchronously", async () => {
    const p = engine.run({
      sessionId: "expected-eio",
      prompt: "x",
      cwd: "/tmp",
      keepWarmPty: false,
    } as any);
    await flush();
    const pty = ptys[0];
    pty.kill = () => {
      pty._killCalled = true;
      pty.fireError(Object.assign(new Error("read EIO"), { code: "EIO" }));
    };

    completeTurn("expected-eio-cli");
    const r = await p;
    await flush();

    expect(r.result).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(pty._killCalled).toBe(true);
    expect(lifecycle.getWarm("expected-eio")).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session expected-eio"),
    );
    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining("PTY closed during teardown for session expected-eio: read EIO"),
    );
  });

  it("still warns when intentional teardown emits a non-EIO socket error", async () => {
    const p = engine.run({
      sessionId: "expected-epipe",
      prompt: "x",
      cwd: "/tmp",
      keepWarmPty: false,
    } as any);
    await flush();
    const pty = ptys[0];
    pty.kill = () => {
      pty._killCalled = true;
      pty.fireError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    };

    completeTurn("expected-epipe-cli");
    const r = await p;
    await flush();

    expect(r.result).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session expected-epipe: write EPIPE"),
    );
  });

  it("keeps expected EIO plus late onExit cleanup idempotent", async () => {
    const releaseSpy = vi.spyOn(lifecycle, "releaseSession");
    const p = engine.run({
      sessionId: "expected-late-exit",
      prompt: "x",
      cwd: "/tmp",
      keepWarmPty: false,
    } as any);
    await flush();
    const pty = ptys[0];
    pty.kill = () => {
      pty._killCalled = true;
      pty.fireError(Object.assign(new Error("read EIO"), { code: "EIO" }));
    };

    completeTurn("expected-late-exit-cli");
    const r = await p;
    pty.fireExit();
    await flush();

    expect(r.result).toBe("ok");
    expect(r.error).toBeUndefined();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(lifecycle.getWarm("expected-late-exit")).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session expected-late-exit"),
    );
  });

  it("does not leak an old handle's teardown intent into a respawned PTY", async () => {
    const p1 = engine.run({ sessionId: "intent-isolation", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const oldPty = ptys[0];
    engine.kill("intent-isolation", "Interrupted: replace");
    await p1;

    let r2: any;
    void engine.run({ sessionId: "intent-isolation", prompt: "b", cwd: "/tmp" } as any)
      .then((value) => { r2 = value; });
    await flush();
    const newPty = ptys[1];

    oldPty.fireError(Object.assign(new Error("read EIO"), { code: "EIO" }));
    await flush();
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session intent-isolation"),
    );

    vi.clearAllMocks();
    newPty.fireError(Object.assign(new Error("read EIO"), { code: "EIO" }));
    await flush();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("PTY socket error for session intent-isolation: read EIO"),
    );
    expect(r2.error).toMatch(/socket error/);
  });

  it("a warm PTY killed by EIO is not reused — the next turn cold-spawns a new PTY", async () => {
    // Turn 1 completes; PTY stays warm.
    const p1 = engine.run({ sessionId: "s4", prompt: "a", cwd: "/tmp" } as any);
    await flush();
    const ptyA = ptys[0];
    completeTurn("c1");
    await p1;
    expect(lifecycle.getWarm("s4")).toBeDefined();

    // EIO kills the idle warm PTY without onExit → must be evicted.
    ptyA.fireError();
    await flush();
    expect(lifecycle.getWarm("s4")).toBeUndefined();

    // Next turn must cold-spawn a brand-new PTY, NOT inject into the corpse.
    let r2: any;
    void engine.run({ sessionId: "s4", prompt: "b", cwd: "/tmp" } as any).then((v) => { r2 = v; });
    await flush();
    const ptyB = ptys[1];
    expect(ptyB).toBeDefined();
    expect(ptyB).not.toBe(ptyA);
    completeTurn("c2");
    await flush();
    expect(r2.result).toBe("ok");
    expect(r2.error).toBeUndefined();
  });

  it("EIO followed by a late onExit is idempotent (first cause wins, no double-settle)", async () => {
    const p = engine.run({ sessionId: "s5", prompt: "x", cwd: "/tmp" } as any);
    await flush();
    const pty = ptys[0];
    pty.fireError();             // EIO settles + evicts
    pty.fireExit();             // late exit must be a no-op (already handled)
    const r = await p;
    expect(r.error).toMatch(/socket error/); // not overwritten by "process exited"
    expect(lifecycle.getWarm("s5")).toBeUndefined();
  });
});
