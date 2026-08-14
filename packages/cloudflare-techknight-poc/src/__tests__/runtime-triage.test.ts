import { buildRuntimeTriagePrompt, parseRuntimeTriageDecision } from "../runtime-triage.js";

describe("runtime Slack triage", () => {
  it("builds a bounded placement-aware prompt for an ambient channel message", () => {
    const prompt = buildRuntimeTriagePrompt({
      botName: "まな",
      persona: "雲孫の業務を支援するAIアシスタント",
      speakerName: "梅田 遼",
      channelType: "channel",
      messageText: "この案件の次の打ち手どうしよう",
      recentThread: [{ speaker: "佐藤", text: "現状を整理しよう" }],
    });
    expect(prompt).toContain("silent");
    expect(prompt).toContain("react");
    expect(prompt).toContain("reply");
    expect(prompt).toContain("この案件の次の打ち手どうしよう");
    expect(prompt).toContain("梅田 遼");
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
