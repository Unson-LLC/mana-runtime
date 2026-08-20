import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleManaImprovementInteraction,
  manaImprovementModalMetadata,
} from "../mana-improvement-slack.js";

const secret = "secret";
const nowMs = 1_786_680_000_000;
const timestamp = String(nowMs / 1000);

function signedRequest(payload: Record<string, unknown>): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://runtime.test/slack/interactions", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

function improvementPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "view_submission",
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    view: {
      id: "V1",
      callback_id: "mana_improvement_request_v1",
      private_metadata: manaImprovementModalMetadata({
        workspaceId: "T1",
        channelId: "C1",
        requesterId: "U1",
        command: "/vibepro",
      }),
      state: {
        values: {
          mana_improvement_problem: { value: { value: "承認待ちが分からない" } },
          mana_improvement_outcome: { value: { value: "一覧で担当者が分かる" } },
          mana_improvement_examples: { value: { value: "1人の場合\n複数の場合" } },
          mana_improvement_references: { value: { value: "https://example.test/thread" } },
          mana_improvement_effect: { value: { selected_option: { value: "isolated_change" } } },
        },
      },
    },
    ...overrides,
  };
}

describe("Mana improvement Slack interaction", () => {
  it("acks immediately and defers a canonical structured request", async () => {
    const accept = vi.fn(async () => undefined);
    let deferred: Promise<void> | undefined;
    const response = await handleManaImprovementInteraction(signedRequest(improvementPayload()), {
      signingSecret: secret,
      expectedAppId: "A1",
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      accept,
      defer: (work) => { deferred = work; },
    });
    expect(response?.status).toBe(200);
    await deferred;
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      appId: "A1",
      workspaceId: "T1",
      channelId: "C1",
      requesterId: "U1",
      interactionThreadTs: "V1",
      request: expect.objectContaining({
        problem: "承認待ちが分からない",
        desiredOutcome: "一覧で担当者が分かる",
        allowedEffect: "isolated_change",
      }),
    }));
  });

  it("returns null for another Slack view so the existing handler can continue", async () => {
    const payload = improvementPayload();
    (payload.view as Record<string, unknown>).callback_id = "another_view";
    const response = await handleManaImprovementInteraction(signedRequest(payload), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      accept: vi.fn(),
    });
    expect(response).toBeNull();
  });

  it("fails closed when private metadata and authenticated requester disagree", async () => {
    const payload = improvementPayload({ user: { id: "U2" } });
    const accept = vi.fn();
    const response = await handleManaImprovementInteraction(signedRequest(payload), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1", "U2"] }],
      nowMs,
      accept,
    });
    expect(response?.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });

  it("returns field errors instead of queueing an incomplete request", async () => {
    const payload = improvementPayload();
    const values = ((payload.view as Record<string, unknown>).state as Record<string, unknown>).values as Record<string, unknown>;
    values.mana_improvement_outcome = { value: { value: "" } };
    const accept = vi.fn();
    const response = await handleManaImprovementInteraction(signedRequest(payload), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      accept,
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      response_action: "errors",
      errors: { mana_improvement_outcome: "必須項目を入力してください。" },
    });
    expect(accept).not.toHaveBeenCalled();
  });
});
