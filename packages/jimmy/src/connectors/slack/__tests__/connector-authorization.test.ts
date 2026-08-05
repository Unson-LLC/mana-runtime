import { beforeEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => {
  const state: {
    commandHandler?: (args: {
      command: Record<string, string>;
      ack: ReturnType<typeof vi.fn>;
      respond: ReturnType<typeof vi.fn>;
    }) => Promise<void>;
    registeredCommands: string[];
    messageHandler?: (args: {
      event: Record<string, unknown>;
      context: { teamId?: string };
    }) => Promise<void>;
    reactionHandler?: (args: {
      event: Record<string, any>;
      context: { teamId?: string };
    }) => Promise<void>;
    eventHandlers: Record<string, (args: any) => Promise<void>>;
    actionHandlers: Record<string, (args: any) => Promise<void>>;
    viewHandlers: Record<string, (args: any) => Promise<void>>;
    socketHandlers: Record<string, (...args: unknown[]) => void>;
    appErrorHandler?: (error: Error) => Promise<void>;
  } = {
    registeredCommands: [],
    actionHandlers: {},
    viewHandlers: {},
    eventHandlers: {},
    socketHandlers: {},
  };
  const client = {
    auth: { test: vi.fn(async () => ({ user_id: "U_BOT", team_id: "T_WORKSPACE" })) },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "BOT_REPLY_TS" })),
      update: vi.fn(async () => ({})),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "pilot", is_ext_shared: false } })),
      history: vi.fn(async () => ({ messages: [{ text: "approve this" }] })),
      replies: vi.fn(async (): Promise<{ messages: Array<{ text: string }> }> => ({ messages: [] })),
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
    views: { publish: vi.fn(async () => ({})) },
    apiCall: vi.fn(async () => ({})),
  };
  return { state, client };
});

const log = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock("../../../shared/logger.js", () => ({ logger: log }));

