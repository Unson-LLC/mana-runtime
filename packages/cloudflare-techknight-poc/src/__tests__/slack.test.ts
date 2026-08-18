import { createHmac } from "node:crypto";

import {
  handleSlackRequest,
  handleTenantSlackRequest,
  normalizeSlackEvent,
  verifySlackRequest,
} from "../slack.js";
import { interceptMeetingMinutesIntakePause } from "../meeting-minutes-intake-entrypoints.js";
import { MAX_SLACK_REQUEST_BODY_BYTES } from "../slack-request-body.js";

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
  it("normalizes an authorized bot mention delivered as a message event", () => {
    const event = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T_UNSON",
      event_id: "EvMention",
      authorizations: [{ user_id: "U_MANA", is_bot: true }],
      event: {
        type: "message",
        channel: "C_ROUTER",
        ts: "1786688096.218849",
        user: "U_REQUESTER",
        text: "<@U_MANA> Taskを作成してください",
      },
    }, "T_UNSON", "2026-08-14T06:25:00.000Z", "unson");

    expect(event.eventType).toBe("app_mention");
    expect(event.userId).toBe("U_REQUESTER");
  });

  it("does not promote a message that mentions another user", () => {
    const event = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T_UNSON",
      event_id: "EvOtherMention",
      authorizations: [{ user_id: "U_MANA", is_bot: true }],
      event: {
        type: "message",
        channel: "C_ROUTER",
        ts: "1786688097.218849",
        user: "U_REQUESTER",
        text: "<@U_OTHER> Taskを作成してください",
      },
    }, "T_UNSON", "2026-08-14T06:25:00.000Z", "unson");

    expect(event.eventType).toBe("message");
  });

  it("keeps bounded file identities without persisting download URLs", () => {
    const event = normalizeSlackEvent({
      type: "event_callback", team_id: "T_UNSON", event_id: "EvFile",
      event: { type: "message", subtype: "file_share", channel: "C_ROUTER", ts: "1.1",
        files: [{ id: "F123", name: "meeting.txt", mimetype: "text/plain", size: 42,
          url_private_download: "https://files.slack.com/secret" }] },
    }, "T_UNSON", "2026-08-13T00:00:00.000Z", "unson");

    expect(event.files).toEqual([{ id: "F123", name: "meeting.txt", mimetype: "text/plain", size: 42 }]);
    expect(JSON.stringify(event)).not.toContain("files.slack.com");
  });

  it("rejects oversized file metadata before queueing", () => {
    expect(() => normalizeSlackEvent({
      type: "event_callback", team_id: "T_UNSON", event_id: "EvFile",
      event: { type: "message", channel: "C_ROUTER", ts: "1.1",
        files: [{ id: "F123", name: "meeting.txt", size: 20 * 1024 * 1024 + 1 }] },
    }, "T_UNSON", "2026-08-13T00:00:00.000Z", "unson"))
      .toThrowError("slack_file_size_invalid");
  });

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

  it("uses the configured tenant instead of a TechKnight constant", () => {
    expect(
      normalizeSlackEvent(
        {
          type: "event_callback",
          team_id: "T_UNSON",
          event_id: "EvUnson",
          event: {
            type: "app_mention",
            channel: "C_BACK_OFFICE",
            ts: "1786420000.000100",
            user: "U123",
            text: "議事録をタスク化して",
          },
        },
        "T_UNSON",
        "2026-08-11T04:00:00.000Z",
        "unson",
      ),
    ).toMatchObject({
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
    });
  });
});

