import { describe, expect, it, vi } from "vitest";
import { runRemoteDevelopmentRequest } from "../development-runner-client.js";
describe("remote development runner", () => {
  it("passes bounded provenance and formats the validated result", async () => {
    const fetchImpl = vi.fn(async (_url, init) => { expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer secret" })); expect(JSON.parse(String(init?.body))).toEqual({ request: "修正して", placement_id: "mana-dev-biz", requester_id: "U1" }); return Response.json({ status: "completed", storyId: "STR-1", prUrl: "https://github.com/x/y/pull/1", summary: "完了" }); });
    await expect(runRemoteDevelopmentRequest({ request: "修正して", placementId: "mana-dev-biz", requesterId: "U1", baseUrl: "https://runner.example.com/runtime", token: "secret", fetchImpl: fetchImpl as typeof fetch })).resolves.toContain("Story: STR-1");
    expect(fetchImpl).toHaveBeenCalledWith("https://runner.example.com/runtime/run", expect.anything());
  });
  it("fails closed without a configured authenticated endpoint", async () => {
    await expect(runRemoteDevelopmentRequest({ request: "x", placementId: "p", requesterId: "u" })).rejects.toThrow("development_runner_not_configured");
  });
});
