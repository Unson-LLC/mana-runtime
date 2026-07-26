import { describe, expect, it } from "vitest";
import {
  buildCriticalReviewPrompt,
  classifyCriticalTask,
} from "../critical-routing.js";

describe("classifyCriticalTask", () => {
  it.each([
    "critical-reviewerに委譲して、結果を統合して",
    "これは重要な判断なのでOpus/xhighでレビューして",
    "本番環境の認証トークンを変更して",
    "Please review and approve this high-impact architecture decision",
    "Publish this customer-facing final deliverable",
  ])("routes critical work: %s", (text) => {
    expect(classifyCriticalTask(text).critical).toBe(true);
  });

  it.each([
    "今日の会議を要約して",
    "本番デプロイの状況を確認して",
    "セキュリティ方針を要約して",
    "アーキテクチャ資料の誤字を直して",
    "顧客向け文章の下書きを作って",
  ])("keeps routine work on the parent: %s", (text) => {
    expect(classifyCriticalTask(text)).toEqual({ critical: false });
  });

  it("classifies empty input as routine", () => {
    expect(classifyCriticalTask("   ")).toEqual({ critical: false });
  });
});

describe("buildCriticalReviewPrompt", () => {
  it("preserves the original request and forbids direct Slack delivery", () => {
    const prompt = buildCriticalReviewPrompt("重要な設計判断をレビューして");

    expect(prompt).toContain("重要な設計判断をレビューして");
    expect(prompt).toContain("Do not contact Slack directly");
    expect(prompt).toContain("parent can integrate");
  });
});
