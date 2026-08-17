import { describe, expect, it, vi } from "vitest";
import { handleDevelopmentCallback } from "../development-callback.js";

const placement = { placementId: "mana-dev-biz", channelId: "C1", projectCodes: ["mana"], taskWriteEnabled: true,
  developmentEnabled: true, audience: { type: "operator" as const, allowedUserIds: ["U1"] },
  deliveryScopes: [{ connector: "slack" as const, channelId: "C1" }] };
function request(body: Record<string, unknown>, token = "secret") { return new Request("https://worker.test/development/callback", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }
const body = { job_id: "job_1", event_id: "Ev1", placement_id: "mana-dev-biz", workspace_id: "T1", channel_id: "C1", thread_ts: "1.0", requester_id: "U1", status: "completed", summary: "完了", story_id: "STR-1", pr_url: "https://github.com/x/y/pull/1" };

describe("development callback", () => {
  it("posts one bounded result after rechecking placement provenance", async () => {
    const post = vi.fn(async () => "2.0"); const claim = vi.fn(async () => true); const complete = vi.fn(async () => undefined);
    const resolve = vi.fn(async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }));
    const response = await handleDevelopmentCallback(request(body), { token: "secret", workspaceId: "T1", placements: [placement], resolve, claim, complete, release: async () => undefined, post });
    expect(response.status).toBe(200); expect(post).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV", eventId: "development:job_1", channelId: "C1", threadTs: "1.0" }), expect.stringContaining("Story: STR-1"));
    expect(resolve).toHaveBeenCalledBefore(claim);
    expect(complete).toHaveBeenCalledWith("development:job_1", "2.0", expect.objectContaining({ job_id: "job_1" }));
  });
  it("is idempotent for a repeated job callback", async () => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(request(body), { token: "secret", workspaceId: "T1", placements: [placement], resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), claim: async () => false, complete: async () => undefined, release: async () => undefined, post });
    expect(response.status).toBe(200); expect(post).not.toHaveBeenCalled();
  });
  it("claims a job before posting so concurrent callbacks cannot double-post", async () => {
    let claimed = false;
    const claim = vi.fn(async () => claimed ? false : (claimed = true));
    const post = vi.fn(async () => "2.0");
    const options = { token: "secret", workspaceId: "T1", placements: [placement],
      resolve: async (event: Parameters<typeof post>[0]) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim, complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined), post };
    const [first, second] = await Promise.all([
      handleDevelopmentCallback(request(body), options),
      handleDevelopmentCallback(request(body), options),
    ]);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("releases the claim when Slack posting fails", async () => {
    const release = vi.fn(async () => undefined);
    await expect(handleDevelopmentCallback(request(body), { token: "secret", workspaceId: "T1", placements: [placement],
      resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), claim: async () => true,
      complete: async () => undefined, release, post: async () => { throw new Error("slack_down"); } })).rejects.toThrow("slack_down");
    expect(release).toHaveBeenCalledWith("development:job_1", expect.objectContaining({ job_id: "job_1" }));
  });
  it.each([
    ["bad token", request(body, "wrong")],
    ["other channel", request({ ...body, channel_id: "C2" })],
    ["other user", request({ ...body, requester_id: "U2" })],
    ["unsafe pr", request({ ...body, pr_url: "javascript:alert(1)" })],
  ])("fails closed for %s", async (_name, input) => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(input, { token: "secret", workspaceId: "T1", placements: [placement], resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), claim: async () => true, complete: async () => undefined, release: async () => undefined, post });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(post).not.toHaveBeenCalled();
  });

  it("fails closed before claim when tenant authority rejects the callback scope", async () => {
    const claim = vi.fn();
    await expect(handleDevelopmentCallback(request(body), { token: "secret", workspaceId: "T1", placements: [placement],
      resolve: async () => { throw new Error("WORKSPACE_CONNECTION_STALE_REVISION"); }, claim,
      complete: async () => undefined, release: async () => undefined, post: vi.fn() }))
      .rejects.toThrow("WORKSPACE_CONNECTION_STALE_REVISION");
    expect(claim).not.toHaveBeenCalled();
  });
});
