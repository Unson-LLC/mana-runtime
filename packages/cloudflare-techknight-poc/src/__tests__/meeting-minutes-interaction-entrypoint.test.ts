import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteractionEntrypoint,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";

function tenantEffectResolver(overrides: Partial<TenantInteractionEffects> = {}) {
  return vi.fn(async (source: TenantInteractionIdentity): Promise<TenantInteractionEffects> => ({
    tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    source,
    durableObject: async (_effectId, _target, execute) => execute(),
    brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(fetch),
    slackDelivery: async (_effectId, _target, _event, execute) => execute(fetch),
    ...overrides,
  }));
}

describe("meeting minutes interaction Worker entrypoint", () => {
  it("fails closed when the canonical tenant effect resolver is not wired", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "tech-knight-secret";
    const payload = { api_app_id: "A-TECHKNIGHT", team: { id: "T-TECHKNIGHT" }, user: { id: "U1" },
      channel: { id: "CDEST" }, trigger_id: "trigger", actions: [{
        action_id: "mana_meeting_minutes_task_edit",
        value: JSON.stringify({ runId: "Ev1_F1", index: 0, organizationId: "tech-knight",
          channelId: "CDEST", title: "旧題", due: "2026-08-20" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const env = { SLACK_SIGNING_SECRET: "unson-secret", SLACK_SIGNING_SECRET_TECHKNIGHT: signingSecret,
      SLACK_EXPECTED_TEAM_ID: "T-UNSON", SLACK_EXPECTED_APP_ID: "A-UNSON",
      MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON: JSON.stringify({ "tech-knight": "T-TECHKNIGHT" }),
      TECHKNIGHT_EVENTS: { send: vi.fn() } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", {
      method: "POST", body, headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature },
    }), env as never, { waitUntil: vi.fn() } as never, new Set(["U1"]), undefined, undefined,
    vi.fn(async () => Response.json({ ok: true })), vi.fn(async () => undefined));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "FALLBACK_FORBIDDEN" });
  });

  it("accepts a Tech Knight task edit signed by the destination Slack app", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "tech-knight-secret";
    const payload = { api_app_id: "A-TECHKNIGHT", team: { id: "T-TECHKNIGHT" }, user: { id: "U1" },
      channel: { id: "CDEST" }, trigger_id: "trigger", actions: [{
        action_id: "mana_meeting_minutes_task_edit",
        value: JSON.stringify({ runId: "Ev1_F1", index: 0, organizationId: "tech-knight",
          channelId: "CDEST", title: "旧題", due: "2026-08-20" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const handleMeetingTaskAction = vi.fn(async () => Response.json({ ok: true }));
    const env = { SLACK_SIGNING_SECRET: "unson-secret", SLACK_SIGNING_SECRET_TECHKNIGHT: signingSecret,
      SLACK_EXPECTED_TEAM_ID: "T-UNSON", SLACK_EXPECTED_APP_ID: "A-UNSON",
      MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON: JSON.stringify({ "tech-knight": "T-TECHKNIGHT" }),
      TECHKNIGHT_EVENTS: { send: vi.fn() } };
    const resolveTenantEffects = tenantEffectResolver();
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", {
      method: "POST", body, headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature },
    }), env as never, { waitUntil: vi.fn() } as never, new Set(["U1"]), undefined, undefined,
    handleMeetingTaskAction, env.TECHKNIGHT_EVENTS.send, resolveTenantEffects);
    expect(response.status).toBe(200);
    expect(handleMeetingTaskAction).toHaveBeenCalledWith(
      expect.objectContaining({ team: { id: "T-TECHKNIGHT" } }),
      expect.objectContaining({ tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    );
    expect(resolveTenantEffects).toHaveBeenCalledOnce();
  });

  it("preserves the authenticated destination workspace and app when queueing a selection", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "tech-knight-secret";
    const payload = { api_app_id: "A-TECHKNIGHT", team: { id: "T-TECHKNIGHT" }, user: { id: "U1" },
      channel: { id: "CDEST" }, message: { ts: "2.1", thread_ts: "2.0" }, actions: [{
        action_id: "mana_meeting_minutes_choose_destination:techknight-board", action_ts: "2.2",
        value: JSON.stringify({ runId: "Ev1_F1", destinationId: "techknight-board" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const send = vi.fn().mockResolvedValue(undefined); const deferred: Promise<unknown>[] = [];
    const env = { SLACK_SIGNING_SECRET: "unson-secret", SLACK_SIGNING_SECRET_TECHKNIGHT: signingSecret,
      SLACK_EXPECTED_TEAM_ID: "T-UNSON", SLACK_EXPECTED_APP_ID: "A-UNSON",
      MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "C-SOURCE",
      MEETING_MINUTES_OPERATOR_USER_IDS: "U1",
      MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON: JSON.stringify({ "tech-knight": "T-TECHKNIGHT" }),
      MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "techknight-board", projectId: "p1", name: "ボード定例",
        organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "CDEST",
        github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" } }]), TECHKNIGHT_EVENTS: { send } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", {
      method: "POST", body, headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature },
    }), env as never, { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as never,
    new Set(["U1"]), undefined, undefined, undefined, send, tenantEffectResolver());

    expect(response.status).toBe(200); await Promise.all(deferred);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "meeting_minutes_selection",
      workspaceId: "T-TECHKNIGHT",
      appId: "A-TECHKNIGHT",
      channelId: "CDEST",
    }));
  });

  it("does not accept a destination-team payload signed by the source Slack app", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "unson-secret";
    const payload = { api_app_id: "A-UNSON", team: { id: "T-TECHKNIGHT" }, user: { id: "U1" },
      channel: { id: "CDEST" }, trigger_id: "trigger", actions: [{ action_id: "mana_meeting_minutes_task_edit", value: "{}" }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const handleMeetingTaskAction = vi.fn(async () => Response.json({ ok: true }));
    const env = { SLACK_SIGNING_SECRET: signingSecret, SLACK_SIGNING_SECRET_TECHKNIGHT: "tech-knight-secret",
      SLACK_EXPECTED_TEAM_ID: "T-UNSON", SLACK_EXPECTED_APP_ID: "A-UNSON",
      MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON: JSON.stringify({ "tech-knight": "T-TECHKNIGHT" }),
      TECHKNIGHT_EVENTS: { send: vi.fn() } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", {
      method: "POST", body, headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature },
    }), env as never, { waitUntil: vi.fn() } as never, new Set(["U1"]), undefined, undefined,
    handleMeetingTaskAction, env.TECHKNIGHT_EVENTS.send, tenantEffectResolver());
    expect(response.status).toBe(403);
    expect(handleMeetingTaskAction).not.toHaveBeenCalled();
  });

  it("acknowledges immediately and defers Queue without replacing the selector", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "secret";
    const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.com/actions/T1/B1/token", message: { ts: "1.1", thread_ts: "1.0" }, actions: [{
        action_id: "mana_meeting_minutes_choose_destination:techknight-board", action_ts: "1.2",
        value: JSON.stringify({ runId: "Ev1_F1", destinationId: "techknight-board" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const send = vi.fn().mockResolvedValue(undefined); const slackUpdate = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));
    const slackDelivery = vi.fn<TenantInteractionEffects["slackDelivery"]>(
      async (_effectId, _target, _event, execute) => (
        execute as unknown as (fetchImpl: typeof fetch) => Promise<void>
      )(slackUpdate as typeof fetch),
    );
    const deferred: Promise<unknown>[] = [];
    const env = { SLACK_SIGNING_SECRET: signingSecret, SLACK_EXPECTED_TEAM_ID: "T1", SLACK_EXPECTED_APP_ID: "A1",
      MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "C1", MEETING_MINUTES_OPERATOR_USER_IDS: "U1",
      SLACK_BOT_TOKEN: "xoxb-test",
      MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "techknight-board", projectId: "p1", name: "ボード定例",
        organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2",
        github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" } }]), TECHKNIGHT_EVENTS: { send } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", { method: "POST", body,
      headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature } }), env as never,
      { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as never, new Set(["U1"]),
      undefined, undefined, undefined, send, tenantEffectResolver({ slackDelivery }));
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1); await Promise.all(deferred);
    expect(send).toHaveBeenCalledOnce();
    expect(slackDelivery).toHaveBeenCalledWith(
      "processing-show:Ev1_F1:techknight-board",
      expect.objectContaining({ channel_id: "C1", thread_ts: "1.0" }),
      expect.objectContaining({ kind: "processing_status", runId: "Ev1_F1" }),
      expect.any(Function),
    );
    expect(slackUpdate).toHaveBeenCalledWith("https://slack.com/api/assistant.threads.setStatus", expect.objectContaining({
      method: "POST", body: JSON.stringify({ channel_id: "C1", thread_ts: "1.0",
        status: "議事録を作成しています…（ボード定例）" }),
    }));
  });

  it("updates the selector to trusted projects and does not enqueue an organization choice", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "secret";
    const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.com/actions/T1/B1/token", actions: [{
        action_id: "mana_meeting_minutes_choose_organization:tech-knight", action_ts: "1.2",
        value: JSON.stringify({ runId: "Ev1_F1", organizationId: "tech-knight", fileName: "定例.txt" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const send = vi.fn().mockResolvedValue(undefined); const slackUpdate = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", slackUpdate); const deferred: Promise<unknown>[] = [];
    const env = { SLACK_SIGNING_SECRET: signingSecret, SLACK_EXPECTED_TEAM_ID: "T1", SLACK_EXPECTED_APP_ID: "A1",
      MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "C1", MEETING_MINUTES_OPERATOR_USER_IDS: "U1",
      MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "techknight-board", projectId: "p1", name: "ボード定例",
        organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2",
        github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" } }]), TECHKNIGHT_EVENTS: { send } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", { method: "POST", body,
      headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature } }), env as never,
      { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as never, new Set(["U1"]),
      undefined, undefined, undefined, send, tenantEffectResolver());
    expect(response.status).toBe(200); await Promise.all(deferred);
    expect(send).not.toHaveBeenCalled();
    expect(slackUpdate).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      method: "POST", body: expect.stringContaining("ボード定例"),
    }));
    vi.unstubAllGlobals();
  });
});
