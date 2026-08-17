import { describe, expect, it, vi } from "vitest";
import { handleDevelopmentCallback } from "../development-callback.js";
import type { SlackQueueEvent } from "../types.js";

const placement = { placementId: "mana-dev-biz", channelId: "C1", projectCodes: ["mana"], taskWriteEnabled: true,
  developmentEnabled: true, audience: { type: "operator" as const, allowedUserIds: ["U1"] },
  deliveryScopes: [{ connector: "slack" as const, channelId: "C1" }] };
function request(body: Record<string, unknown>, token = "secret") { return new Request("https://worker.test/development/callback", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }
const body = { job_id: "job_1", event_id: "Ev1", placement_id: "mana-dev-biz", workspace_id: "T1", channel_id: "C1", thread_ts: "1.0", requester_id: "U1", status: "completed", summary: "完了", quota_decision: "allowed", story_id: "STR-1", pr_url: "https://github.com/x/y/pull/1" };

describe("development callback", () => {
  it("authorizes an installed workspace through tenant authority instead of a static workspace binding", async () => {
    const resolve = vi.fn(async (event: SlackQueueEvent) => ({
      ...event,
      tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }));
    const post = vi.fn(async () => "2.0");
    const response = await handleDevelopmentCallback(request(body), {
      token: "secret",
      placements: [placement],
      resolve,
      claim: async () => ({ state: "claimed" }),
      recordDelivery: async () => undefined,
      complete: async () => undefined,
      release: async () => undefined,
      post,
    });

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "T1" }));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("posts one bounded result after rechecking placement provenance", async () => {
    const post = vi.fn(async () => "2.0"); const claim = vi.fn(async () => ({ state: "claimed" as const })); const complete = vi.fn(async () => undefined);
    const resolve = vi.fn(async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }));
    const response = await handleDevelopmentCallback(request(body), { token: "secret", placements: [placement], resolve, claim, recordDelivery: async () => undefined, complete, release: async () => undefined, post });
    expect(response.status).toBe(200); expect(post).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV", eventId: "development:job_1", channelId: "C1", threadTs: "1.0" }), expect.stringContaining("Story: STR-1"));
    expect(resolve).toHaveBeenCalledBefore(claim);
    expect(complete).toHaveBeenCalledWith("development:job_1", expect.objectContaining({ job_id: "job_1" }),
      { state: "delivered", responseTs: "2.0" });
  });
  it("is idempotent for a repeated job callback", async () => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(request(body), { token: "secret", placements: [placement], resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), claim: async () => ({ state: "completed" }), recordDelivery: async () => undefined, complete: async () => undefined, release: async () => undefined, post });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, state: "completed", duplicate: true });
    expect(post).not.toHaveBeenCalled();
  });
  it("accepts timed_out as a terminal outcome without changing collection state", async () => {
    const post = vi.fn(async () => "2.0");
    const response = await handleDevelopmentCallback(request({ ...body, status: "timed_out" }), {
      token: "secret", placements: [placement],
      resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim: async () => ({ state: "claimed" }), recordDelivery: async () => undefined,
      complete: async () => undefined, release: async () => undefined, post,
    });
    expect(response.status).toBe(200);
    expect(post).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Development: timed_out"));
  });
  it("claims a job before posting so concurrent callbacks cannot double-post", async () => {
    let claimed = false;
    const claim = vi.fn(async () => claimed
      ? ({ state: "in_progress" } as const)
      : (claimed = true, { state: "claimed" } as const));
    const post = vi.fn(async () => "2.0");
    const options = { token: "secret", placements: [placement],
      resolve: async (event: SlackQueueEvent) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim, recordDelivery: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined), post };
    const [first, second] = await Promise.all([
      handleDevelopmentCallback(request(body), options),
      handleDevelopmentCallback(request(body), options),
    ]);
    expect(first.status).toBe(200); expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "development_callback_in_progress" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("resumes accounting from a durable delivery result without posting Slack again", async () => {
    const post = vi.fn();
    const complete = vi.fn(async () => undefined);
    const response = await handleDevelopmentCallback(request(body), {
      token: "secret", placements: [placement],
      resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim: async () => ({ state: "accounting_pending", delivery: { state: "delivered", responseTs: "2.0" } }),
      recordDelivery: vi.fn(async () => undefined), complete, release: vi.fn(async () => undefined), post,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, state: "completed" });
    expect(post).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("development:job_1", expect.objectContaining({ job_id: "job_1" }),
      { state: "delivered", responseTs: "2.0" });
  });

  it("rejects a different terminal payload for an existing job", async () => {
    const post = vi.fn();
    const response = await handleDevelopmentCallback(request(body), {
      token: "secret", placements: [placement],
      resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim: async () => ({ state: "conflict" }),
      recordDelivery: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined), post,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "development_callback_conflict" });
    expect(post).not.toHaveBeenCalled();
  });
  it("records a failed Slack delivery before terminal accounting without releasing the claim", async () => {
    const release = vi.fn(async () => undefined);
    const recordDelivery = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const response = await handleDevelopmentCallback(request(body), { token: "secret", placements: [placement],
      resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
      claim: async () => ({ state: "claimed" }), recordDelivery, complete, release,
      post: async () => { throw new Error("slack_down"); } });
    expect(response.status).toBe(200);
    expect(recordDelivery).toHaveBeenCalledWith("development:job_1", expect.objectContaining({ job_id: "job_1" }),
      { state: "failed" });
    expect(complete).toHaveBeenCalledWith("development:job_1", expect.objectContaining({ job_id: "job_1" }),
      { state: "failed" });
    expect(release).not.toHaveBeenCalled();
  });
  it.each([
    ["bad token", request(body, "wrong")],
    ["other channel", request({ ...body, channel_id: "C2" })],
    ["other user", request({ ...body, requester_id: "U2" })],
    ["unsafe pr", request({ ...body, pr_url: "javascript:alert(1)" })],
  ])("fails closed for %s", async (_name, input) => {
    const post = vi.fn(); const response = await handleDevelopmentCallback(input, { token: "secret", placements: [placement], resolve: async (event) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), claim: async () => ({ state: "claimed" }), recordDelivery: async () => undefined, complete: async () => undefined, release: async () => undefined, post });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(post).not.toHaveBeenCalled();
  });

  it("fails closed before claim when tenant authority rejects the callback scope", async () => {
    const claim = vi.fn();
    await expect(handleDevelopmentCallback(request(body), { token: "secret", placements: [placement],
      resolve: async () => { throw new Error("WORKSPACE_CONNECTION_STALE_REVISION"); }, claim,
      recordDelivery: async () => undefined,
      complete: async () => undefined, release: async () => undefined, post: vi.fn() }))
      .rejects.toThrow("WORKSPACE_CONNECTION_STALE_REVISION");
    expect(claim).not.toHaveBeenCalled();
  });
});
