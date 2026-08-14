import { hydrateGraphContext, listGraphPeople, resolveGraphPersonByName, resolveGraphRequester } from "../brainbase-graph-runtime.js";

const options = { baseUrl: "https://brainbase.example", token: "secret" };

describe("Brainbase Graph runtime", () => {
  it("resolves a requester using exact workspace and Slack user IDs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ person: { id: "per_umeda", name: "梅田" } }));
    await expect(resolveGraphRequester("T1", "U1", "mana", { ...options, fetch: fetchImpl })).resolves.toEqual({
      status: "resolved", personId: "per_umeda", personName: "梅田",
    });
    expect(fetchImpl.mock.calls[0][0].searchParams.get("workspaceId")).toBe("T1");
    expect(fetchImpl.mock.calls[0][0].searchParams.get("slackUserId")).toBe("U1");
    expect(fetchImpl.mock.calls[0][0].searchParams.get("project")).toBe("mana");
  });

  it.each([[404, "not_found"], [409, "ambiguous"], [503, "unavailable"]])(
    "fails closed for HTTP %s", async (status, expected) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: status as number }));
      await expect(resolveGraphRequester("T1", "U1", "mana", { ...options, fetch: fetchImpl })).resolves.toEqual({ status: expected });
    });

  it("hydrates philosophy, report, and scoped memory for the exact placement context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      philosophy_context: { prompt_block: "philosophy" }, report: { task: 1 }, scoped_memory: { note: "local" }, meta: { revision: "r1" },
    }));
    const event = { tenantId: "t", workspaceId: "T1", channelId: "C1", threadTs: "1.0", messageTs: "1.0", eventId: "E1", eventType: "app_mention", text: "x", receivedAt: "now" };
    const result = await hydrateGraphContext(event, "mana", { ...options, fetch: fetchImpl });
    expect(result).toMatchObject({ status: "available", revision: "r1" });
    expect(result.content).toContain("philosophy");
    expect(result.content).toContain("Scoped promoted memory");
    const url = fetchImpl.mock.calls[0][0] as URL;
    expect(url.searchParams.get("project")).toBe("mana");
    expect(url.searchParams.get("workspace")).toBe("T1");
    expect(url.searchParams.get("channelId")).toBe("C1");
    expect(url.searchParams.get("sessionId")).toBe("1.0");
  });

  it("resolves a meeting assignee by exact canonical name or alias", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records: [
      { id: "per_umeda", payload: { name: "梅田 遼", aliases: ["Haruka Umeda"] } },
    ] }));
    await expect(resolveGraphPersonByName("梅田遼", "mana", { ...options, fetch: fetchImpl }))
      .resolves.toEqual({ status: "resolved", personId: "per_umeda" });
    const url = fetchImpl.mock.calls[0][0] as URL;
    expect(url.searchParams.get("type")).toBe("person");
    expect(url.searchParams.get("project")).toBe("mana");
  });

  it("resolves a meeting assignee when the extracted Japanese name includes a polite suffix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records: [
      { id: "per_umeda", payload: { name: "梅田 恵伍", aliases: [] } },
    ] }));
    await expect(resolveGraphPersonByName("梅田恵伍さん", "mana", { ...options, fetch: fetchImpl }))
      .resolves.toEqual({ status: "resolved", personId: "per_umeda" });
  });

  it("lists bounded Graph SSOT people for task assignee selection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records: [
      { id: "per_umeda", payload: { name: "梅田 遼", aliases: ["Haruka Umeda"] } },
    ] }));
    await expect(listGraphPeople("proj_pms", { ...options, fetch: fetchImpl })).resolves.toEqual([
      { id: "per_umeda", name: "梅田 遼", aliases: ["Haruka Umeda"] },
    ]);
    const url = fetchImpl.mock.calls[0][0] as URL;
    expect(url.searchParams.get("project")).toBe("proj_pms");
  });

  it.each([
    [[], "unknown"],
    [[{ id: "p1", payload: { name: "梅田 遼" } }, { id: "p2", payload: { name: "梅田遼" } }], "ambiguous"],
  ])("fails closed for non-unique meeting assignee records", async (records, status) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records }));
    await expect(resolveGraphPersonByName("梅田 遼", "mana", { ...options, fetch: fetchImpl }))
      .resolves.toEqual({ status });
  });
});
