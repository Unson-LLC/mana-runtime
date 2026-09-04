import { describe, expect, it, vi } from "vitest";
import { readSlackDeliveryReadback } from "../multitenancy/slack-delivery-readback.js";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const OBSERVED = { channel: "C_A0", ts: "1780000000.000100" };
const WINDOW = { oldest: "1779999999.000000", latest: "1780000001.000000" };
const BODY_HASH = "sha256:6db83ed5b3dc001f57ad26a97cc1d3e7eced5239897dc61672a42d900d4f9710";

function input(overrides: Record<string, unknown> = {}) {
  return {
    observed: OBSERVED,
    expected: { workspaceId: "T_A0", appId: "A_A0", botId: "B_A0" },
    bodyHash: BODY_HASH,
    window: WINDOW,
    expiresAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  } as Parameters<typeof readSlackDeliveryReadback>[0];
}

function slackResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

function readbackMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    ts: OBSERVED.ts,
    text: "A0 response",
    app_id: "A_A0",
    bot_id: "B_A0",
    ...overrides,
  };
}

describe("Slack delivery readback", () => {
  it("confirms one exact history message after completing pagination without exposing broker credentials", async () => {
    const credentialFetch = vi.fn()
      .mockResolvedValueOnce(slackResponse({
        ok: true,
        messages: [{ ts: "1780000000.000050", text: "other" }],
        response_metadata: { next_cursor: "page-2" },
      }))
      .mockResolvedValueOnce(slackResponse({
        ok: true,
        messages: [readbackMessage()],
        response_metadata: { next_cursor: "" },
      }));

    const result = await readSlackDeliveryReadback(input(), credentialFetch);

    expect(result).toEqual({
      state: "confirmed",
      receipt: { channel: OBSERVED.channel, ts: OBSERVED.ts, body_hash: BODY_HASH },
    });
    expect(Object.keys(result.receipt)).toEqual(["channel", "ts", "body_hash"]);
    expect(JSON.stringify(result)).not.toContain("A0 response");

    expect(credentialFetch).toHaveBeenCalledTimes(2);
    const firstRequest = new Request(credentialFetch.mock.calls[0]![0], credentialFetch.mock.calls[0]![1]);
    expect(firstRequest.method).toBe("GET");
    expect(firstRequest.headers.has("authorization")).toBe(false);
    expect(await firstRequest.text()).toBe("");
    const firstUrl = new URL(firstRequest.url);
    expect(firstUrl.pathname).toBe("/api/conversations.history");
    expect(firstUrl.searchParams.get("channel")).toBe(OBSERVED.channel);
    expect(firstUrl.searchParams.get("oldest")).toBe(WINDOW.oldest);
    expect(firstUrl.searchParams.get("latest")).toBe(WINDOW.latest);
    expect(firstUrl.searchParams.get("inclusive")).toBe("true");
    expect(firstUrl.searchParams.get("limit")).toBe("100");
    expect(firstUrl.searchParams.get("cursor")).toBeNull();

    const secondRequest = new Request(credentialFetch.mock.calls[1]![0], credentialFetch.mock.calls[1]![1]);
    expect(new URL(secondRequest.url).searchParams.get("cursor")).toBe("page-2");
  });

  it("uses a known thread for replies and accepts the broker-bound workspace without inventing a team field", async () => {
    const threadTs = "1779000000.000000";
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [
        { ts: threadTs, text: "root", app_id: "A_A0", bot_id: "B_A0" },
        readbackMessage({ thread_ts: threadTs }),
      ],
    }));

    const result = await readSlackDeliveryReadback(input({ threadTs }), credentialFetch);

    expect(result.state).toBe("confirmed");
    expect(result.receipt).toEqual({ channel: OBSERVED.channel, ts: OBSERVED.ts, body_hash: BODY_HASH });
    expect(JSON.stringify(result)).not.toContain("T_A0");

    const request = new Request(credentialFetch.mock.calls[0]![0], credentialFetch.mock.calls[0]![1]);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/api/conversations.replies");
    expect(url.searchParams.get("channel")).toBe(OBSERVED.channel);
    expect(url.searchParams.get("ts")).toBe(threadTs);
    expect(url.searchParams.get("oldest")).toBe(WINDOW.oldest);
    expect(url.searchParams.get("latest")).toBe(WINDOW.latest);
  });

  it.each([
    ["missing target", [], "not_found"],
    ["wrong body", [readbackMessage({ text: "different" })], "message_mismatch"],
    ["wrong bot", [readbackMessage({ bot_id: "B_OTHER" })], "message_mismatch"],
    ["wrong thread", [readbackMessage({ thread_ts: "1778000000.000000" })], "message_mismatch"],
    ["wrong workspace when Slack supplies one", [readbackMessage({ team_id: "T_OTHER" })], "message_mismatch"],
  ] as const)("returns unknown for %s", async (_label, messages, reason) => {
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({ ok: true, messages }));

    const result = await readSlackDeliveryReadback(input({ threadTs: "1779000000.000000" }), credentialFetch);

    expect(result).toEqual({
      state: "unknown",
      reason,
      receipt: { channel: OBSERVED.channel, ts: OBSERVED.ts, body_hash: BODY_HASH },
    });
  });

  it("returns unknown when the exact observation is ambiguous across pages", async () => {
    const credentialFetch = vi.fn()
      .mockResolvedValueOnce(slackResponse({
        ok: true,
        messages: [readbackMessage()],
        response_metadata: { next_cursor: "page-2" },
      }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [readbackMessage()] }));

    const result = await readSlackDeliveryReadback(input(), credentialFetch);

    expect(result).toMatchObject({ state: "unknown", reason: "ambiguous" });
    expect(credentialFetch).toHaveBeenCalledTimes(2);
  });

  it("does not confirm one matching message when the observed timestamp appears more than once", async () => {
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [
        readbackMessage(),
        readbackMessage({ bot_id: "B_OTHER" }),
      ],
    }));

    const result = await readSlackDeliveryReadback(input(), credentialFetch);

    expect(result).toMatchObject({ state: "unknown", reason: "ambiguous" });
  });

  it("does not confirm a target message when the Slack message type is missing", async () => {
    const message = readbackMessage();
    const { type: _type, ...messageWithoutType } = message;
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [messageWithoutType],
    }));

    const result = await readSlackDeliveryReadback(input(), credentialFetch);

    expect(result).toMatchObject({ state: "unknown", reason: "message_mismatch" });
  });

  it("does not confirm a non-message Slack event with matching delivery fields", async () => {
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [readbackMessage({ type: "message_changed" })],
    }));

    const result = await readSlackDeliveryReadback(input(), credentialFetch);

    expect(result).toMatchObject({ state: "unknown", reason: "message_mismatch" });
  });

  it("fails closed for expiry, rate limits, and an unfinished page cursor", async () => {
    const expiredFetch = vi.fn();
    await expect(readSlackDeliveryReadback(input({ expiresAt: NOW }), expiredFetch)).resolves.toEqual({
      state: "unknown",
      reason: "expired",
      receipt: { channel: OBSERVED.channel, ts: OBSERVED.ts, body_hash: BODY_HASH },
    });
    expect(expiredFetch).not.toHaveBeenCalled();

    const rateLimitedFetch = vi.fn().mockResolvedValue(slackResponse({}, 429, { "retry-after": "7" }));
    await expect(readSlackDeliveryReadback(input(), rateLimitedFetch)).resolves.toMatchObject({
      state: "unknown",
      reason: "rate_limited",
    });

    const incompleteFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [readbackMessage()],
      response_metadata: { next_cursor: "page-2" },
    }));
    await expect(readSlackDeliveryReadback(input({ maxPages: 1 }), incompleteFetch)).resolves.toMatchObject({
      state: "unknown",
      reason: "pagination_incomplete",
    });
    expect(incompleteFetch).toHaveBeenCalledTimes(1);
  });

  it("returns unknown for HTTP and transport failures without retrying", async () => {
    const httpFailureFetch = vi.fn().mockResolvedValue(new Response("provider failure", { status: 503 }));
    await expect(readSlackDeliveryReadback(input(), httpFailureFetch)).resolves.toMatchObject({
      state: "unknown",
      reason: "http_failure",
    });
    expect(httpFailureFetch).toHaveBeenCalledTimes(1);

    const transportFailureFetch = vi.fn().mockRejectedValue(new Error("network failure"));
    await expect(readSlackDeliveryReadback(input(), transportFailureFetch)).resolves.toMatchObject({
      state: "unknown",
      reason: "transport_failure",
    });
    expect(transportFailureFetch).toHaveBeenCalledTimes(1);
  });

  it("returns unknown when the deadline expires after hashing and before confirmation", async () => {
    let clockReads = 0;
    const now = vi.fn(() => {
      clockReads += 1;
      return clockReads <= 3 ? NOW : NOW + 60_000;
    });
    const credentialFetch = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [readbackMessage()],
    }));

    const result = await readSlackDeliveryReadback(input({ now }), credentialFetch);

    expect(result).toMatchObject({ state: "unknown", reason: "expired" });
    expect(now).toHaveBeenCalledTimes(4);
  });
});
