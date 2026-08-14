import { createHmac } from "node:crypto";
import { handleMeetingMinutesInteractionEntrypoint } from "../slack-interactions.js";

describe("meeting minutes interaction Worker entrypoint", () => {
  it("acknowledges immediately and defers Queue without replacing the selector", async () => {
    const now = Math.floor(Date.now() / 1000); const signingSecret = "secret";
    const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.com/actions/T1/B1/token", actions: [{
        action_id: "mana_meeting_minutes_choose_destination:techknight-board", action_ts: "1.2",
        value: JSON.stringify({ runId: "Ev1_F1", destinationId: "techknight-board" }),
      }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${now}:${body}`).digest("hex")}`;
    const send = vi.fn().mockResolvedValue(undefined); const slackUpdate = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", slackUpdate);
    const deferred: Promise<unknown>[] = [];
    const env = { SLACK_SIGNING_SECRET: signingSecret, SLACK_EXPECTED_TEAM_ID: "T1", SLACK_EXPECTED_APP_ID: "A1",
      MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "C1", MEETING_MINUTES_OPERATOR_USER_IDS: "U1",
      MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "techknight-board", projectId: "p1", name: "ボード定例",
        organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2",
        github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" } }]), TECHKNIGHT_EVENTS: { send } };
    const response = await handleMeetingMinutesInteractionEntrypoint(new Request("https://worker/slack/interactions", { method: "POST", body,
      headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signature } }), env as never,
      { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as never, new Set(["U1"]));
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1); await Promise.all(deferred);
    expect(send).toHaveBeenCalledOnce();
    expect(slackUpdate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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
      { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as never, new Set(["U1"]));
    expect(response.status).toBe(200); await Promise.all(deferred);
    expect(send).not.toHaveBeenCalled();
    expect(slackUpdate).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      method: "POST", body: expect.stringContaining("ボード定例"),
    }));
    vi.unstubAllGlobals();
  });
});
