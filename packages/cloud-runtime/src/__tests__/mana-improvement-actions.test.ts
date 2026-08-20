import { describe, expect, it } from "vitest";
import {
  buildContinueGatesActionValue,
  buildResumeRecommendedActionValue,
  parseManaImprovementContinuationAction,
  recommendedDevelopmentAnswers,
} from "../mana-improvement-actions.js";

const storyId = "story-slack-20260821010101-abcd1234";

describe("Mana improvement continuation actions", () => {
  it("selects an explicit recommendation for every question", () => {
    const answers = recommendedDevelopmentAnswers([
      {
        id: "display",
        question: "どう表示しますか",
        options: [
          { label: "全員を表示", recommended: true },
          { label: "先頭だけ" },
        ],
        allow_free_text: true,
      },
      {
        id: "order",
        question: "順序はどうしますか",
        options: [{ label: "期限順" }],
        allow_free_text: false,
      },
    ]);
    expect(answers).toEqual([
      { id: "display", answer: "全員を表示" },
      { id: "order", answer: "期限順" },
    ]);
  });

  it("does not guess when a question has multiple choices and no recommendation", () => {
    expect(recommendedDevelopmentAnswers([{
      id: "display",
      question: "どう表示しますか",
      options: [{ label: "A" }, { label: "B" }],
      allow_free_text: false,
    }])).toBeUndefined();
  });

  it("round-trips recommended resume and Gate continuation action values", () => {
    const resume = buildResumeRecommendedActionValue({
      storyId,
      answers: [{ id: "display", answer: "全員を表示" }],
    });
    expect(parseManaImprovementContinuationAction(resume)).toEqual({
      version: 1,
      kind: "resume_recommended",
      storyId,
      answers: [{ id: "display", answer: "全員を表示" }],
    });

    const gates = buildContinueGatesActionValue(storyId);
    expect(parseManaImprovementContinuationAction(gates)).toEqual({
      version: 1,
      kind: "continue_gates",
      storyId,
    });
  });

  it("rejects forged or oversized action values", () => {
    expect(() => parseManaImprovementContinuationAction('{"version":1,"kind":"continue_gates","storyId":"bad"}'))
      .toThrow("mana_improvement_action_invalid");
    expect(() => parseManaImprovementContinuationAction("x".repeat(2_000)))
      .toThrow("mana_improvement_action_invalid");
  });
});
