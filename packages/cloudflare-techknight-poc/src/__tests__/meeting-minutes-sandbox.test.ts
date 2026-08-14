import { generateMeetingMinutesInSandbox, parseGeneratedMeetingMinutesOutput } from "../meeting-minutes-generator.js";

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
