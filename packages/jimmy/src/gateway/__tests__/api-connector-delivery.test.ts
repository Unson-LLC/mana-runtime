import { describe, expect, it, vi } from "vitest";
import type { Connector, ReplyContext, Session, Target } from "../../shared/types.js";
import { deliverApiSessionResult } from "../api.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "parent-001",
    engine: "claude",
    source: "slack",
    sourceRef: "slack:C123:1700000000.000001",
    connector: "slack",
    sessionKey: "slack:C123:1700000000.000001",
    replyContext: {
      channel: "C123",
      thread: "1700000000.000001",
      messageTs: "1700000000.000001",
    },
    messageId: "1700000000.000001",
    transportMeta: { channelType: "channel", channelExternal: false },
    status: "idle",
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  } as Session;
}

function makeConnector() {
  const replyMessage = vi.fn(async () => "reply-ts");
  const addReaction = vi.fn(async () => {});
  const connector = {
    name: "slack",
    getCapabilities: () => ({
      threading: true,
      messageEdits: true,
      reactions: true,
      attachments: true,
    }),
    reconstructTarget: (replyContext: ReplyContext): Target => ({
      channel: String(replyContext.channel),
      thread: String(replyContext.thread),
      messageTs: String(replyContext.messageTs),
      replyContext,
    }),
    replyMessage,
    addReaction,
  } as unknown as Connector;
  return { connector, replyMessage, addReaction };
}

describe("deliverApiSessionResult", () => {
  it("delivers a callback-resumed parent result to its original Slack thread", async () => {
    const { connector, replyMessage } = makeConnector();
    const session = makeSession();

    await deliverApiSessionResult(
      session,
      "Opus reviewを統合した最終回答です。",
      { connectors: new Map([["slack", connector]]) },
    );

    expect(replyMessage).toHaveBeenCalledOnce();
    expect(replyMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread: "1700000000.000001",
        messageTs: "1700000000.000001",
      }),
      "Opus reviewを統合した最終回答です。",
    );
  });

  it("does not externally deliver ordinary Web UI session results", async () => {
    const { connector, replyMessage } = makeConnector();
    const session = makeSession({
      source: "web",
      connector: "web",
      replyContext: { source: "web" },
    });

    await deliverApiSessionResult(
      session,
      "Web UI only",
      { connectors: new Map([["slack", connector]]) },
    );

    expect(replyMessage).not.toHaveBeenCalled();
  });
});
