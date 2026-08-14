import { describe, expect, it, vi } from "vitest";
import { handleDevelopmentCallback } from "../development-callback.js";

const placement = { placementId: "mana-dev-biz", channelId: "C1", projectCodes: ["mana"], taskWriteEnabled: true,
  developmentEnabled: true, audience: { type: "operator" as const, allowedUserIds: ["U1"] },
  deliveryScopes: [{ connector: "slack" as const, channelId: "C1" }] };
function request(body: Record<string, unknown>, token = "secret") { return new Request("https://worker.test/development/callback", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }
const body = { job_id: "job_1", event_id: "Ev1", placement_id: "mana-dev-biz", workspace_id: "T1", channel_id: "C1", thread_ts: "1.0", requester_id: "U1", status: "completed", summary: "完了", story_id: "STR-1", pr_url: "https://github.com/x/y/pull/1" };

describe("development callback", () => {
  it("posts one bounded result after rechecking placement provenance", async () => {
    const post = vi.fn(async () => "2.0"); const completed = vi.fn(async () => false); const persist = vi.fn(async () => undefined);
    const response = await handleDevelopmentCallback(request(body), { token: "secret", tenantId: "unson-business", workspaceId: "T1", placements: [placement], isCompleted: completed, persistCompleted: persist, post });
    expect(response.status).toBe(200); expect(post).toHaveBeenCalledWith(expect.objectContaining({ eventId: "development:job_1", channelId: "C1", threadTs: "1.0" }), expect.stringContaining("Story: STR-1"));
    expect(persist).toHaveBeenCalledWith("development:job_1", "2.0", expect.objectContaining({ job_id: "job_1" }));
  });
  it("is idempotent for a repeated job callback", async () => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(request(body), { token: "secret", tenantId: "unson-business", workspaceId: "T1", placements: [placement], isCompleted: async () => true, persistCompleted: async () => undefined, post });
    expect(response.status).toBe(200); expect(post).not.toHaveBeenCalled();
  });
  it.each([
    ["bad token", request(body, "wrong")],
    ["other channel", request({ ...body, channel_id: "C2" })],
    ["other user", request({ ...body, requester_id: "U2" })],
    ["unsafe pr", request({ ...body, pr_url: "javascript:alert(1)" })],
  ])("fails closed for %s", async (_name, input) => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(input, { token: "secret", tenantId: "unson-business", workspaceId: "T1", placements: [placement], isCompleted: async () => false, persistCompleted: async () => undefined, post });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(post).not.toHaveBeenCalled();
  });
});
