import { MeetingMinutesSlackClient } from "../meeting-minutes-slack.js";

describe("MeetingMinutesSlackClient", () => {
  it("uses a unique action_id for every destination button", async () => {
    let body: { blocks?: Array<{ elements?: Array<{ action_id?: string }> }> } = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const run = { version: 1 as const, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
      sourceThreadTs: "1.0", sourceMessageTs: "1.0", file: { id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 10 },
      status: "awaiting_destination" as const, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };
    const destinations = [
      { id: "one", projectId: "p1", name: "One", slackChannelId: "C2", github: { owner: "o", repo: "r", pathPrefix: "meetings" } },
      { id: "two", projectId: "p2", name: "Two", slackChannelId: "C3", github: { owner: "o", repo: "r", pathPrefix: "meetings" } },
    ];
    await new MeetingMinutesSlackClient("token", fetchImpl).requestDestination(run, destinations);
    const ids = body.blocks?.flatMap((block) => block.elements ?? []).map((element) => element.action_id);
    expect(ids).toEqual(["mana_meeting_minutes_choose_destination:one", "mana_meeting_minutes_choose_destination:two"]);
  });

  it("invokes fetch with the Workers global receiver", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error("illegal receiver");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 }));
    });
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postParent("C1", "test", "receiver-test"))
      .resolves.toBe("1.2");
  });

  it("refetches the private URL and downloads a bounded text file", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("files.info")
      ? Response.json({ ok: true, file: { name: "meeting.txt", mimetype: "text/plain", size: 5,
        url_private_download: "https://files.slack.test/private" } })
      : new Response("hello")) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("xoxb-token", fetchImpl).downloadTextFile("F1")).resolves.toBe("hello");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://files.slack.test/private",
      expect.objectContaining({ headers: { Authorization: "Bearer xoxb-token" } }));
  });

  it("uses a deterministic UUID client_msg_id for retry-safe posts", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    await client.postParent("C1", "text", "run-parent"); await client.postParent("C1", "text", "run-parent");
    const ids = bodies.map((body) => (body as { client_msg_id: string }).client_msg_id);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).toBe(ids[1]);
  });
});
