import { classifyMeetingMinutesDestinationInSandbox, generateMeetingMinutesInSandbox,
  parseGeneratedMeetingMinutesOutput, parseMeetingMinutesRoutingOutput } from "../meeting-minutes-generator.js";

const destinations = [
  { id: "sales-tailor", projectId: "proj_salestailor", name: "SalesTailor",
    organization: { id: "unson", name: "雲孫" }, slackChannelId: "C1", github: { owner: "o", repo: "r" } },
  { id: "united", projectId: "proj_united", name: "United",
    organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2", github: { owner: "o", repo: "r2" } },
];

describe("generateMeetingMinutesInSandbox", () => {
  it("uses the isolated prompt file and validates strict JSON", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: JSON.stringify({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20" },
      ] }), stderr: "" }), destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", { model: "opus", effort: "xhigh" }, sandbox))
      .resolves.toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20T00:00:00+09:00" },
      ] });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("transcript"));
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("narrative_minutes.v1"),
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("アクションアイテム"),
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining('"tasks"'),
    );
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("< /tmp/meeting-minutes-prompt.txt"),
      expect.objectContaining({
        timeout: 600_000,
        env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
      }));
    expect(sandbox.destroy).toHaveBeenCalled();
  });
  it("destroys the Sandbox and rejects invalid model output", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true, stdout: "not-json", stderr: "" }), destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", { model: "opus", effort: "xhigh" }, sandbox))
      .rejects.toThrow("meeting_minutes_generation_invalid");
    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it("recovers JSON from Claude prose and a markdown fence", () => {
    expect(parseGeneratedMeetingMinutesOutput([
      "議事録を作成しました。", "```json",
      JSON.stringify({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
      "```",
    ].join("\n"))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
  });

  it("accepts Claude JSON envelopes and omitted empty tasks", () => {
    expect(parseGeneratedMeetingMinutesOutput(JSON.stringify({
      type: "result", result: JSON.stringify({ title: "定例", overview: "概要", body: "本文" }),
    }))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
    expect(parseGeneratedMeetingMinutesOutput(JSON.stringify({
      structured_output: { title: "定例", overview: "概要", body: "本文", tasks: [] },
    }))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
  });
});

describe("classifyMeetingMinutesDestinationInSandbox", () => {
  it("accepts only a configured project and preserves the reason", () => {
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"proj_salestailor","reason":"商談内容が一致"}', destinations))
      .toEqual({ destinationId: "sales-tailor", reason: "商談内容が一致" });
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"unknown","reason":"候補外"}', destinations)).toBeNull();
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"不明","reason":"判断不能"}', destinations)).toBeNull();
  });

  it("neutralizes Slack mentions, active links, and control characters in the routing reason", () => {
    expect(parseMeetingMinutesRoutingOutput(
      '{"projectId":"proj_salestailor","reason":"<!channel> <@U123> <https://evil.test>\\u0007"}', destinations,
    )).toEqual({ destinationId: "sales-tailor",
      reason: "&lt;!channel> &lt;@U123> &lt;https://evil.test> " });
  });

  it("classifies a bounded transcript in an isolated Sandbox", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: '{"projectId":"proj_united","reason":"ホテルUnitedの定例"}', stderr: "" }),
    destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(classifyMeetingMinutesDestinationInSandbox("transcript", destinations,
      { model: "opus", effort: "xhigh" }, sandbox))
      .resolves.toEqual({ destinationId: "united", reason: "ホテルUnitedの定例" });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("候補のどれとも確信を持って一致しない場合"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("< /tmp/meeting-minutes-prompt.txt"),
      expect.objectContaining({ timeout: 60_000 }));
    expect(sandbox.destroy).toHaveBeenCalled();
  });
});
