import { describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at the top level. node-pty loads its
// native module at import time and that fails on Linux CI runners (looks for
// prebuilds/linux-x64/pty.node under a wrong relative path). TurnResolver is a
// pure-JS class with zero PTY dependency, so mocking the module keeps the test
// focused and CI-portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { TurnResolver, buildInteractiveArgs, isNativeClaudeCommand } from "../claude-interactive.js";

describe("interactive Claude permission mode", () => {
  const base = { prompt: "investigate", settingsPath: "/tmp/settings.json" };

  it("uses Claude plan mode without bypass for draft-only nodes", () => {
    const args = buildInteractiveArgs({ ...base, permissionMode: "plan" });

    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("fails safe to plan mode when no mode is configured", () => {
    const args = buildInteractiveArgs(base);

    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("uses bypass only when explicitly configured", () => {
    const args = buildInteractiveArgs({ ...base, permissionMode: "bypassPermissions" });

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });
});

describe("TurnResolver", () => {
  it("resolves only after BOTH SessionStart and Stop", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved).toBeUndefined(); // Stop alone is not enough
    r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved.result).toBe("done");
    expect(resolved.sessionId).toBe("claude-123");
    expect(resolved.numTurns).toBe(1);
  });

  it("settles with an Interrupted error when killed", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.interrupt("Interrupted: user");
    const v = await r.promise;
    expect(v.error).toMatch(/^Interrupted/);
  });

  it("treats a missing session id as a hard error", async () => {
    const r = new TurnResolver({ fallbackSessionId: undefined });
    r.onHook({ hook_event_name: "SessionStart" }); // no session_id
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
    const v = await r.promise;
    expect(v.error).toMatch(/session id/i);
  });

  it("with assumeStarted, resolves on Stop alone using fallbackSessionId", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "ok" });
    const v = await r.promise;
    expect(v.result).toBe("ok");
    expect(v.sessionId).toBe("warm-sid");
    expect(v.numTurns).toBe(1);
  });

  it("settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    const v = await r.promise;
    expect(v.error).toMatch(/rate_limit/);
    expect(v.numTurns).toBe(1);
    expect(r.stopFailure?.error).toBe("rate_limit");
  });
});

describe("TurnResolver — StopFailure grace window (upstream port)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("holds a server_error StopFailure in grace and settles with the error after expiry", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 20 });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(5);
    expect(resolved).toBeUndefined(); // held in grace, not settled yet
    await sleep(40);
    expect(resolved?.error).toMatch(/server_error/);
    expect(resolved?.numTurns).toBe(1);
  });

  it("a later Stop supersedes the graced failure — the CLI retried and finished", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", assumeStarted: true, stopFailureGraceMs: 50 });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(5);
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "recovered answer" });
    const v = await r.promise;
    expect(v.error).toBeUndefined();
    expect(v.result).toBe("recovered answer");
    expect(r.stopFailure).toBeUndefined(); // superseded, not exposed
  });

  it("tool-hook activity re-arms the grace window", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 30 });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    // Keep feeding activity past the original 30ms window.
    for (let i = 0; i < 4; i++) {
      await sleep(15);
      r.onHook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    }
    expect(resolved).toBeUndefined(); // still alive well past 30ms
    await sleep(60); // quiet — grace finally expires
    expect(resolved?.error).toMatch(/server_error/);
  });

  it("defers settling while shouldDeferStopFailure reports in-flight work", async () => {
    let busy = true;
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10, shouldDeferStopFailure: () => busy });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(40);
    expect(resolved).toBeUndefined(); // deferred — sub-agent still streaming
    busy = false;
    await sleep(30);
    expect(resolved?.error).toMatch(/server_error/);
  });

  it("rate_limit / authentication_failed still settle immediately", async () => {
    for (const error of ["rate_limit", "authentication_failed", "billing_error", "max_output_tokens"]) {
      const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10_000 });
      r.onHook({ hook_event_name: "StopFailure", error });
      const v = await r.promise; // resolves without waiting for any grace
      expect(v.error).toContain(error);
    }
  });

  it("PTY death with a pending graced failure reports the API error, not 'process exited'", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10_000 });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    r.interrupt("Interrupted: claude process exited");
    const v = await r.promise;
    expect(v.error).toMatch(/server_error/);
  });

  it("strips leaked thinking blocks from Stop hook assistant text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({
      hook_event_name: "Stop",
      last_assistant_message: "<thinking>private reasoning</thinking>\n\nVisible answer.",
    });
    const v = await r.promise;
    expect(v.result).toBe("Visible answer.");
  });

  it("can recover-complete a turn when the Stop hook is missing", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("transcript final", "c1");
    const v = await r.promise;
    expect(v.result).toBe("transcript final");
    expect(v.sessionId).toBe("c1");
  });
});

describe("native Claude command handling (upstream port)", () => {
  it("classifies native local commands", () => {
    expect(isNativeClaudeCommand("/compact")).toBe(true);
    expect(isNativeClaudeCommand("/usage")).toBe(true);
    expect(isNativeClaudeCommand("  /model opus")).toBe(true);
    expect(isNativeClaudeCommand("/init")).toBe(false); // real-turn command
    expect(isNativeClaudeCommand("hello /compact")).toBe(false);
    expect(isNativeClaudeCommand("")).toBe(false);
  });

  it("a native turn's Stop settles EMPTY — stale last_assistant_message is not persisted", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true, native: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "PREVIOUS turn's text" });
    const v = await r.promise;
    expect(v.result).toBe("");
    expect(v.error).toBeUndefined();
  });

  it("completeNativeCommand settles empty (context mutators fire no Stop at all)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true, native: true });
    r.completeNativeCommand();
    const v = await r.promise;
    expect(v.result).toBe("");
    expect(v.numTurns).toBe(1);
  });
});
