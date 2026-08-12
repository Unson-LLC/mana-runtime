import { describe, expect, it, vi } from "vitest";
import { hydrateSlackQueueEventThreadContext } from "../slack-thread-context.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "unson",
    eventId: "EvThread",
    workspaceId: "T_UNSON",
    channelId: "C_BACK_OFFICE",
    threadTs: "1",
    messageTs: "3",
    userId: "U3",
    eventType: "app_mention",
    text: "<@BOT> このスレッドを説明して",
    receivedAt: "2026-08-12T07:00:00.000Z",
    ...overrides,
  };
}

describe("Cloudflare Slack thread context adapter", () => {
  it("hydrates paginated history and excludes the current mention", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        messages: [{ ts: "1", user: "U1", text: "契約更新について" }],
        response_metadata: { next_cursor: "next" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        messages: [
          { ts: "2", user: "U2", text: "月額は5万円" },
          { ts: "3", user: "U3", text: "このスレッドを説明して" },
        ],
      }), { status: 200 }));

    const hydrated = await hydrateSlackQueueEventThreadContext(event(), {
      botToken: "xoxb-secret",
      fetch: fetchMock,
    });

    expect(hydrated.threadContext).toContain("契約更新について");
    expect(hydrated.threadContext).toContain("月額は5万円");
    expect(hydrated.threadContext).not.toContain("このスレッドを説明して");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ cursor: "next", limit: 99 });
  });

  it("does not call Slack for a root mention", async () => {
    const fetchMock = vi.fn();
    const root = event({ threadTs: "1", messageTs: "1" });
    await expect(hydrateSlackQueueEventThreadContext(root, {
      botToken: "xoxb-secret",
      fetch: fetchMock,
    })).resolves.toBe(root);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Slack rejects history access", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "missing_scope",
    }), { status: 200 }));
    await expect(hydrateSlackQueueEventThreadContext(event(), {
      botToken: "xoxb-secret",
      fetch: fetchMock,
    })).rejects.toMatchObject({
      code: "slack_thread_history_unavailable",
    });
  });

  it("classifies Slack rate limits for queue retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {
      status: 429,
      headers: { "retry-after": "7" },
    }));
    await expect(hydrateSlackQueueEventThreadContext(event(), {
      botToken: "xoxb-secret",
      fetch: fetchMock,
    })).rejects.toMatchObject({
      code: "slack_thread_history_rate_limited",
      retryAfterSeconds: 7,
    });
  });
});
