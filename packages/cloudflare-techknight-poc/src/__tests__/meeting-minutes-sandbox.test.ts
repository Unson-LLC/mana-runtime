import { generateMeetingMinutesInSandbox } from "../meeting-minutes-generator.js";

describe("generateMeetingMinutesInSandbox", () => {
  it("uses the isolated prompt file and validates strict JSON", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: JSON.stringify({ title: "定例", overview: "概要", body: "本文" }), stderr: "" }), destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", { model: "opus", effort: "xhigh" }, sandbox))
      .resolves.toEqual({ title: "定例", overview: "概要", body: "本文" });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("transcript"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("< /tmp/meeting-minutes-prompt.txt"),
      expect.objectContaining({ env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" } }));
    expect(sandbox.destroy).toHaveBeenCalled();
  });
  it("destroys the Sandbox and rejects invalid model output", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true, stdout: "not-json", stderr: "" }), destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", { model: "opus", effort: "xhigh" }, sandbox))
      .rejects.toThrow("meeting_minutes_generation_invalid");
    expect(sandbox.destroy).toHaveBeenCalled();
  });
});
