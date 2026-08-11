import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import * as registry from "../../sessions/registry.js";
import {
  formatLearningReconciliationLog,
  parseLearningReconciliationPlacements,
  reconcileLearningCandidates,
} from "../reconcile-conversations.js";

vi.mock("../../sessions/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/registry.js")>();
  return { ...actual, getMessages: vi.fn(), listSessions: vi.fn() };
});

const session: Session = {
  id: "session-1",
  engine: "claude",
  engineSessionId: null,
  source: "slack",
  sourceRef: "C1",
  connector: "slack",
  sessionKey: "slack:T1:C1:thread-1",
  replyContext: { channel: "C1", thread: "thread-1" },
  messageId: null,
  transportMeta: {
    team: "T1",
    channelId: "C1",
    placementId: "mana-accounting",
    speakerSlackId: "U1",
  },
  employee: null,
  model: null,
  title: null,
  parentSessionId: null,
  status: "interrupted",
  effortLevel: null,
  totalCost: 0,
  totalTurns: 0,
  lastContextTokens: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  lastActivity: "2026-08-10T00:00:00.000Z",
  lastError: null,
};

describe("reconcileLearningCandidates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures the final interrupted turn with its current speaker scope", () => {
    vi.mocked(registry.getMessages).mockReturnValue([
      { id: "u1", role: "user", content: "契約書台帳を同期したい", timestamp: 1 },
      { id: "a1", role: "assistant", content: "確認します", timestamp: 2 },
      { id: "u2", role: "user", content: "Driveにも保存して", timestamp: 3 },
    ]);
    const capture = vi.fn();

    const result = reconcileLearningCandidates(
      { capture } as never,
      [{ id: "mana-accounting", projects: ["back-office"] } as never],
      [session],
      { placementIds: new Set(["mana-accounting"]) },
    );

    expect(result).toEqual({
      sessionsScanned: 1,
      turnsAttempted: 1,
      turnsWithoutAssistant: 1,
      sessionsSkippedUnscoped: 0,
      sessionsSkippedPlacement: 0,
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      userMessageId: "u2",
      assistantMessageId: "missing:u2",
      assistantContent: expect.stringContaining("No completed assistant response"),
      workspace: "T1",
      channelId: "C1",
      actorExternalId: "U1",
      projectCode: "back-office",
    }));
  });

  it("skips sessions that cannot be scoped to a workspace and channel", () => {
    const capture = vi.fn();
    const result = reconcileLearningCandidates(
      { capture } as never,
      undefined,
      [{ ...session, replyContext: null, transportMeta: {} }],
      { placementIds: new Set(["mana-accounting"]) },
    );
    expect(result.turnsAttempted).toBe(0);
    expect(result.sessionsSkippedUnscoped).toBe(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("pairs a completed final assistant response and remains idempotency-compatible", () => {
    vi.mocked(registry.getMessages).mockReturnValue([
      { id: "u1", role: "user", content: "契約書台帳を同期したい", timestamp: 1 },
      { id: "a1", role: "assistant", content: "同期しました", timestamp: 2 },
    ]);
    const capture = vi.fn();
    const run = () => reconcileLearningCandidates(
      { capture } as never,
      [{ id: "mana-accounting", projects: ["back-office"] } as never],
      [session],
      { placementIds: new Set(["mana-accounting"]) },
    );

    run();
    run();

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userMessageId: "u1",
      assistantMessageId: "a1",
      assistantContent: "同期しました",
    }));
    expect(capture.mock.calls[1]?.[0]).toEqual(capture.mock.calls[0]?.[0]);
  });

  it("is disabled by default and only enables explicitly listed placements", () => {
    vi.mocked(registry.getMessages).mockReturnValue([
      { id: "u1", role: "user", content: "記憶して", timestamp: 1 },
    ]);
    const capture = vi.fn();

    const disabled = reconcileLearningCandidates({ capture } as never, undefined, [session]);
    const enabled = reconcileLearningCandidates(
      { capture } as never,
      undefined,
      [session],
      { placementIds: parseLearningReconciliationPlacements(" mana-accounting,other ") },
    );

    expect(disabled.sessionsSkippedPlacement).toBe(1);
    expect(formatLearningReconciliationLog(disabled)).toContain(
      "attempted=0 without_assistant=0 skipped_unscoped=0 skipped_placement=1",
    );
    expect(enabled.turnsAttempted).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
