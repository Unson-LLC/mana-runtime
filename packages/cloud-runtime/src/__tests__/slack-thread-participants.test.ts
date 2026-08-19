import { describe, expect, it, vi } from "vitest";
import { appendSlackThreadParticipantProfiles } from "../slack-thread-participants.js";
describe("Slack thread participant profiles", () => {
  it("adds each unique participant profile without exposing the token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const id = new URL(String(input)).searchParams.get("user"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token"); return Response.json({ ok: true, user: { id, name: `handle-${id}`, real_name: `Real ${id}`, profile: { display_name: `Display ${id}` }, tz: "Asia/Tokyo" } }); });
    const result = await appendSlackThreadParticipantProfiles("<@U111>: hello\n<@U222>: hi\n<@U111>: again", { botToken: "token", fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(result).toContain("U111: display_name=Display U111"); expect(result).not.toContain("token");
  });
});
