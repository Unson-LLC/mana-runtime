import { createHmac } from "node:crypto";
import { handleMeetingMinutesInteraction } from "../slack-interactions.js";

const secret = "secret"; const now = 1_786_420_000;
function request(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", { method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(now), "x-slack-signature": signature } });
}
const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
  actions: [{ action_id: "mana_meeting_minutes_choose_destination", action_ts: "1.2",
    value: JSON.stringify({ runId: "Ev1_F1", destinationId: "mana" }) }] };

describe("handleMeetingMinutesInteraction", () => {
  it("accepts destination-qualified action ids", async () => {
    const send = vi.fn();
    const qualifiedPayload = structuredClone(payload);
    qualifiedPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_destination:techknight-board";
    const result = await handleMeetingMinutesInteraction(request(qualifiedPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, send });
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it("verifies and queues an authorized selection", async () => {
    const send = vi.fn(); const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, send });
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledWith(expect.objectContaining({ runId: "Ev1_F1", destinationId: "mana" }));
  });
  it("fails closed for a non-operator", async () => {
    const send = vi.fn(); const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000, send });
    expect(response.status).toBe(403); expect(send).not.toHaveBeenCalled();
  });
  it("routes a signed task approval with the immutable payload hash", async () => {
    const approveTaskWrite = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const approvalPayload = { ...payload, user: { id: "U_APPROVER" }, actions: [{ action_id: "mana_task_write_approve",
      value: JSON.stringify({ approvalId: "approval-1", payloadHash: "a".repeat(64) }) }] };
    const response = await handleMeetingMinutesInteraction(request(approvalPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000,
      send: vi.fn(), approveTaskWrite });
    expect(response.status).toBe(200);
    expect(approveTaskWrite).toHaveBeenCalledWith({ approvalId: "approval-1", payloadHash: "a".repeat(64),
      approverId: "U_APPROVER", channelId: "C1" });
  });
});
