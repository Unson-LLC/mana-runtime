import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  accumulateSessionCost: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSessionBySessionKey: vi.fn(),
  getMessages: vi.fn(() => []),
  insertMessage: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("../registry.js", () => registry);
vi.mock("../callbacks.js", () => ({
  notifyParentSession: vi.fn(),
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
  notifyDiscordChannel: vi.fn(),
}));

import { SessionManager } from "../manager.js";
import type {
  Connector,
  Engine,
  IncomingMessage,
  JinnConfig,
  Session,
} from "../../shared/types.js";

const CONFIG = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "sonnet" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
} as unknown as JinnConfig;

const SESSION = {
  id: "parent-1",
  engine: "claude",
  source: "slack",
  sourceRef: "slack:C1:T1",
  connector: "slack",
  sessionKey: "slack:C1:T1",
  status: "idle",
  transportMeta: {},
} as Session;

function incoming(messageId = "171.001"): IncomingMessage {
  return {
    source: "slack",
    connector: "slack",
    sessionKey: "slack:C1:T1",
    channel: "C1",
    thread: "T1",
    user: "U1",
    userId: "U1",
    text: "critical-reviewerに委譲して重要な設計判断をレビューして",
    replyContext: { channel: "C1", threadTs: "T1" },
    messageId,
    attachments: [],
    raw: {},
  } as unknown as IncomingMessage;
}

function connector(): Connector {
  return {
    name: "slack",
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    reconstructTarget: vi.fn(() => ({ channel: "C1", thread: "T1" })),
    getCapabilities: vi.fn(() => ({
      reactions: false,
      files: false,
      streaming: false,
      threads: true,
    })),
  } as unknown as Connector;
}