vi.mock("@slack/bolt", () => ({
  SocketModeReceiver: class MockSocketModeReceiver {
    client = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        bolt.state.socketHandlers[event] = handler;
      },
    };
  },
  App: class MockSlackApp {
    client = bolt.client;
    message(handler: typeof bolt.state.messageHandler) {
      bolt.state.messageHandler = handler;
    }
    command(name: string, handler: typeof bolt.state.commandHandler) {
      bolt.state.registeredCommands.push(name);
      // Both names share one handler in the connector; keep the last one.
      bolt.state.commandHandler = handler;
    }
    event(name: string, handler: typeof bolt.state.reactionHandler) {
      if (name === "reaction_added") bolt.state.reactionHandler = handler;
      bolt.state.eventHandlers[name] = handler as any;
    }
    action(actionId: string, handler: (args: any) => Promise<void>) {
      bolt.state.actionHandlers[actionId] = handler;
    }
    view(callbackId: string, handler: (args: any) => Promise<void>) {
      bolt.state.viewHandlers[callbackId] = handler;
    }
    error(handler: (error: Error) => Promise<void>) {
      bolt.state.appErrorHandler = handler;
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
    bolt.state.registeredCommands.length = 0;
    bolt.state.actionHandlers = {};
    bolt.state.viewHandlers = {};
    bolt.state.eventHandlers = {};
    bolt.state.socketHandlers = {};
    bolt.state.appErrorHandler = undefined;
  });

  async function setup(options: {
    enabled?: boolean;
    allowedChannels?: string[];
    allowFrom?: string[];
    settingsHome?: { enabled?: boolean; webBaseUrl?: string };
    respondToIm?: "always" | "mention" | "never";
    ignoreOldMessagesOnBoot?: boolean;
    registerHandler?: boolean;
  } = {}) {
    const connector = new SlackConnector({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      allowFrom: options.allowFrom ?? ["U_ALLOWED"],
      ignoreOldMessagesOnBoot: options.ignoreOldMessagesOnBoot ?? false,
      settingsHome: options.settingsHome,
      respondTo: { im: options.respondToIm, channel: "mention", engagedThreads: true },
    }, {
      developmentRunnerEnabled: options.enabled ?? true,
      developmentRunnerAllowedChannels: options.allowedChannels ?? ["C_PILOT"],
    });
    const handler = vi.fn();
    if (options.registerHandler !== false) connector.onMessage(handler);
    await connector.start();
    await connector.replyMessage({ channel: "C_PILOT", thread: "THREAD_TS" }, "seed");
    vi.clearAllMocks();
    return { connector, handler };
  }

  it("redacts startup auth.test errors while staying running and fail-closed", async () => {
    const secret = "xoxb-STARTUP-AUTH-SECRET-SENTINEL";
    const authError = new Error(`startup auth failed: ${secret}`);
    bolt.client.auth.test.mockRejectedValueOnce(authError);
    const connector = new SlackConnector({
      id: "slack-primary",
      appToken: "xapp-test",
      botToken: "xoxb-test",
      allowFrom: ["U_ALLOWED"],
      ignoreOldMessagesOnBoot: false,
      respondTo: { channel: "mention", engagedThreads: true },
    });

    await expect(connector.start()).resolves.toBeUndefined();

    const logged = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
      log.debug.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(authError.message);
    expect(logged).not.toContain(authError.stack);
    expect(log.warn).toHaveBeenCalledWith(
      "[slack] runtime auth_test_failed code=slack_auth_test_failed connector=slack-primary",
    );
    expect(connector.getHealth()).toMatchObject({ status: "running" });
    expect(connector.getSettingsTopologySnapshot()).not.toHaveProperty("workspaceId");

    await connector.refreshSettingsTopologyProbe([
      { channelId: "C_OTHER", workspaceId: "T_OTHER" },
    ]);
    expect(connector.getSettingsTopologySnapshot().channels.C_OTHER).toMatchObject({
      status: "unconfirmed",
      code: "workspace_identity_unavailable",
    });
    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
  });

  it("degrades and invalidates topology on Socket Mode failure, then recovers on reconnect", async () => {
    const { connector } = await setup();
    bolt.client.conversations.info.mockResolvedValueOnce({
      channel: { id: "C_PILOT", name: "pilot", is_member: true, is_archived: false },
    } as any);
    await connector.refreshSettingsTopologyProbe([{ channelId: "C_PILOT" }]);
    expect(connector.getSettingsTopologySnapshot()).toMatchObject({
      health: "healthy",
      channels: { C_PILOT: { status: "verified" } },
    });

    bolt.state.socketHandlers.reconnecting?.();
    expect(connector.getSettingsTopologySnapshot()).toMatchObject({
      health: "degraded",
      channels: {},
    });
    expect(connector.getHealth()).toMatchObject({
      status: "error",
      detail: "slack_runtime_unavailable",
    });

    bolt.client.conversations.info.mockResolvedValueOnce({
      channel: { id: "C_PILOT", name: "pilot", is_member: true, is_archived: false },
    } as any);
    bolt.state.socketHandlers.connected?.();
    await vi.waitFor(() => expect(connector.getSettingsTopologySnapshot()).toMatchObject({
      health: "healthy",
      channels: { C_PILOT: { status: "verified" } },
    }));
  });

  it("keeps transport health intact and redacts Bolt handler errors from logs", async () => {
    const { connector } = await setup();
    const secret = "xoxb-SECRET-RUNTIME-SENTINEL";

    await bolt.state.appErrorHandler?.(new Error(secret));

    expect(connector.getSettingsTopologySnapshot().health).toBe("healthy");
    expect(connector.getHealth()).toMatchObject({ status: "running" });
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
    expect(logged).not.toContain(secret);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("code=slack_handler_failed"));
  });

  it("never logs raw Socket Mode error details", async () => {
    await setup();
    const secret = "xapp-SECRET-SOCKET-SENTINEL";

    bolt.state.socketHandlers.error?.(new Error(secret));

    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
    expect(logged).not.toContain(secret);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("code=slack_runtime_unavailable"));
  });

  it("publishes a fail-closed App Home settings entry only for an explicitly allowlisted user", async () => {
    await setup({ settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" } });

    await bolt.state.eventHandlers.app_home_opened?.({ event: { user: "U_ALLOWED" } });
    expect(bolt.client.views.publish).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "U_ALLOWED",
      view: expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "actions",
            elements: expect.arrayContaining([
              expect.objectContaining({ type: "button", url: "https://mana.example.com/settings/topology" }),
            ]),
          }),
        ]),
      }),
    }));

    vi.clearAllMocks();
    await bolt.state.eventHandlers.app_home_opened?.({ event: { user: "U_OTHER" } });
    expect(bolt.client.views.publish).not.toHaveBeenCalled();
  });

  it("does not publish settings credentials embedded in the configured URL", async () => {
    await setup({
      settingsHome: { enabled: true, webBaseUrl: "https://user:pass@mana.example.com" },
      respondToIm: "never",
      registerHandler: false,
    });

    await bolt.state.eventHandlers.app_home_opened?.({ event: { user: "U_ALLOWED" } });
    await bolt.state.messageHandler?.({
      event: { user: "U_ALLOWED", channel: "D1", channel_type: "im", ts: `${Date.now() / 1000}`, text: "設定" },
      context: { teamId: "T_WORKSPACE" },
    });

    expect(bolt.client.views.publish).toHaveBeenCalledOnce();
    expect(bolt.client.chat.postMessage).toHaveBeenCalledOnce();
    const published = JSON.stringify(bolt.client.views.publish.mock.calls);
    const replied = JSON.stringify(bolt.client.chat.postMessage.mock.calls);
    expect(published).not.toContain("user:pass");
    expect(replied).not.toContain("user:pass");
    expect(published).not.toContain("mana.example.com");
    expect(replied).not.toContain("mana.example.com");
  });

  it("handles an exact settings DM in the same thread before respondTo and without a normal handler", async () => {
    await setup({
      settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" },
      respondToIm: "never",
      registerHandler: false,
    });

    await bolt.state.messageHandler?.({
      event: {
        user: "U_ALLOWED",
        channel: "D1",
        channel_type: "im",
        thread_ts: "THREAD_TS",
        ts: `${Date.now() / 1000}`,
        text: "  ルーティング  ",
      },
      context: { teamId: "T_WORKSPACE" },
    });

    expect(bolt.client.chat.postMessage).toHaveBeenCalledOnce();
    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "D1",
      thread_ts: "THREAD_TS",
      blocks: expect.any(Array),
    }));
    expect(JSON.stringify(bolt.client.chat.postMessage.mock.calls)).toContain("https://mana.example.com/settings/topology");
  });

  it("does not treat a partial phrase or a replayed old DM as a settings shortcut", async () => {
    const { handler } = await setup({
      settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" },
      respondToIm: "never",
      ignoreOldMessagesOnBoot: true,
    });

    await bolt.state.messageHandler?.({
      event: { user: "U_ALLOWED", channel: "D1", channel_type: "im", ts: "1.0", text: "ルーティング" },
      context: { teamId: "T_WORKSPACE" },
    });
    await bolt.state.messageHandler?.({
      event: { user: "U_ALLOWED", channel: "D1", channel_type: "im", ts: `${Date.now() / 1000}`, text: "ルーティングを教えて" },
      context: { teamId: "T_WORKSPACE" },
    });

    expect(bolt.client.chat.postMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    await bolt.state.messageHandler?.({
      event: { user: "U_ALLOWED", channel: "D1", channel_type: "im", ts: `${(Date.now() / 1000) + 1}`, text: "ルーティング" },
      context: { teamId: "T_WORKSPACE" },
    });

    expect(bolt.client.chat.postMessage).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("classifies bounded Slack topology probes without exposing Slack errors", async () => {
    const { connector } = await setup();
    bolt.client.conversations.info
      .mockResolvedValueOnce({ channel: { name: "ready", is_member: true, is_archived: false } } as any)
      .mockResolvedValueOnce({ channel: { name: "closed", is_member: true, is_archived: true } } as any)
      .mockResolvedValueOnce({ channel: { name: "outside", is_member: false, is_archived: false } } as any)
      .mockRejectedValueOnce({ data: { error: "missing_scope" } });

    await connector.refreshSettingsTopologyProbe([
      { channelId: "C_READY", workspaceId: "T_WORKSPACE" },
      { channelId: "C_ARCHIVED", workspaceId: "T_WORKSPACE" },
      { channelId: "C_OUTSIDE", workspaceId: "T_WORKSPACE" },
      { channelId: "C_DENIED", workspaceId: "T_WORKSPACE" },
    ]);

    const snapshot = connector.getSettingsTopologySnapshot();
    expect(snapshot.channels.C_READY).toMatchObject({ status: "verified", code: "channel_ready_by_static_checks", name: "ready" });
    expect(snapshot.channels.C_ARCHIVED).toMatchObject({ status: "error", code: "channel_archived", name: "closed" });
    expect(snapshot.channels.C_OUTSIDE).toMatchObject({ status: "error", code: "bot_not_member", name: "outside" });
    expect(snapshot.channels.C_DENIED).toMatchObject({ status: "error", code: "permission_denied" });
    expect(snapshot).not.toHaveProperty("error");
  });

  it("rejects a declared workspace mismatch without calling Slack", async () => {
    const { connector } = await setup();
    await connector.refreshSettingsTopologyProbe([{ channelId: "C_OTHER", workspaceId: "T_OTHER" }]);

    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(connector.getSettingsTopologySnapshot().channels.C_OTHER).toMatchObject({
      status: "error",
      code: "workspace_mismatch",
    });
  });

  it("leaves a declared cross-workspace target unconfirmed when auth.test has no workspace identity", async () => {
    bolt.client.auth.test.mockResolvedValueOnce({ user_id: "U_BOT" } as any);
    const { connector } = await setup();
    await connector.refreshSettingsTopologyProbe([{ channelId: "C_OTHER", workspaceId: "T_OTHER" }]);

    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(connector.getSettingsTopologySnapshot().channels.C_OTHER).toMatchObject({
      status: "unconfirmed",
      code: "workspace_identity_unavailable",
    });
  });

  it("does not let an older probe overwrite a newer generation", async () => {
    const { connector } = await setup();
    let resolveOld!: (value: any) => void;
    const oldProbe = new Promise((resolve) => { resolveOld = resolve });
    bolt.client.conversations.info
      .mockImplementationOnce(() => oldProbe as any)
      .mockResolvedValueOnce({ channel: { name: "new", is_member: true, is_archived: false } } as any);

    const pendingOld = connector.refreshSettingsTopologyProbe([{ channelId: "C_OLD", workspaceId: "T_WORKSPACE" }]);
    connector.invalidateSettingsTopologyProbe();
    await connector.refreshSettingsTopologyProbe([{ channelId: "C_NEW", workspaceId: "T_WORKSPACE" }]);
    resolveOld({ channel: { name: "old", is_member: true, is_archived: false } });
    await pendingOld;

    const snapshot = connector.getSettingsTopologySnapshot();
    expect(snapshot.channels.C_NEW).toMatchObject({ name: "new", status: "verified" });
    expect(snapshot.channels.C_OLD).toBeUndefined();
  });

  it("turns a non-resolving Slack probe into a bounded unconfirmed result", async () => {
    const { connector } = await setup();
    vi.useFakeTimers();
    try {
      bolt.client.conversations.info.mockImplementationOnce(() => new Promise(() => {}) as any);
      const pending = connector.refreshSettingsTopologyProbe([{ channelId: "C_TIMEOUT", workspaceId: "T_WORKSPACE" }]);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(connector.getSettingsTopologySnapshot().channels.C_TIMEOUT).toMatchObject({
        status: "unconfirmed",
        code: "slack_probe_failed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers /vibepro as the primary command and keeps /ryoko-develop as a legacy alias", async () => {
    await setup();
    expect(bolt.state.registeredCommands).toEqual(["/vibepro", "/ryoko-develop"]);
  });

  it("routes the native /vibepro command into the existing development boundary", async () => {
    const { handler } = await setup();
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await bolt.state.commandHandler?.({
      command: {
        command: "/vibepro",
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
      text: "/develop change docs",
      sessionKey: "slack:command:C_PILOT:U_ALLOWED",
    }));
  });

  it("routes the legacy /ryoko-develop command into the existing development boundary", async () => {
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

  it("postDevelopmentNeedsInput posts a Block Kit gate card when the runner is enabled and gates are present", async () => {
    const { connector } = await setup({ enabled: true, allowFrom: ["U_ALLOWED"] });

    await connector.postDevelopmentNeedsInput(
      { channel: "C_PILOT", thread: "THREAD_TS" },
      {
        storyId: "story-x",
        summary: "gates remain",
        gates: [{ severity: "critical", text: "missing threat model" }],
        commits: { count: 1, subjects: ["feat: x"] },
      },
    );

    expect(bolt.client.apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      channel: "C_PILOT",
      thread_ts: "THREAD_TS",
      blocks: expect.any(Array),
    }));
  });

  it("postDevelopmentNeedsInput falls back to plain text when there are no gates", async () => {
    const { connector } = await setup({ enabled: true, allowFrom: ["U_ALLOWED"] });

    await connector.postDevelopmentNeedsInput(
      { channel: "C_PILOT", thread: "THREAD_TS" },
      { storyId: "story-x", summary: "agent crashed before shipping" },
    );

    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C_PILOT",
      thread_ts: "THREAD_TS",
      text: expect.stringContaining("agent crashed before shipping"),
    }));
    expect(bolt.client.apiCall).not.toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({ blocks: expect.anything() }));
  });

  it("postDevelopmentNeedsInput falls back to plain text when the development runner is disabled", async () => {
    const { connector } = await setup({ enabled: false });

    await connector.postDevelopmentNeedsInput(
      { channel: "C_PILOT", thread: "THREAD_TS" },
      { storyId: "story-x", summary: "gates remain", gates: [{ severity: "critical", text: "x" }] },
    );

    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C_PILOT",
      thread_ts: "THREAD_TS",
      text: expect.stringContaining("gates remain"),
    }));
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
    bolt.client.conversations.replies.mockResolvedValueOnce({
      messages: [{ text: "the original request" }],
    });

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
      text: "[Slack thread root]\nthe original request\n\ncontinue",
      transportMeta: expect.objectContaining({ team: "T_WORKSPACE" }),
    }));
  });

  it("does not perform any side effect for a reaction while reaction turns are disabled", async () => {
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

    expect(handler).not.toHaveBeenCalled();
    expect(bolt.client.reactions.add).not.toHaveBeenCalled();
    expect(bolt.client.conversations.history).not.toHaveBeenCalled();
    expect(bolt.client.conversations.replies).not.toHaveBeenCalled();
    expect(bolt.client.conversations.info).not.toHaveBeenCalled();
    expect(bolt.client.users.info).not.toHaveBeenCalled();
  });
});
