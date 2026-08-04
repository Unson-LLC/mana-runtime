import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types.js";
import { selectSharedConversationSessions } from "../registry.js";

function session(
  id: string,
  workspaceId: string,
  channelId: string,
  placementId = "ops",
): Session {
  return {
    id,
    engine: "claude",
    engineSessionId: null,
    source: "slack",
    sourceRef: channelId,
    connector: "slack",
    sessionKey: `slack:${workspaceId}:${channelId}:${id}`,
    replyContext: { channel: channelId },
    messageId: null,
    transportMeta: { team: workspaceId, placementId },
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    lastActivity: "2026-08-04T00:00:00.000Z",
    lastError: null,
  } as Session;
}

describe("shared conversation scope", () => {
  it("shares only the same connector, workspace, channel and placement", () => {
    const selected = selectSharedConversationSessions({
      connector: "slack",
      workspaceId: "T1",
      channelId: "C1",
      placementId: "ops",
      excludeSessionId: "current",
    }, [
      session("same", "T1", "C1"),
      session("other-workspace", "T2", "C1"),
      session("other-channel", "T1", "C2"),
      session("other-placement", "T1", "C1", "sales"),
      session("current", "T1", "C1"),
    ]);

    expect(selected.map(({ id }) => id)).toEqual(["same"]);
  });

  it("fails closed when the workspace identity is unknown", () => {
    expect(selectSharedConversationSessions({
      connector: "slack",
      channelId: "C1",
    }, [session("candidate", "T1", "C1")])).toEqual([]);
  });

  it("does not mix placed sessions into an unplaced channel scope", () => {
    const unplaced = session("unplaced", "T1", "C1") as Session;
    unplaced.transportMeta = { team: "T1" };
    expect(selectSharedConversationSessions({
      connector: "slack",
      workspaceId: "T1",
      channelId: "C1",
    }, [unplaced, session("placed", "T1", "C1", "ops")]).map(({ id }) => id))
      .toEqual(["unplaced"]);
  });

  it("uses the stable transport channel for web sessions", () => {
    const webSession = session("web-other-thread", "local-web", "unused") as Session;
    webSession.source = "web";
    webSession.connector = "web";
    webSession.replyContext = { source: "web" };
    webSession.transportMeta = {
      workspaceId: "local-web",
      channelId: "web:ops",
      placementId: "ops",
    };

    expect(selectSharedConversationSessions({
      connector: "web",
      workspaceId: "local-web",
      channelId: "web:ops",
      placementId: "ops",
    }, [webSession]).map(({ id }) => id)).toEqual(["web-other-thread"]);
  });
});
