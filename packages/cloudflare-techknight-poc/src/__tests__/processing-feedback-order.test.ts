import { describe, expect, it, vi } from "vitest";
import { resolveClaudeRuntimeConfig } from "../claude-runtime-config.js";
import {
  processMeetingTaskEvent,
  type MeetingTaskPipelineOptions,
} from "../meeting-task-pipeline.js";
import {
  processReplyEvent,
  type ReplyPipelineOptions,
} from "../reply-pipeline.js";
import { hydrateSlackQueueEventThreadContext } from "../slack-thread-context.js";
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
    tenantId: "unson",
    eventId: "EvFeedbackOrder",
    workspaceId: "T_UNSON",
    channelId: "C_BACK_OFFICE",
    threadTs: "1786506654.101899",
    messageTs: "1786528714.062199",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> このスレッド読めない？",
    receivedAt: "2026-08-12T18:30:00.000Z",
    ...overrides,
  };
}

function feedbackFetch(order: string[]): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("reactions.add")) order.push("reaction:add");
    if (url.includes("reactions.remove")) order.push("reaction:remove");
    if (url.includes("assistant.threads.setStatus")) {
      const body = JSON.parse(String(init?.body));
      order.push(body.status ? "status:start" : "status:clear");
    }
    if (url.includes("chat.postMessage")) order.push("reply");
    return new Response(JSON.stringify({ ok: true, ts: "1786529000.000001" }), {
      status: 200,
    });
  }) as typeof fetch;
}

const judgmentLine = "🧠 判断参照: 「質問」を参照 → 質問として回答 ✓";
const brainbaseLine = "📚 Brainbase参照先: 「質問」→ Brainbase呼び出し0回 ✓";
const receiptPrefix = "__MANA_JUDGMENT_RECEIPT_V1__:";

function auditedReplyStream(reply = "スレッドの内容を確認しました。"): string {
  const receipt = (hook_event_name: "UserPromptSubmit" | "Stop") => ({
    type: "system",
    subtype: "hook_response",
    hook_event: hook_event_name,
    exit_code: 0,
    outcome: "success",
    session_id: "session-1",
    stdout: JSON.stringify({
      systemMessage: [
        hook_event_name === "UserPromptSubmit" ? judgmentLine : brainbaseLine,
        `${receiptPrefix}${JSON.stringify({
        schema_version: "mana_judgment_hook_receipt.v1",
        hook_event_name,
        session_id: "session-1",
        turn_id: "turn-1",
        ...(hook_event_name === "UserPromptSubmit" ? {
          host_receipt_id: "receipt-route-1",
          route_resolution_sha256: "a".repeat(64),
        } : {}),
        })}`,
      ].join("\n"),
    }),
  });
  return [
    { type: "system", subtype: "init", session_id: "session-1" },
    receipt("UserPromptSubmit"),
    receipt("Stop"),
    { type: "result", session_id: "session-1", result: [judgmentLine, brainbaseLine, reply].join("\n") },
  ].map((entry) => JSON.stringify(entry)).join("\n");
}

function sandbox() {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({
      success: true,
      stdout: auditedReplyStream(),
      stderr: "",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function replyOptions(
  fetchImpl: typeof fetch,
  createSandbox: ReturnType<typeof sandbox>,
  hydrateThreadContext?: (input: SlackQueueEvent) => Promise<SlackQueueEvent>,
): ReplyPipelineOptions {
  return {
    expectedTenantId: "unson",
    expectedWorkspaceId: "T_UNSON",
    allowedChannelId: "C_BACK_OFFICE",
    slackBotToken: "xoxb-secret",
    oauthConfigured: true,
    claudeRuntime: resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    }),
    createSandbox: () => createSandbox,
    fetch: fetchImpl,
    hydrateThreadContext,
  };
}

function meetingOptions(
  fetchImpl: typeof fetch,
  createSandbox: ReturnType<typeof sandbox>,
  hydrateThreadContext?: (input: SlackQueueEvent) => Promise<SlackQueueEvent>,
): MeetingTaskPipelineOptions {
  return {
    binding: {
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
      projectCodes: ["back-office"],
    },
    brainbaseApiBaseUrl: "https://brainbase.example",
    brainbaseTaskToken: "brainbase-secret",
    slackBotToken: "xoxb-secret",
    oauthConfigured: true,
    claudeRuntime: resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    }),
    createSandbox: () => createSandbox,
    fetch: fetchImpl,
    hydrateThreadContext,
  };
}

describe("processing feedback and thread hydration orchestration", () => {
  it.each([
    ["reply", processReplyEvent, replyOptions],
    ["meeting task", processMeetingTaskEvent, meetingOptions],
  ] as const)(
    "starts %s feedback before hydration and cleans it up when history fails",
    async (_name, process, optionsFor) => {
      const fs = new MemoryFs();
      const order: string[] = [];
      const fetchMock = feedbackFetch(order);
      const runtime = sandbox();
      const hydrate = vi.fn(async () => {
        order.push("history");
        throw new Error("history unavailable");
      });

      await expect(
        process(fs, event(), optionsFor(fetchMock, runtime, hydrate) as never),
      ).rejects.toThrow("history unavailable");

      expect(order).toEqual([
        "reaction:add",
        "status:start",
        "history",
        "status:clear",
        "reaction:remove",
      ]);
      expect(hydrate).toHaveBeenCalledOnce();
      expect(runtime.exec).not.toHaveBeenCalled();
    },
  );

  it("does not request history for a root mention and shows feedback only once", async () => {
    const fs = new MemoryFs();
    const order: string[] = [];
    const fetchMock = feedbackFetch(order);
    const historyFetch = vi.fn();
    const runtime = sandbox();
    const root = event({ threadTs: "1786506654.101899", messageTs: "1786506654.101899" });
    const hydrate = vi.fn((input: SlackQueueEvent) => (
      hydrateSlackQueueEventThreadContext(input, {
        botToken: "xoxb-secret",
        fetch: historyFetch,
      })
    ));

    await expect(
      processReplyEvent(fs, root, replyOptions(fetchMock, runtime, hydrate)),
    ).resolves.toMatchObject({ outcome: "replied" });

    expect(historyFetch).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "reaction:add",
      "status:start",
      "reply",
      "status:clear",
      "reaction:remove",
    ]);
  });

  it("does not show feedback or hydrate an ignored reply event", async () => {
    const fs = new MemoryFs();
    const fetchMock = feedbackFetch([]);
    const hydrate = vi.fn();
    const runtime = sandbox();

    await expect(processReplyEvent(
      fs,
      event({ eventType: "message" }),
      replyOptions(fetchMock, runtime, hydrate),
    )).resolves.toEqual({ outcome: "ignored" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it.each([
    ["reply", processReplyEvent, replyOptions],
    ["meeting task", processMeetingTaskEvent, meetingOptions],
  ] as const)(
    "does not show feedback or hydrate a completed %s event",
    async (_name, process, optionsFor) => {
      const fs = new MemoryFs();
      fs.files.set(`/replies/${event().eventId}.json`, "{}");
      const fetchMock = feedbackFetch([]);
      const hydrate = vi.fn();
      const runtime = sandbox();

      await process(fs, event(), optionsFor(fetchMock, runtime, hydrate) as never);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
      expect(runtime.exec).not.toHaveBeenCalled();
    },
  );
});
