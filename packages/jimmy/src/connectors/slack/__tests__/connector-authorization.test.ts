import { beforeEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => {
  const state: {
    messageHandler?: (args: { event: Record<string, unknown> }) => Promise<void>;
    reactionHandler?: (args: { event: Record<string, any> }) => Promise<void>;
  } = {};
  const client = {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT" })) },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "BOT_REPLY_TS" })),
      update: vi.fn(async () => ({})),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "pilot", is_ext_shared: false } })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        user: { id: user, name: user },
      })),
    },
    reactions: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
    assistant: {
      threads: { setStatus: vi.fn(async () => ({})) },
    },
    apiCall: vi.fn(async () => ({})),
  };
  return { state, client };
});

vi.mock("@slack/bolt", () => ({
  App: class MockSlackApp {
    client = bolt.client;
    message(handler: typeof bolt.state.messageHandler) {
      bolt.state.messageHandler = handler;
    }
    event(name: string, handler: typeof bolt.state.reactionHandler) {
      if (name === "reaction_added") bolt.state.reactionHandler = handler;
    }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  },
}));

import { SlackConnector } from "../index.js";

describe("SlackConnector authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bolt.state.messageHandler = undefined;
    bolt.state.reactionHandler = undefined;
  });

  async function setup() {
    const connector = new SlackConnector({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      allowFrom: ["U_ALLOWED"],
      ignoreOldMessagesOnBoot: false,
      respondTo: { channel: "mention", engagedThreads: true },
    });
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();
    await connector.replyMessage({ channel: "C_PILOT", thread: "THREAD_TS" }, "seed");
    vi.clearAllMocks();
    return { connector, handler };
  }

  it("drops an unauthorized follow-up before an engaged-thread exception", async () => {
    const { handler } = await setup();

    await bolt.state.messageHandler?.({
      event: {
        user: "U_UNAUTHORIZED",
        channel: "C_PILOT",
        channel_type: "channel",
        thread_ts: "THREAD_TS",
        ts: "200.001",
        text: "continue",
      },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(bolt.client.chat.postMessage).not.toHaveBeenCalled();
    expect(bolt.client.assistant.threads.setStatus).not.toHaveBeenCalled();
    expect(bolt.client.apiCall).not.toHaveBeenCalled();
    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(bolt.client.conversations.replies).not.toHaveBeenCalled();
    expect(bolt.client.users.info).not.toHaveBeenCalled();
  });

  it("allows the authorized user to continue an engaged thread without a mention", async () => {
    const { handler } = await setup();

    await bolt.state.messageHandler?.({
      event: {
        user: "U_ALLOWED",
        channel: "C_PILOT",
        channel_type: "channel",
        thread_ts: "THREAD_TS",
        ts: "200.002",
        text: "continue",
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
