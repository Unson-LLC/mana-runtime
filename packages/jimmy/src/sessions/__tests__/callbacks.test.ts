import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777 } })),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { notifyParentSession } from "../callbacks.js";
import { getSession } from "../registry.js";
import type { Session } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-001",
    engine: "claude",
    engineSessionId: null,
    source: "api",
    sourceRef: "api:test",
    connector: null,
    sessionKey: "test-key",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "test-employee",
    model: "opus",
    title: null,
    parentSessionId: "parent-001",
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
  } as Session;
}

const originalFetch = globalThis.fetch;

describe("notifyParentSession — no parent", () => {
  it("does nothing if child has no parentSessionId", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    const child = makeSession({ parentSessionId: null });
    notifyParentSession(child, { result: "done" });

    await new Promise((r) => setTimeout(r, 150));
    expect(spy).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("embeds the complete child result without requiring gateway API access", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");

    const body = JSON.parse(opts.body);
    expect(body.message).toContain("completed session");
    expect(body.message).toContain("Complete child result:\nSome result");
    expect(body.message).toContain("do not call the gateway API");
    expect(body.message).not.toContain("GET /api/sessions/");
    expect(body.message).toContain("parent session parent-001");
    expect(body.message).toContain("not a separate or unrelated conversation");
    expect(body.message).toContain("final answer to the original user");
  });

  it("truncates unusually large embedded child results", async () => {
    const longResult = "x".repeat(16_100);
    const child = makeSession();

    notifyParentSession(child, { result: longResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("x".repeat(16_000));
    expect(body.message).not.toContain("x".repeat(16_001));
    expect(body.message).toContain("[Child result truncated at 16000 characters.]");
  });

  it("includes the full result for ordinary responses", async () => {
    const shortResult = "Task done successfully";
    const child = makeSession();

    notifyParentSession(child, { result: shortResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(shortResult);
    expect(body.message).not.toContain("...");
  });

  it("error notifications contain the error message", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("Something broke");
    expect(body.message).toContain("⚠️");
    expect(body.message).toContain("continuation of the original user task");
    expect(body.message).toContain("Do not delegate the same task again");
  });

  it('sends with "notification" role', async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.role).toBe("notification");
  });
});

describe("notifyParentSession — alwaysNotify suppression", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("skips notification when alwaysNotify is false (success)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips notification when alwaysNotify is false (error)", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends notification when alwaysNotify is true", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sends notification when options is undefined (backward compat)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
