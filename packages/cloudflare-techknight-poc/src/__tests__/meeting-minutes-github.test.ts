import { CloudflareMeetingMinutesGitHubClient, formatCloudflareMeetingMinutesMarkdown } from "../meeting-minutes-github.js";

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

  it("renders exactly one deterministic action-item section from tasks", () => {
    const markdown = formatCloudflareMeetingMinutesMarkdown({ destination, transcript: "x", sourceFileName: "a.txt", sourceTs: "1",
      minutes: { title: "定例", overview: "概要", body: "本文\n\n*アクションアイテム*\n- 古い重複内容",
        brainbase_context_receipt_id: "receipt-1", brainbase_context_checksum: "checksum-1",
        used_source_refs: [{ type: "graph_entity", id: "project-mana" }], tasks: [
        { title: "資料を送る", description: "会議で合意", assignee_name: "梅田 遼", priority: "high",
          due_at: "2026-08-20T00:00:00+09:00" },
      ] } }, "docs/transcripts/a.txt", "2026-08-14");
    expect(markdown.match(/## アクションアイテム/g)).toHaveLength(1);
    expect(markdown).not.toContain("古い重複内容");
    expect(markdown).toContain("- [ ] 資料を送る（担当: 梅田 遼 / 期限: 2026-08-20 / 優先度: high）");
    expect(markdown).toContain("  - 背景: 会議で合意");
    expect(markdown).toContain('brainbase_context_receipt: "receipt-1"');
    expect(markdown).toContain('brainbase_context_checksum: "checksum-1"');
    expect(markdown).toContain('brainbase_source_refs: [{"type":"graph_entity","id":"project-mana"}]');
  });

  it("renders an explicit empty action-item section when tasks are empty", () => {
    const markdown = formatCloudflareMeetingMinutesMarkdown({ destination, transcript: "x", sourceFileName: "a.txt", sourceTs: "1",
      minutes: { title: "定例", overview: "概要", body: "本文", tasks: [] } }, "docs/transcripts/a.txt", "2026-08-14");
    expect(markdown).toContain("## アクションアイテム\n\n- なし");
  });

  it("does not write minutes when transcript save fails", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? new Response("", { status: 500 }) : new Response("", { status: 404 })) as typeof fetch;
    await expect(new CloudflareMeetingMinutesGitHubClient("token", fetchImpl).save({ destination, transcript: "x",
      minutes: { title: "t", overview: "o", body: "b" }, sourceFileName: "a.txt", sourceTs: "1" }))
      .rejects.toThrow("github_write_failed:500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("deletes only the persisted record paths with their current SHA", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return init?.method === "DELETE" ? new Response(null, { status: 200 }) : Response.json({ sha: "sha-1" });
    }) as typeof fetch;
    await new CloudflareMeetingMinutesGitHubClient("token", fetchImpl)
      .delete(destination.github, ["docs/transcripts/a.txt", "docs/minutes/a.md"]);
    const deletes = calls.filter((call) => call.init?.method === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(deletes.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/Unson-LLC/mana/contents/docs/transcripts/a.txt",
      "https://api.github.com/repos/Unson-LLC/mana/contents/docs/minutes/a.md",
    ]);
    expect(JSON.parse(String(deletes[0]?.init?.body))).toMatchObject({ sha: "sha-1", branch: "main" });
  });

  it("treats already missing GitHub records as a completed deletion", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as typeof fetch;
    await expect(new CloudflareMeetingMinutesGitHubClient("token", fetchImpl)
      .delete(destination.github, ["docs/minutes/a.md"])).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
