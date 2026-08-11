import {
  isReplyEligible,
  processReplyEvent,
  ReplyPipelineError,
  type ReplyPipelineOptions,
} from "../reply-pipeline.js";
import type { SlackQueueEvent } from "../types.js";

class MemoryFs {
  readonly files = new Map<string, string>();

  async mkdir(): Promise<void> {}

  async ls(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return value;
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
}

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvReply123",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1786454600.000001",
    messageTs: "1786454653.386769",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> メンションしてみる\u0000",
    receivedAt: "2026-08-11T13:24:13.000Z",
    ...overrides,
  };
}

function harness(overrides: Partial<ReplyPipelineOptions> = {}) {
  const sandbox = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({
      success: true,
      stdout: "はい、Cloudflare上の八雲まなです。\n",
      stderr: "",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: true,
    ts: "1786455000.000001",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const options: ReplyPipelineOptions = {
    expectedWorkspaceId: "T_TECHKNIGHT",
    allowedChannelId: "C_MANA_TEST",
    slackBotToken: "xoxb-worker-secret",
    oauthConfigured: true,
    createSandbox: vi.fn(() => sandbox),
    fetch: fetchMock,
    now: () => "2026-08-11T13:30:00.000Z",
    ...overrides,
  };
  return { options, sandbox, fetchMock };
}

describe("TechKnight Slack reply pipeline", () => {
  it("posts a Claude response to the originating Slack thread", async () => {
    const fs = new MemoryFs();
    const { options, sandbox, fetchMock } = harness();

    await expect(processReplyEvent(fs, event(), options)).resolves.toEqual({
      outcome: "replied",
      responseTs: "1786455000.000001",
    });

    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    const prompt = sandbox.writeFile.mock.calls[0][1] as string;
    expect(prompt).toContain("メンションしてみる");
    expect(prompt).not.toContain("<@U_BOT>");
    expect(prompt).not.toContain("\u0000");
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/mana-slack-prompt.txt"),
      {
        timeout: 120_000,
        env: {
          IS_SANDBOX: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected",
        },
      },
    );

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toEqual({
      authorization: "Bearer xoxb-worker-secret",
      "content-type": "application/json; charset=utf-8",
    });
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      channel: "C_MANA_TEST",
      thread_ts: "1786454600.000001",
      text: "はい、Cloudflare上の八雲まなです。",
    });
    expect(body.client_msg_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("does not repeat a completed Slack reply", async () => {
    const fs = new MemoryFs();
    const { options, sandbox, fetchMock } = harness();

    await processReplyEvent(fs, event(), options);
    await expect(processReplyEvent(fs, event(), options)).resolves.toEqual({
      outcome: "already_completed",
    });

    expect(sandbox.exec).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["another workspace", { workspaceId: "T_OTHER" }],
    ["another channel", { channelId: "C_OTHER" }],
    ["another event", { eventType: "message" }],
    ["a bot id", { botId: "B_BOT" }],
    ["a bot subtype", { subtype: "bot_message" }],
    ["no user", { userId: undefined }],
  ])("rejects events outside the TechKnight reply boundary: %s", async (_name, change) => {
    const fs = new MemoryFs();
    const { options, sandbox, fetchMock } = harness();
    const input = event(change);

    expect(isReplyEligible(input, options)).toBe(false);
    await expect(processReplyEvent(fs, input, options)).resolves.toEqual({ outcome: "ignored" });
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps worker secrets out of sandbox input and completion records", async () => {
    const fs = new MemoryFs();
    const { options, sandbox } = harness();
    await processReplyEvent(fs, event(), options);

    expect(JSON.stringify(sandbox.writeFile.mock.calls)).not.toContain("xoxb-worker-secret");
    expect(JSON.stringify(sandbox.exec.mock.calls)).not.toContain("xoxb-worker-secret");
    expect([...fs.files.values()].join("\n")).not.toContain("xoxb-worker-secret");
    expect([...fs.files.values()].join("\n")).not.toContain("proxy-injected");
  });

  it("leaves the event retryable when Claude fails", async () => {
    const fs = new MemoryFs();
    const sandbox = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ success: false, stdout: "", stderr: "failed" }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const { options, fetchMock } = harness({ createSandbox: () => sandbox });

    await expect(processReplyEvent(fs, event(), options)).rejects.toEqual(
      expect.objectContaining<Partial<ReplyPipelineError>>({ code: "claude_execution_failed" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...fs.files.keys()].some((path) => path.startsWith("/replies/"))).toBe(false);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("leaves the event retryable when Slack rejects the post", async () => {
    const fs = new MemoryFs();
    const { options } = harness({
      fetch: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ ok: false, error: "missing_scope" }),
        { status: 200 },
      )),
    });

    await expect(processReplyEvent(fs, event(), options)).rejects.toEqual(
      expect.objectContaining<Partial<ReplyPipelineError>>({ code: "slack_post_failed" }),
    );
    expect([...fs.files.keys()].some((path) => path.startsWith("/replies/"))).toBe(false);
  });
});
