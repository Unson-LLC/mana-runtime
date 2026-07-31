import { beforeEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => {
  const state: {
    eventHandlers: Record<string, (args: { event: Record<string, unknown>; context: { teamId?: string } }) => Promise<void>>;
  } = { eventHandlers: {} };
  const client = {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT" })) },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "GREETING_TS" })),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "pilot", is_ext_shared: false } })),
      members: vi.fn(async () => ({ members: ["U1", "U2"], response_metadata: {} })),
    },
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({ user: { id: user, name: user } })),
    },
  };
  return { state, client };
});

vi.mock("@slack/bolt", () => ({
  App: class MockSlackApp {
    client = bolt.client;
    message() {}
    command() {}
    event(name: string, handler: (args: any) => Promise<void>) {
      bolt.state.eventHandlers[name] = handler;
    }
    action() {}
    view() {}
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  },
}));

import { SlackConnector } from "../index.js";
import type { SlackConnectorContext } from "../index.js";

const config = { botToken: "xoxb-test", appToken: "xapp-test" } as any;

async function startConnector(context: SlackConnectorContext = {}): Promise<SlackConnector> {
  const connector = new SlackConnector(config, context);
  await connector.start();
  return connector;
}

beforeEach(() => {
  vi.clearAllMocks();
  bolt.state.eventHandlers = {};
  bolt.client.auth.test.mockImplementation(async () => ({ user_id: "U_BOT" }));
  bolt.client.conversations.members.mockImplementation(async () => ({
    members: ["U1", "U2"],
    response_metadata: {},
  }));
});

describe("channel membership lookup", () => {
  it("caches conversations.members lookups with a TTL and returns member/non-member", async () => {
    const connector = await startConnector();
    await expect(connector.getChannelMembership("C1", "U1")).resolves.toBe("member");
    await expect(connector.getChannelMembership("C1", "U9")).resolves.toBe("non-member");
    // Second verdict came from the cache — only one API round-trip.
    expect(bolt.client.conversations.members).toHaveBeenCalledTimes(1);
  });

  it("follows pagination cursors before answering", async () => {
    const connector = await startConnector();
    bolt.client.conversations.members
      .mockImplementationOnce(async () => ({ members: ["U1"], response_metadata: { next_cursor: "p2" } }))
      .mockImplementationOnce(async () => ({ members: ["U2"], response_metadata: {} }));
    await expect(connector.getChannelMembership("C2", "U2")).resolves.toBe("member");
    expect(bolt.client.conversations.members).toHaveBeenCalledTimes(2);
  });

  it("returns unknown when the members API fails (fail-closed)", async () => {
    const connector = await startConnector();
    bolt.client.conversations.members.mockRejectedValueOnce(new Error("boom"));
    await expect(connector.getChannelMembership("C3", "U1")).resolves.toBe("unknown");
    // A failure is not cached: the next call retries the API.
    bolt.client.conversations.members.mockImplementationOnce(async () => ({
      members: ["U1"],
      response_metadata: {},
    }));
    await expect(connector.getChannelMembership("C3", "U1")).resolves.toBe("member");
  });
});

describe("bot join event (auto-provision trigger)", () => {
  it("invokes onBotJoinedChannel only when the bot itself joins", async () => {
    const onBotJoinedChannel = vi.fn(async () => undefined);
    await startConnector({ onBotJoinedChannel });
    const handler = bolt.state.eventHandlers["member_joined_channel"];
    expect(handler).toBeDefined();

    // Another user joining must never trigger a config write.
    await handler({ event: { user: "U_HUMAN", channel: "C1", inviter: "U42" }, context: { teamId: "T1" } });
    expect(onBotJoinedChannel).not.toHaveBeenCalled();

    await handler({ event: { user: "U_BOT", channel: "C1", inviter: "U42", team: "T1" }, context: { teamId: "T1" } });
    expect(onBotJoinedChannel).toHaveBeenCalledWith({
      channelId: "C1",
      workspaceId: "T1",
      inviterUserId: "U42",
    });
    // No greeting returned → nothing posted.
    expect(bolt.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("posts the returned greeting to the channel exactly once", async () => {
    const onBotJoinedChannel = vi.fn(async () => "hello channel");
    await startConnector({ onBotJoinedChannel });
    await bolt.state.eventHandlers["member_joined_channel"]({
      event: { user: "U_BOT", channel: "C1", inviter: "U42" },
      context: { teamId: "T1" },
    });
    expect(bolt.client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", text: "hello channel" }),
    );
  });

  it("swallows callback failures without crashing the event loop", async () => {
    const onBotJoinedChannel = vi.fn(async () => {
      throw new Error("provision failed");
    });
    await startConnector({ onBotJoinedChannel });
    await expect(
      bolt.state.eventHandlers["member_joined_channel"]({
        event: { user: "U_BOT", channel: "C1" },
        context: { teamId: "T1" },
      }),
    ).resolves.toBeUndefined();
    expect(bolt.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe("bot leave events (placement disable trigger)", () => {
  it("invokes onBotLeftChannel on channel_left and group_left", async () => {
    const onBotLeftChannel = vi.fn();
    await startConnector({ onBotLeftChannel });
    for (const name of ["channel_left", "group_left"]) {
      const handler = bolt.state.eventHandlers[name];
      expect(handler, name).toBeDefined();
      await handler({ event: { channel: "C1" }, context: { teamId: "T1" } });
    }
    expect(onBotLeftChannel).toHaveBeenCalledTimes(2);
    expect(onBotLeftChannel).toHaveBeenCalledWith({ channelId: "C1", workspaceId: "T1" });
  });
});
