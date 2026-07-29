import { beforeEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => {
  const state: {
    commandHandler?: (args: {
      command: Record<string, string>;
      ack: ReturnType<typeof vi.fn>;
      respond: ReturnType<typeof vi.fn>;
    }) => Promise<void>;
    messageHandler?: (args: {
      event: Record<string, unknown>;
      context: { teamId?: string };
    }) => Promise<void>;
    reactionHandler?: (args: {
      event: Record<string, any>;
      context: { teamId?: string };
    }) => Promise<void>;
  } = {};
  const client = {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT" })) },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "BOT_REPLY_TS" })),
      update: vi.fn(async () => ({})),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "pilot", is_ext_shared: false } })),
      history: vi.fn(async () => ({ messages: [{ text: "approve this" }] })),
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
    command(name: string, handler: typeof bolt.state.commandHandler) {
      if (name === "/ryoko-develop") bolt.state.commandHandler = handler;
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
    bolt.state.commandHandler = undefined;
  });

  async function setup(options: {
    enabled?: boolean;
    allowedChannels?: string[];
    allowFrom?: string[];
  } = {}) {
    const connector = new SlackConnector({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      allowFrom: options.allowFrom ?? ["U_ALLOWED"],
      ignoreOldMessagesOnBoot: false,
      respondTo: { channel: "mention", engagedThreads: true },
    }, {
      developmentRunnerEnabled: options.enabled ?? true,
      developmentRunnerAllowedChannels: options.allowedChannels ?? ["C_PILOT"],
    });
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();
    await connector.replyMessage({ channel: "C_PILOT", thread: "THREAD_TS" }, "seed");
    vi.clearAllMocks();
    return { connector, handler };
  }

  it("routes the native /ryoko-develop command into the existing development boundary", async () => {
    const { handler } = await setup();
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/ryoko-develop",
        text: "change docs",
        user_id: "U_ALLOWED",
        channel_id: "C_PILOT",
        channel_name: "pilot",
        team_id: "T_WORKSPACE",
      },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      connector: "slack",
      source: "slack",
      sessionKey: "slack:command:C_PILOT:U_ALLOWED",
      channel: "C_PILOT",
      userId: "U_ALLOWED",
      text: "/develop change docs",
      transportMeta: expect.objectContaining({
        team: "T_WORKSPACE",
        channelName: "pilot",
      }),
    }));
  });

  it("rejects unauthorized native development commands before lookups or dispatch", async () => {
    const { handler } = await setup();
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/ryoko-develop",
        text: "change docs",
        user_id: "U_UNAUTHORIZED",
        channel_id: "C_PILOT",
        channel_name: "pilot",
        team_id: "T_WORKSPACE",
      },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(bolt.client.users.info).not.toHaveBeenCalled();
  });

  it("fails closed when allowFrom is empty", async () => {
    const { handler } = await setup({ allowFrom: [] });
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/ryoko-develop",
        text: "change docs",
        user_id: "U_ALLOWED",
        channel_id: "C_PILOT",
        channel_name: "pilot",
        team_id: "T_WORKSPACE",
      },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
  });

  it("rejects native development commands outside the configured pilot channel", async () => {
    const { handler } = await setup();
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/ryoko-develop",
        text: "change docs",
        user_id: "U_ALLOWED",
        channel_id: "C_OTHER",
        channel_name: "other",
        team_id: "T_WORKSPACE",
      },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "Development tasks are not enabled in this channel.",
    });
    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(bolt.client.users.info).not.toHaveBeenCalled();
  });

  it("fails closed when the native development runner is disabled", async () => {
    const { handler } = await setup({ enabled: false });
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/ryoko-develop",
        text: "change docs",
        user_id: "U_ALLOWED",
        channel_id: "C_PILOT",
        channel_name: "pilot",
        team_id: "T_WORKSPACE",
      },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "The development runner is disabled.",
    });
  });

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
      context: { teamId: "T_WORKSPACE" },
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
      context: { teamId: "T_WORKSPACE" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      transportMeta: expect.objectContaining({ team: "T_WORKSPACE" }),
    }));
  });

  it("uses Bolt context.teamId as the reaction workspace boundary", async () => {
    const { handler } = await setup();

    await bolt.state.reactionHandler?.({
      event: {
        type: "reaction_added",
        user: "U_ALLOWED",
        reaction: "white_check_mark",
        item: { type: "message", channel: "C_PILOT", ts: "200.003" },
        event_ts: "200.004",
      },
      context: { teamId: "T_WORKSPACE" },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C_PILOT",
      transportMeta: expect.objectContaining({ team: "T_WORKSPACE" }),
    }));
  });
});
