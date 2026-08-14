import { describe, expect, it, vi } from "vitest";
import { runRemoteDevelopmentRequest } from "../development-runner-client.js";
describe("remote development runner", () => {
  it("submits bounded provenance without waiting for the long-running result", async () => {
    const fetchImpl = vi.fn(async (_url, init) => { expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer secret" })); expect(JSON.parse(String(init?.body))).toEqual({ request: "修正して", placement_id: "mana-dev-biz", requester_id: "U1", event_id: "Ev1", workspace_id: "T1", channel_id: "C1", thread_ts: "1.0", callback_url: "https://worker.example.com/development/callback" }); return Response.json({ status: "accepted", job_id: "job_1" }, { status: 202 }); });
    await expect(runRemoteDevelopmentRequest({ request: "修正して", placementId: "mana-dev-biz", requesterId: "U1", eventId: "Ev1", workspaceId: "T1", channelId: "C1", threadTs: "1.0", callbackBaseUrl: "https://worker.example.com", baseUrl: "https://runner.example.com/runtime", token: "secret", fetchImpl: fetchImpl as typeof fetch })).resolves.toContain("job_1");
    expect(fetchImpl).toHaveBeenCalledWith("https://runner.example.com/runtime/run", expect.anything());
  });
  it("fails closed without a configured authenticated endpoint", async () => {
    await expect(runRemoteDevelopmentRequest({ request: "x", placementId: "p", requesterId: "u", eventId: "e", workspaceId: "t", channelId: "c", threadTs: "1" })).rejects.toThrow("development_runner_not_configured");
  });
  it("rejects a synchronous completion response", async () => {
    await expect(runRemoteDevelopmentRequest({ request: "x", placementId: "p", requesterId: "u", eventId: "e", workspaceId: "t", channelId: "c", threadTs: "1", callbackBaseUrl: "https://worker.example.com", baseUrl: "https://runner.example.com", token: "s", fetchImpl: async () => Response.json({ status: "completed", summary: "done" }) })).rejects.toThrow("development_runner_failed");
  });
});
