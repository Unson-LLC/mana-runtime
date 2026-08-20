import { describe, expect, it, vi } from "vitest";
import {
  handleDevelopmentCallback,
  parseDevelopmentCallbackPayload,
  renderDevelopmentResult,
} from "../development-callback.js";

const placement = {
  placementId: "mana-dev-biz",
  channelId: "C1",
  projectCodes: ["mana"],
  taskWriteEnabled: true,
  developmentEnabled: true,
  audience: { type: "operator" as const, allowedUserIds: ["U1"] },
  deliveryScopes: [{ connector: "slack" as const, channelId: "C1" }],
};
const base = {
  job_id: "job_1",
  event_id: "Ev1",
  placement_id: "mana-dev-biz",
  workspace_id: "T1",
  channel_id: "C1",
  thread_ts: "1.0",
  requester_id: "U1",
  summary: "進行中",
  quota_decision: "allowed",
};
function request(body: Record<string, unknown>) {
  return new Request("https://worker.test/development/callback", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function options(overrides: Record<string, unknown> = {}) {
  return {
    token: "secret",
    placements: [placement],
    resolve: async (event: Record<string, unknown>) => ({ ...event, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    claim: vi.fn(async () => ({ state: "claimed" as const })),
    recordDelivery: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    post: vi.fn(async (_event: unknown, _text: string, _blocks?: unknown[]) => "2.0"),
    ...overrides,
  };
}

describe("development callback non-engineer UX", () => {
  it("updates the real root message for progress without claiming terminal completion", async () => {
    const update = vi.fn(async (_event: unknown, _text: string, _blocks?: unknown[]) => undefined);
    const configured = options({ update });
    const response = await handleDevelopmentCallback(request({
      ...base,
      status: "progress",
      progress: { phase: "implementing", elapsed_sec: 125, commits: 2, latest: "feat: show approver" },
    }), configured);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, state: "progress" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "development-progress:job_1", threadTs: "1.0" }),
      expect.stringContaining("現在: 変更中"),
      expect.any(Array),
    );
    expect(configured.claim).not.toHaveBeenCalled();
    expect(configured.post).not.toHaveBeenCalled();
  });

  it("renders human questions and Mana's recommendation instead of raw status text", async () => {
    const payload = parseDevelopmentCallbackPayload({
      ...base,
      status: "needs_decision",
      story_id: "story-1",
      summary: "表示方法を確定する必要があります",
      questions: [{
        id: "display",
        question: "承認者が複数いる場合、どう表示しますか？",
        options: [
          { label: "全員を表示", description: "次に動ける人が分かる", recommended: true },
          { label: "先頭だけ表示" },
        ],
        allow_free_text: true,
      }],
    });
    expect(payload).toBeDefined();
    const message = renderDevelopmentResult(payload!);
    expect(message.text).toContain("改善を続けるために判断が必要");
    expect(JSON.stringify(message.blocks)).toContain("Manaの推奨");
    expect(JSON.stringify(message.blocks)).not.toContain("Development: needs_decision");
  });

  it("shows accomplishments and remaining checks for needs_input", () => {
    const payload = parseDevelopmentCallbackPayload({
      ...base,
      status: "needs_input",
      story_id: "story-2",
      summary: "変更は完了しましたが、E2E証拠が不足しています",
      gates: [{ severity: "evidence", text: "production E2E required" }],
      commits: { count: 3, subjects: ["feat: one", "test: two"] },
    });
    const message = renderDevelopmentResult(payload!);
    expect(message.text).toContain("改善は進みました");
    expect(JSON.stringify(message.blocks)).toContain("ここまでの変更");
    expect(JSON.stringify(message.blocks)).toContain("残っている確認");
  });

  it("rejects malformed structured fields instead of trusting runner output", () => {
    expect(parseDevelopmentCallbackPayload({
      ...base,
      status: "needs_decision",
      questions: [{ id: "bad id", question: "x", options: [], allow_free_text: true }],
    })).toBeUndefined();
    expect(parseDevelopmentCallbackPayload({
      ...base,
      status: "progress",
      progress: { phase: "unknown", elapsed_sec: 1, commits: 0 },
    })).toBeUndefined();
  });
});
