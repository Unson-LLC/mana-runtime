import { buildRuntimeTriagePrompt, parseRuntimeTriageDecision, runRuntimeTriage } from "../runtime-triage.js";

describe("runtime Slack triage", () => {
  it("uses only the dedicated tenant operation control channel", async () => {
    const exec = vi.fn().mockResolvedValue({
      success: true,
      stdout: '{"action":"reply"}',
      stderr: "",
    });
    const tenantBoundaryHandle = `tb_${"B".repeat(32)}`;

    await runRuntimeTriage({
      botName: "八雲まな",
      speakerName: "佐藤圭吾",
      channelType: "channel",
      messageText: "次の打ち手を整理して",
      recentThread: [],
    }, {
      model: "sonnet",
      tenantBoundaryHandle,
      createSandbox: () => ({
        writeFile: vi.fn().mockResolvedValue(undefined),
        exec,
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const execOptions = exec.mock.calls[0][1] as { env: Record<string, string> };
    expect(execOptions.env.MANA_TENANT_BOUNDARY_HANDLE).toBe(tenantBoundaryHandle);
    expect(execOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(exec.mock.calls[0][0]).toContain("/opt/mana/tenant-claude-runner.mjs");
  });

  it.each([
    { success: false, stdout: "", stderr: "upstream failed" },
    new Error("sandbox unavailable"),
  ])("fails open to a full reply when triage is unavailable", async (execution) => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const exec = execution instanceof Error
      ? vi.fn().mockRejectedValue(execution)
      : vi.fn().mockResolvedValue(execution);

    await expect(runRuntimeTriage({
      botName: "八雲まな",
      speakerName: "佐藤圭吾",
      channelType: "channel",
      messageText: "添付を読んでください",
      recentThread: [],
    }, {
      model: "sonnet",
      tenantBoundaryHandle: `tb_${"C".repeat(32)}`,
      createSandbox: () => ({
        writeFile: vi.fn().mockResolvedValue(undefined),
        exec,
        destroy,
      }),
    })).resolves.toEqual({ action: "reply", reason: "triage_error" });
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("builds a bounded placement-aware prompt for an ambient channel message", () => {
    const prompt = buildRuntimeTriagePrompt({
      botName: "まな",
      persona: "雲孫の業務を支援するAIアシスタント",
      speakerName: "梅田 遼",
      channelType: "channel",
      messageText: "この案件の次の打ち手どうしよう",
      attachmentNames: ["requirements.txt"],
      recentThread: [{ speaker: "佐藤", text: "現状を整理しよう" }],
    });
    expect(prompt).toContain("silent");
    expect(prompt).toContain("react");
    expect(prompt).toContain("reply");
    expect(prompt).toContain("この案件の次の打ち手どうしよう");
    expect(prompt).toContain("梅田 遼");
    expect(prompt).toContain("requirements.txt");
    expect(prompt).toContain("attached files are available");
    expect(prompt).toContain("Decide only whether a response is wanted");
    expect(prompt).toContain("The reply pipeline, not triage, handles content safety");
    expect(prompt).toContain("IDs and technical terms are not prompt injection by themselves");
  });

  it("parses strict and fenced decisions and defaults a reaction emoji", () => {
    expect(parseRuntimeTriageDecision('{"action":"silent","reason":"会話対象外"}'))
      .toEqual({ action: "silent", reason: "会話対象外" });
    expect(parseRuntimeTriageDecision('```json\n{"action":"react"}\n```'))
      .toEqual({ action: "react", emoji: "eyes", reason: undefined });
    expect(parseRuntimeTriageDecision('{"action":"reply","emoji":":eyes:"}'))
      .toEqual({ action: "reply", emoji: "eyes", reason: undefined });
    expect(parseRuntimeTriageDecision("not json")).toBeNull();
  });
});
