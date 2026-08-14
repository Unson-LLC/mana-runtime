import { CloudflareMeetingMinutesGitHubClient } from "../meeting-minutes-github.js";

const destination = { id: "mana", projectId: "mana", name: "mana", organization: { id: "unson", name: "雲孫" }, slackChannelId: "C1",
  github: { owner: "Unson-LLC", repo: "mana", branch: "main", pathPrefix: "docs" } };

describe("CloudflareMeetingMinutesGitHubClient", () => {
  it("invokes fetch with the Workers global receiver", async () => {
    const fetchImpl = vi.fn(function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) throw new Error("illegal receiver");
      return Promise.resolve(String(input).includes("?ref=")
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ content: { html_url: "https://github.test/file" } }), { status: 201 }));
    });
    await expect(new CloudflareMeetingMinutesGitHubClient("token", fetchImpl).save({
      destination, transcript: "x", minutes: { title: "t", overview: "o", body: "b" }, sourceFileName: "a.txt", sourceTs: "1",
    })).resolves.toBeDefined();
  });

  it("stores transcript then minutes with JST paths and existing SHA", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (!init?.method) return Response.json({ sha: "existing" });
      return Response.json({ content: { html_url: `https://github.test/${calls.length}` } });
    }) as typeof fetch;
    const result = await new CloudflareMeetingMinutesGitHubClient("token", fetchImpl).save({ destination,
      transcript: "こんにちは", minutes: { title: "定例", overview: "概要", body: "本文" }, sourceFileName: "定例.txt",
      sourceTs: "1786345216.318499" });
    expect(result.transcriptPath).toMatch(/^docs\/transcripts\/2026-08-10_/);
    expect(result.minutesPath).toMatch(/^docs\/minutes\/2026-08-10_/);
    const puts = calls.filter((call) => call.init?.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(JSON.parse(String(puts[0]!.init!.body))).toMatchObject({ sha: "existing", branch: "main" });
    const markdown = Buffer.from(JSON.parse(String(puts[1]!.init!.body)).content, "base64").toString("utf8");
    expect(markdown).toContain(`transcript_ref: "${result.transcriptPath}"`);
  });

  it("does not write minutes when transcript save fails", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? new Response("", { status: 500 }) : new Response("", { status: 404 })) as typeof fetch;
    await expect(new CloudflareMeetingMinutesGitHubClient("token", fetchImpl).save({ destination, transcript: "x",
      minutes: { title: "t", overview: "o", body: "b" }, sourceFileName: "a.txt", sourceTs: "1" }))
      .rejects.toThrow("github_write_failed:500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
