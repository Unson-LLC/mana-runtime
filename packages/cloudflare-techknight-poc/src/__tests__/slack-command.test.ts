import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleSlackCommandRequest } from "../slack-command.js";
import type { SlackQueueEvent } from "../types.js";

const secret = "secret"; const nowMs = 1_786_680_000_000; const timestamp = String(nowMs / 1000);
function make(body: string) { return new Request("https://runtime.test/slack/commands", { method: "POST", headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}` }, body }); }
describe("Slack native development command", () => {
  it("acks an authorized command and queues a deterministic development event", async () => {
    const send = vi.fn(async (_event: Omit<SlackQueueEvent, "tenantId">) => undefined); const body = new URLSearchParams({ team_id: "T1", channel_id: "C1", user_id: "U1", command: "/vibepro", trigger_id: "tr1", text: "認証を直して" }).toString();
    const response = await handleSlackCommandRequest(make(body), { signingSecret: secret, placements: [{ channelId: "C1", allowedUserIds: ["U1"] }], nowMs, send });
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventType: "app_mention", text: "/develop 認証を直して", channelId: "C1", userId: "U1" }));
    expect(send.mock.calls[0][0]).not.toHaveProperty("tenantId");
  });
  it("does not queue an unauthorized command", async () => {
    const send = vi.fn(); const body = new URLSearchParams({ team_id: "T1", channel_id: "C1", user_id: "U2", command: "/ryoko-develop", trigger_id: "tr2", text: "x" }).toString();
    const response = await handleSlackCommandRequest(make(body), { signingSecret: secret, placements: [{ channelId: "C1", allowedUserIds: ["U1"] }], nowMs, send });
    expect(response.status).toBe(200); expect(send).not.toHaveBeenCalled();
  });
  it("does not combine a user from one placement with another placement channel", async () => {
    const send = vi.fn(); const body = new URLSearchParams({ team_id: "T1", channel_id: "C2", user_id: "U1", command: "/vibepro", trigger_id: "tr3", text: "x" }).toString();
    const response = await handleSlackCommandRequest(make(body), { signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }, { channelId: "C2", allowedUserIds: ["U2"] }], nowMs, send });
    expect(response.status).toBe(200); expect(send).not.toHaveBeenCalled();
  });
  it("lets the canonical resolver authorize an installed workspace instead of a static team binding", async () => {
    const send = vi.fn(async (_event: Omit<SlackQueueEvent, "tenantId">) => undefined);
    const body = new URLSearchParams({
      team_id: "T_INSTALLED",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr-installed",
      text: "tenant boundaryを直して",
    }).toString();

    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      send,
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "T_INSTALLED" }));
  });
});
