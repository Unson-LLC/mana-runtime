import { createHmac } from "node:crypto";
import { handleMeetingMinutesInteraction, updateSlackInteractionMessage } from "../slack-interactions.js";

const secret = "secret"; const now = 1_786_420_000;
function request(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", { method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(now), "x-slack-signature": signature } });
}
const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
  response_url: "https://hooks.slack.com/actions/T1/B1/token",
  actions: [{ action_id: "mana_meeting_minutes_choose_destination", action_ts: "1.2",
    value: JSON.stringify({ runId: "Ev1_F1", destinationId: "mana" }) }] };

describe("handleMeetingMinutesInteraction", () => {
  function deferred() { const work: Promise<void>[] = []; return { work, defer: (promise: Promise<void>) => { work.push(promise); } }; }
  it("accepts destination-qualified action ids", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const qualifiedPayload = structuredClone(payload);
    qualifiedPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_destination:techknight-board";
    const result = await handleMeetingMinutesInteraction(request(qualifiedPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, send, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(updateOriginal).not.toHaveBeenCalled();
  });

  it("verifies and queues an authorized selection", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, send, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledWith(expect.objectContaining({ runId: "Ev1_F1", destinationId: "mana" }));
    expect(updateOriginal).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: true });
  });
  it("queues even when Slack did not provide a response URL", async () => {
    const invalid = { ...payload, response_url: "https://example.com/actions/token" };
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(invalid), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, send, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledOnce(); expect(updateOriginal).not.toHaveBeenCalled();
  });
  it("does not show processing when the queue rejects the selection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable")); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).rejects.toThrow("queue unavailable");
    expect(updateOriginal).not.toHaveBeenCalled();
  });
  it("fails closed for a non-operator", async () => {
    const send = vi.fn(); const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000, send });
    expect(response.status).toBe(403); expect(send).not.toHaveBeenCalled();
  });
  it("routes a signed task approval with the immutable payload hash", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn();
    const approveTaskWrite = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const approvalPayload = { ...payload, user: { id: "U_APPROVER" }, actions: [{ action_id: "mana_task_write_approve",
      value: JSON.stringify({ approvalId: "approval-1", payloadHash: "a".repeat(64) }) }] };
    const response = await handleMeetingMinutesInteraction(request(approvalPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000,
      send, updateOriginal, approveTaskWrite });
    expect(response.status).toBe(200);
    expect(approveTaskWrite).toHaveBeenCalledWith({ approvalId: "approval-1", payloadHash: "a".repeat(64),
      approverId: "U_APPROVER", channelId: "C1" });
    expect(send).not.toHaveBeenCalled(); expect(updateOriginal).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("updateSlackInteractionMessage", () => {
  it("posts the replacement to Slack's response URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    const message = { replace_original: true as const, text: "議事録を作成中です。", blocks: [] };
    await updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token", message, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://hooks.slack.com/actions/T1/B1/token", expect.objectContaining({
      method: "POST", body: JSON.stringify(message),
    }));
  });
  it("rejects a non-Slack response URL before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(updateSlackInteractionMessage("https://example.com/actions/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_response_url_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects non-standard ports and does not follow redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    await expect(updateSlackInteractionMessage("https://hooks.slack.com:8443/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_response_url_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
    await updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual" }));
  });
  it("fails closed when Slack's response URL redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302,
      headers: { location: "https://example.com/collect" } }));
    await expect(updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_interaction_update_failed:302");
  });
});
