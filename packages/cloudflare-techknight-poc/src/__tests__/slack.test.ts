import { createHmac } from "node:crypto";

import {
  handleSlackRequest,
  normalizeSlackEvent,
  verifySlackRequest,
} from "../slack.js";

const signingSecret = "test-signing-secret";
const nowSeconds = 1_786_420_000;

function signature(timestamp: number, body: string): string {
  return `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

describe("verifySlackRequest", () => {
  it("accepts only a current valid Slack signature", async () => {
    const body = JSON.stringify({ type: "event_callback" });

    await expect(
      verifySlackRequest({
        body,
        timestamp: String(nowSeconds),
        signature: signature(nowSeconds, body),
        signingSecret,
        nowMs: nowSeconds * 1_000,
      }),
    ).resolves.toBe(true);

    await expect(
      verifySlackRequest({
        body: `${body} `,
        timestamp: String(nowSeconds),
        signature: signature(nowSeconds, body),
        signingSecret,
        nowMs: nowSeconds * 1_000,
      }),
    ).resolves.toBe(false);
  });

  it("rejects timestamps outside the five minute replay window", async () => {
    const body = "{}";
    const oldTimestamp = nowSeconds - 301;

    await expect(
      verifySlackRequest({
        body,
        timestamp: String(oldTimestamp),
        signature: signature(oldTimestamp, body),
        signingSecret,
        nowMs: nowSeconds * 1_000,
      }),
    ).resolves.toBe(false);
  });
});

describe("normalizeSlackEvent", () => {
  it("normalizes a TechKnight event without trusting tenant input", () => {
    expect(
      normalizeSlackEvent(
        {
          type: "event_callback",
          team_id: "T_TECHKNIGHT",
          event_id: "Ev123",
          tenant_id: "attacker-company",
          event: {
            type: "app_mention",
            channel: "C123",
            ts: "1786420000.000100",
            thread_ts: "1786419999.000001",
            user: "U123",
            bot_id: "B123",
            subtype: "bot_message",
            text: "議事録をタスク化して",
          },
        },
        "T_TECHKNIGHT",
        "2026-08-11T04:00:00.000Z",
      ),
    ).toEqual({
      tenantId: "techknight",
      eventId: "Ev123",
      workspaceId: "T_TECHKNIGHT",
      channelId: "C123",
      threadTs: "1786419999.000001",
      messageTs: "1786420000.000100",
      userId: "U123",
      botId: "B123",
      subtype: "bot_message",
      eventType: "app_mention",
      text: "議事録をタスク化して",
      receivedAt: "2026-08-11T04:00:00.000Z",
    });
  });

  it("rejects another Slack workspace before queueing", () => {
    expect(() =>
      normalizeSlackEvent(
        {
          type: "event_callback",
          team_id: "T_UNSON",
          event_id: "Ev123",
          event: { type: "app_mention", channel: "C123", ts: "1" },
        },
        "T_TECHKNIGHT",
        "2026-08-11T04:00:00.000Z",
      ),
    ).toThrowError("slack_team_forbidden");
  });
});

describe("handleSlackRequest", () => {
  it("returns a verified URL challenge without queueing", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-value",
    });
    const send = vi.fn();
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(nowSeconds),
        "x-slack-signature": signature(nowSeconds, body),
      },
      body,
    });

    const response = await handleSlackRequest(request, {
      signingSecret,
      expectedTeamId: "T_TECHKNIGHT",
      nowMs: nowSeconds * 1_000,
      send,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-value" });
    expect(send).not.toHaveBeenCalled();
  });
});