describe("SessionManager deterministic critical routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.getSessionBySessionKey.mockReturnValue({ ...SESSION, transportMeta: {} });
    registry.updateSession.mockImplementation((_id, patch) => ({ ...SESSION, ...patch }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "child-1", model: "opus", effortLevel: "xhigh" }),
      text: async () => "",
    }));
  });

  it("creates one linked reviewer child and skips the initial parent engine run", async () => {
    const engineRun = vi.fn();
    const engines = new Map<string, Engine>([
      ["claude", { run: engineRun } as unknown as Engine],
    ]);
    const manager = new SessionManager(CONFIG, engines, ["slack"]);
    const slack = connector();

    await manager.route(incoming(), slack, {
      criticalRouting: { enabled: true, reviewerEmployee: "critical-reviewer" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-1/children");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      employee: "critical-reviewer",
    });
    expect(engineRun).not.toHaveBeenCalled();
    expect(registry.insertMessage).toHaveBeenCalledWith("parent-1", "user", expect.any(String));
    expect(registry.insertMessage).toHaveBeenCalledWith(
      "parent-1",
      "assistant",
      expect.stringMatching(/明示的にレビュー依頼.*opus\/xhigh/),
    );
    expect(slack.replyMessage).toHaveBeenCalledOnce();
  });

  it("does not create a second child for a persisted duplicate Slack event", async () => {
    registry.getSessionBySessionKey.mockReturnValue({
      ...SESSION,
      messageId: "171.001",
      transportMeta: {
        criticalRouting: {
          messageId: "171.001",
          status: "delegated",
          childSessionId: "child-1",
        },
      },
    });
    const manager = new SessionManager(CONFIG, new Map(), ["slack"]);

    await manager.route(incoming("171.001"), connector(), {
      criticalRouting: { enabled: true, reviewerEmployee: "critical-reviewer" },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(registry.insertMessage).not.toHaveBeenCalled();
  });

  it("atomically rebinds an existing Slack session to the resolved placement authority", async () => {
    registry.getSessionBySessionKey.mockReturnValue({
      ...SESSION,
      engine: "codex",
      engineSessionId: "stale-engine-session",
      employee: "legacy-agent",
      model: "legacy-model",
      effortLevel: "low",
    });
    const manager = new SessionManager(CONFIG, new Map(), ["slack"]);

    await manager.route(incoming(), connector(), {
      placement: {
        id: "mana-test",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
      },
      employee: {
        name: "ryoko",
        displayName: "Ryoko",
        department: "operations",
        rank: "executive",
        engine: "claude",
        model: "sonnet",
        effortLevel: "medium",
        persona: "Operate within the placement.",
      },
      criticalRouting: { enabled: true, reviewerEmployee: "critical-reviewer" },
    });

    expect(registry.updateSession).toHaveBeenCalledWith("parent-1", expect.objectContaining({
      engine: "claude",
      engineSessionId: null,
      employee: "ryoko",
      model: "sonnet",
      effortLevel: "medium",
      transportMeta: expect.objectContaining({ placementId: "mana-test" }),
    }));
  });

  it("kills and clears a same-engine transcript and stale override metadata on placement rebind", async () => {
    registry.getSessionBySessionKey.mockReturnValue({
      ...SESSION,
      engineSessionId: "stale-claude-transcript",
      transportMeta: {
        engineOverride: { originalEngine: "codex", until: "2000-01-01T00:00:00.000Z" },
        engineSessions: { claude: "stale-claude-transcript", codex: "stale-codex-transcript" },
        claudeSyncSince: "2020-01-01T00:00:00.000Z",
      },
    });
    const kill = vi.fn();
    const engine = { name: "claude", run: vi.fn(), kill, isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const manager = new SessionManager(CONFIG, new Map([["claude", engine]]), ["slack"]);

    await manager.route(incoming(), connector(), {
      placement: {
        id: "mana-test", connector: "slack", workspaceId: "T1", channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
      },
      employee: {
        name: "ryoko", displayName: "Ryoko", department: "operations", rank: "executive",
        engine: "claude", model: "sonnet", effortLevel: "medium", persona: "Operate within placement.",
      },
      criticalRouting: { enabled: true, reviewerEmployee: "critical-reviewer" },
    });

    expect(kill).toHaveBeenCalledWith("parent-1", "placement authority rebind");
    expect(registry.updateSession).toHaveBeenCalledWith("parent-1", expect.objectContaining({
      engine: "claude",
      engineSessionId: null,
      transportMeta: { placementId: "mana-test" },
    }));
  });

  it("keeps the engine transcript across turns when the placement authority is unchanged", async () => {
    registry.getSessionBySessionKey.mockReturnValue({
      ...SESSION,
      engineSessionId: "live-claude-transcript",
      employee: "ryoko",
      model: "sonnet",
      effortLevel: "medium",
      transportMeta: { placementId: "mana-test" },
    });
    const kill = vi.fn();
    const engineRun = vi.fn().mockResolvedValue({ result: "done", sessionId: "live-claude-transcript", durationMs: 1 });
    const engine = { name: "claude", run: engineRun, kill, isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const manager = new SessionManager(CONFIG, new Map([["claude", engine]]), ["slack"]);

    await manager.route(incoming(), connector(), {
      placement: {
        id: "mana-test", connector: "slack", workspaceId: "T1", channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
      },
      employee: {
        name: "ryoko", displayName: "Ryoko", department: "operations", rank: "executive",
        engine: "claude", model: "sonnet", effortLevel: "medium", persona: "Operate within placement.",
      },
    });

    expect(kill).not.toHaveBeenCalled();
    expect(registry.updateSession).toHaveBeenCalledWith("parent-1", expect.objectContaining({
      engine: "claude",
      engineSessionId: "live-claude-transcript",
      transportMeta: expect.objectContaining({ placementId: "mana-test" }),
    }));
    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: "live-claude-transcript",
    }));
  });

  it("passes the fail-closed Placement boundary to the real Slack engine call site", async () => {
    const engineRun = vi.fn().mockResolvedValue({ result: "done", sessionId: "claude-1", durationMs: 1 });
    const engine = { name: "claude", run: engineRun, kill: vi.fn(), isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const manager = new SessionManager(CONFIG, new Map([["claude", engine]]), ["slack"]);

    await manager.route(incoming(), connector(), {
      placement: {
        id: "mana-test", connector: "slack", workspaceId: "T1", channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
      },
      employee: {
        name: "ryoko", displayName: "Ryoko", department: "operations", rank: "executive",
        engine: "claude", model: "sonnet", effortLevel: "medium", persona: "Operate within placement.",
      },
    });

    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({
      strictMcpConfig: true,
      enableChrome: false,
    }));
  });

  it("keeps the real legacy Slack engine call site non-strict", async () => {
    const engineRun = vi.fn().mockResolvedValue({ result: "done", sessionId: "claude-legacy", durationMs: 1 });
    const engine = { name: "claude", run: engineRun, kill: vi.fn(), isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const manager = new SessionManager(CONFIG, new Map([["claude", engine]]), ["slack"]);

    await manager.route(incoming(), connector());

    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({
      strictMcpConfig: false,
      enableChrome: undefined,
    }));
  });

  it("does not announce or persist an unsupported Placement fallback after a Claude rate limit", async () => {
    vi.useFakeTimers();
    const claudeRun = vi.fn()
      .mockResolvedValueOnce({
        error: "Claude usage limit reached",
        rateLimit: { status: "rejected" },
        durationMs: 1,
      })
      .mockResolvedValueOnce({ result: "recovered", sessionId: "claude-2", durationMs: 1 });
    const codexRun = vi.fn();
    const claude = { name: "claude", run: claudeRun, kill: vi.fn(), isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const codex = { name: "codex", run: codexRun, kill: vi.fn(), isAlive: vi.fn(), killAll: vi.fn() } as unknown as Engine;
    const config = {
      ...CONFIG,
      sessions: { rateLimitStrategy: "fallback", fallbackEngine: "codex", maxRetries: 0 },
    } as unknown as JinnConfig;
    const manager = new SessionManager(config, new Map([["claude", claude], ["codex", codex]]), ["slack"]);
    const slack = connector();

    const routePromise = manager.route(incoming(), slack, {
      placement: {
        id: "mana-test", connector: "slack", workspaceId: "T1", channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
      },
      employee: {
        name: "ryoko", displayName: "Ryoko", department: "operations", rank: "executive",
        engine: "claude", model: "sonnet", effortLevel: "medium", persona: "Operate within placement.",
      },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await routePromise;

    expect(codexRun).not.toHaveBeenCalled();
    expect(registry.updateSession).not.toHaveBeenCalledWith("parent-1", expect.objectContaining({ engine: "codex" }));
    expect(slack.replyMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Switching to GPT"),
    );
    vi.useRealTimers();
  });
});
