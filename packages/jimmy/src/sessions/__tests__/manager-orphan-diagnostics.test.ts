// Background completions (a sub-agent finishing AFTER the turn settled) reach
// handleOrphanHook, which has five early returns. Every one of them silently
// discarded a finished result — the shape of "Ryoko said it would report back
// and never did". These tests pin the diagnostic each gate now emits, so the
// next incident can be read straight out of gateway.log.
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
vi.mock("../../shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SessionManager } from "../manager.js";
import { logger } from "../../shared/logger.js";
import type { Engine, JinnConfig, Session } from "../../shared/types.js";

const mockWarn = vi.mocked(logger.warn);
const mockInfo = vi.mocked(logger.info);

const CONFIG = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "sonnet" }, codex: { bin: "codex", model: "" } },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
} as unknown as JinnConfig;

/** A session with no connector: the completion is recorded but has nowhere to go. */
const DETACHED_SESSION = {
  id: "s-orphan",
  engine: "claude",
  source: "slack",
  status: "idle",
  transportMeta: {},
} as unknown as Session;

function manager(config: JinnConfig = CONFIG): SessionManager {
  return new SessionManager(config, new Map<string, Engine>(), ["slack"]);
}

const STOP = { hook_event_name: "Stop", last_assistant_message: "レビュー完了：設計に問題なし" };

describe("SessionManager.handleOrphanHook — why a background result was dropped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.getMessages.mockReturnValue([]);
    registry.updateSession.mockReturnValue(undefined);
  });

  it("names the config gate when backgroundDelivery is turned off", async () => {
    const config = { ...CONFIG, sessions: { backgroundDelivery: false } } as unknown as JinnConfig;
    await manager(config).handleOrphanHook("s-orphan", STOP);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/backgroundDelivery is disabled/));
  });

  it("reports a missing session record instead of returning silently", async () => {
    registry.getSession.mockReturnValue(undefined);
    await manager().handleOrphanHook("s-gone", STOP);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/no session record for s-gone/));
  });

  it("reports a Stop hook that carried no assistant message", async () => {
    registry.getSession.mockReturnValue(DETACHED_SESSION);
    await manager().handleOrphanHook("s-orphan", { hook_event_name: "Stop", last_assistant_message: "   " });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/no last_assistant_message/));
  });

  it("reports a duplicate suppressed by the dedupe check", async () => {
    registry.getSession.mockReturnValue(DETACHED_SESSION);
    registry.getMessages.mockReturnValue([{ role: "assistant", content: STOP.last_assistant_message }] as any);
    await manager().handleOrphanHook("s-orphan", STOP);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringMatching(/identical to the message already delivered/));
    expect(registry.insertMessage).not.toHaveBeenCalled();
  });

  it("reports a completion that was recorded but had no channel to post to", async () => {
    registry.getSession.mockReturnValue(DETACHED_SESSION);
    await manager().handleOrphanHook("s-orphan", STOP);
    // It IS persisted — the loss is only in delivery, which is what the log must say.
    expect(registry.insertMessage).toHaveBeenCalledWith("s-orphan", "assistant", STOP.last_assistant_message);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/not posted to any channel.*no connector/));
  });
});