describe("handleSlackRequest", () => {
  it("rejects an oversized tenant event before authority resolution or queueing", async () => {
    const send = vi.fn();
    const authority = {
      resolve_workspace_connection: vi.fn(async () => { throw new Error("must not resolve"); }),
      read_workspace_connection: vi.fn(async () => { throw new Error("must not read"); }),
      issue_tenant_context: vi.fn(async () => { throw new Error("must not issue"); }),
    };
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "content-length": String(MAX_SLACK_REQUEST_BODY_BYTES + 1),
        "x-slack-request-timestamp": String(nowSeconds),
        "x-slack-signature": "v0=not-a-valid-signature",
      },
      body: "{}",
    });

    const response = await handleTenantSlackRequest(request, {
      signing_secret: signingSecret,
      expected_app_id: "A_UNSON",
      required_scopes: ["chat:write"],
      required_authorization: {
        audience: "mana-runtime",
        project_id: "mana",
        capability_id: "slack.event.receive",
      },
      authority,
      now_ms: nowSeconds * 1_000,
      resolve_verification_key: async () => undefined,
      send,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "slack_request_body_too_large" });
    expect(authority.resolve_workspace_connection).not.toHaveBeenCalled();
    expect(authority.read_workspace_connection).not.toHaveBeenCalled();
    expect(authority.issue_tenant_context).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before signature verification or queueing", async () => {
    const send = vi.fn();
    const request = new Request("https://example.com/slack/events", {
      method: "POST",
      headers: {
        "content-length": String(MAX_SLACK_REQUEST_BODY_BYTES + 1),
        "x-slack-request-timestamp": String(nowSeconds),
        "x-slack-signature": "v0=not-a-valid-signature",
      },
      body: "{}",
    });

    const response = await handleSlackRequest(request, {
      signingSecret,
      expectedTeamId: "T_UNSON",
      nowMs: nowSeconds * 1_000,
      send,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "slack_request_body_too_large" });
    expect(send).not.toHaveBeenCalled();
  });

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
      expectedAppId: "A_TECHKNIGHT",
      nowMs: nowSeconds * 1_000,
      send,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-value" });
    expect(send).not.toHaveBeenCalled();
  });

  it("queues an event with the configured non-TechKnight tenant", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_UNSON",
      team_id: "T_UNSON",
      event_id: "EvUnson",
      event: {
        type: "app_mention",
        channel: "C_BACK_OFFICE",
        ts: "1786420000.000100",
        user: "U123",
        text: "議事録をタスク化して",
      },
    });
    const send = vi.fn().mockResolvedValue(undefined);
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
      tenantId: "unson",
      expectedTeamId: "T_UNSON",
      expectedAppId: "A_UNSON",
      nowMs: nowSeconds * 1_000,
      send,
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
    }));
  });

  it("acks an intercepted router file without queueing it", async () => {
    const body = JSON.stringify({
      type: "event_callback", api_app_id: "A_UNSON", team_id: "T_UNSON", event_id: "EvPaused",
      event: { type: "message", subtype: "file_share", channel: "C_ROUTER", ts: "1786420000.000150",
        user: "U123", text: "", files: [{ id: "F1", name: "meeting.txt" }] },
    });
    const send = vi.fn();
    const intercept = vi.fn().mockResolvedValue(true);
    const request = new Request("https://example.com/slack/events", { method: "POST", headers: {
      "content-type": "application/json", "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature(nowSeconds, body),
    }, body });

    const response = await handleSlackRequest(request, { signingSecret, tenantId: "unson",
      expectedTeamId: "T_UNSON", expectedAppId: "A_UNSON", nowMs: nowSeconds * 1_000, intercept, send });

    expect(response.status).toBe(200);
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ eventId: "EvPaused", channelId: "C_ROUTER" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not enqueue a file received while paused even after intake resumes", async () => {
    const body = JSON.stringify({
      type: "event_callback", api_app_id: "A_UNSON", team_id: "T_UNSON", event_id: "EvPausedRace",
      event: { type: "message", subtype: "file_share", channel: "C_ROUTER", ts: "1786420000.000155",
        user: "U123", text: "", files: [{ id: "F1", name: "meeting.txt" }] },
    });
    let paused = true;
    const send = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    const deferred: Promise<void>[] = [];
    const request = new Request("https://example.com/slack/events", { method: "POST", headers: {
      "content-type": "application/json", "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature(nowSeconds, body),
    }, body });

    const response = await handleSlackRequest(request, { signingSecret, tenantId: "unson",
      expectedTeamId: "T_UNSON", expectedAppId: "A_UNSON", nowMs: nowSeconds * 1_000,
      intercept: (event) => interceptMeetingMinutesIntakePause(event, {
        isPaused: async () => paused,
        notify,
        defer: (work) => deferred.push(work),
      }),
      send });
    paused = false;
    await Promise.all(deferred);

    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("C_ROUTER", "1786420000.000155");
  });

  it("continues queueing ordinary events when the interceptor declines them", async () => {
    const body = JSON.stringify({
      type: "event_callback", api_app_id: "A_UNSON", team_id: "T_UNSON", event_id: "EvOrdinary",
      event: { type: "app_mention", channel: "C_OTHER", ts: "1786420000.000160", user: "U123", text: "hello" },
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const intercept = vi.fn().mockResolvedValue(false);
    const request = new Request("https://example.com/slack/events", { method: "POST", headers: {
      "content-type": "application/json", "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature(nowSeconds, body),
    }, body });

    const response = await handleSlackRequest(request, { signingSecret, tenantId: "unson",
      expectedTeamId: "T_UNSON", expectedAppId: "A_UNSON", nowMs: nowSeconds * 1_000, intercept, send });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects a signed request from a different Slack App", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_DIFFERENT",
      team_id: "T_UNSON",
      event_id: "EvDifferentApp",
      event: {
        type: "app_mention",
        channel: "C_BACK_OFFICE",
        ts: "1786420000.000200",
        user: "U123",
        text: "hello",
      },
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
      expectedTeamId: "T_UNSON",
      expectedAppId: "A_UNSON",
      nowMs: nowSeconds * 1_000,
      send,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "slack_app_forbidden" });
    expect(send).not.toHaveBeenCalled();
  });
});
