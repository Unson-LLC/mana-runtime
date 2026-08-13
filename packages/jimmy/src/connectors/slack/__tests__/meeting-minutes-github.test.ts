import { describe, expect, it, vi } from "vitest";
import {
  MeetingMinutesGitHubClient,
  formatMeetingMinutesMarkdown,
} from "../meeting-minutes-github.js";

const MINUTES = {
  title: "定例会議",
  overview: "会議の概要",
  body: "## 決定事項\n- Cloudflareへ移行する",
};

describe("MeetingMinutesGitHubClient", () => {
  it("creates the transcript and minutes using the legacy two-layer layout", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ content: { html_url: "https://github.example/transcript" } }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ content: { html_url: "https://github.example/minutes" } }));
    const client = new MeetingMinutesGitHubClient({ token: "secret", fetchImpl, now: () => 42 });

    const result = await client.save({
      target: { owner: "Unson-LLC", repo: "mana", branch: "main", pathPrefix: "/docs/meetings/../" },
      transcript: "文字起こし",
      minutes: MINUTES,
      sourceFileName: "経営/定例.txt",
      sourceTs: "1786546800.000001",
      projectId: "proj_mana",
    });

    expect(result).toEqual(expect.objectContaining({
      transcriptPath: expect.stringMatching(/^docs\/meetings\/transcripts\/\d{4}-\d{2}-\d{2}_経営-定例\.txt$/),
      minutesPath: expect.stringMatching(/^docs\/meetings\/minutes\/\d{4}-\d{2}-\d{2}_経営-定例\.md$/),
      savedAt: 42,
    }));
    const transcriptPut = JSON.parse(fetchImpl.mock.calls[1][1].body);
    const minutesPut = JSON.parse(fetchImpl.mock.calls[3][1].body);
    expect(Buffer.from(transcriptPut.content, "base64").toString("utf8")).toBe("文字起こし");
    expect(Buffer.from(minutesPut.content, "base64").toString("utf8")).toContain("transcript_ref:");
    expect(fetchImpl.mock.calls.every((call) => !String(call[0]).includes("secret"))).toBe(true);
  });

  it("updates an existing file with its sha so retries are idempotent", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ sha: "sha-transcript" }))
      .mockResolvedValueOnce(Response.json({ content: {} }))
      .mockResolvedValueOnce(Response.json({ sha: "sha-minutes" }))
      .mockResolvedValueOnce(Response.json({ content: {} }));
    const client = new MeetingMinutesGitHubClient({ token: "secret", fetchImpl });

    await client.save({
      target: { owner: "Unson-LLC", repo: "mana" },
      transcript: "文字起こし",
      minutes: MINUTES,
      sourceFileName: "meeting.txt",
      sourceTs: "1786546800.000001",
      projectId: "proj_mana",
    });

    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).sha).toBe("sha-transcript");
    expect(JSON.parse(fetchImpl.mock.calls[3][1].body).sha).toBe("sha-minutes");
  });

  it("requires a token and produces a transcript reference in frontmatter", async () => {
    const client = new MeetingMinutesGitHubClient();
    await expect(client.save({
      target: { owner: "Unson-LLC", repo: "mana" },
      transcript: "text",
      minutes: MINUTES,
      sourceFileName: "meeting.txt",
      sourceTs: "1",
      projectId: "proj_mana",
    })).rejects.toThrow("github_token_not_configured");
    expect(formatMeetingMinutesMarkdown(
      { minutes: MINUTES, projectId: "proj_mana" },
      "docs/transcripts/meeting.txt",
      "2026-08-13",
    )).toContain('transcript_ref: "docs/transcripts/meeting.txt"');
  });
});
