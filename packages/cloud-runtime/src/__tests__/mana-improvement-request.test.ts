import { describe, expect, it } from "vitest";
import {
  MANA_IMPROVEMENT_SCHEMA,
  buildManaImprovementAcceptanceMessage,
  buildManaImprovementModal,
  extractManaImprovementRequestFromView,
  normalizeManaImprovementRequest,
  serializeManaImprovementRequest,
} from "../mana-improvement-request.js";

describe("Mana improvement request", () => {
  it("normalizes a non-engineer request into a bounded execution contract", () => {
    const request = normalizeManaImprovementRequest({
      problem: " 承認待ちの担当者が一覧で分からない ",
      desiredOutcome: " 一覧だけで次の承認者が分かる ",
      acceptanceExamples: "- 1人の場合\n- 複数人の場合",
      references: "https://example.test/thread\n#backoffice",
      allowedEffect: "isolated_change",
    });
    expect(request).toEqual({
      schema: MANA_IMPROVEMENT_SCHEMA,
      problem: "承認待ちの担当者が一覧で分からない",
      desiredOutcome: "一覧だけで次の承認者が分かる",
      acceptanceExamples: ["1人の場合", "複数人の場合"],
      references: ["https://example.test/thread", "#backoffice"],
      allowedEffect: "isolated_change",
    });
    expect(serializeManaImprovementRequest(request)).toContain("merge、deploy、secret変更");
  });

  it("builds a Slack modal without exposing repository, branch, Story, or Gate fields", () => {
    const view = buildManaImprovementModal({
      privateMetadata: JSON.stringify({ workspaceId: "T1", channelId: "C1", requesterId: "U1", command: "/vibepro" }),
      initialProblem: "請求確認が分かりにくい",
    });
    const serialized = JSON.stringify(view);
    expect(serialized).toContain("困っていること");
    expect(serialized).toContain("どうなればよいか");
    expect(serialized).not.toContain("repository");
    expect(serialized).not.toContain("branch");
    expect(serialized).not.toContain("Story ID");
    expect(serialized).not.toContain("Gate");
  });

  it("extracts required values from a Slack view state", () => {
    const request = extractManaImprovementRequestFromView({
      mana_improvement_problem: { value: { value: "問題" } },
      mana_improvement_outcome: { value: { value: "完了状態" } },
      mana_improvement_examples: { value: { value: "例1\n例2" } },
      mana_improvement_references: { value: { value: "https://example.test" } },
      mana_improvement_effect: { value: { selected_option: { value: "investigate_only" } } },
    });
    expect(request.allowedEffect).toBe("investigate_only");
    expect(request.acceptanceExamples).toEqual(["例1", "例2"]);
  });

  it("escapes Slack mention syntax in the acceptance card", () => {
    const request = normalizeManaImprovementRequest({
      problem: "<!channel> を含む入力",
      desiredOutcome: "<@U_ATTACK> を通知しない",
    });
    const message = buildManaImprovementAcceptanceMessage(request, "U1");
    expect(message.text).toContain("&lt;!channel&gt;");
    expect(JSON.stringify(message.blocks)).toContain("&lt;@U_ATTACK&gt;");
    expect(JSON.stringify(message.blocks)).toContain("<@U1>");
  });

  it("requires both the problem and desired outcome", () => {
    expect(() => normalizeManaImprovementRequest({ problem: "", desiredOutcome: "x" }))
      .toThrow("mana_improvement_problem_required");
    expect(() => normalizeManaImprovementRequest({ problem: "x", desiredOutcome: "" }))
      .toThrow("mana_improvement_outcome_required");
  });
});
