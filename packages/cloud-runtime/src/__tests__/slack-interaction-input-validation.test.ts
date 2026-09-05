import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  handleMeetingMinutesInteraction,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";

const secret = "secret";
const now = 1_786_420_000;

function signedRequest(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(now),
      "x-slack-signature": signature,
    },
  });
}

function basePayload(actionId: string, value: unknown) {
  return {
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1.1", thread_ts: "1.0" },
    response_url: "https://hooks.slack.com/actions/T1/B1/token",
    actions: [{ action_id: actionId, action_ts: "1.2", value: JSON.stringify(value) }],
  };
}

function effects(source: TenantInteractionIdentity): TenantInteractionEffects {
  return {
    tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    source,
    durableObject: async (_effectId, _target, execute) => execute({} as never),
    brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(fetch),
    slackDelivery: async (_effectId, _target, _event, execute) => execute(fetch),
  };
}

describe("signed Slack interaction input bounds", () => {
  it("rejects an invalid run id before resolving tenant effects or scheduling work", async () => {
    const resolveTenantEffects = vi.fn(async (source: TenantInteractionIdentity) => effects(source));
    const send = vi.fn();
    const defer = vi.fn();
    const response = await handleMeetingMinutesInteraction(signedRequest(basePayload(
      "mana_meeting_minutes_choose_destination:mana",
      { runId: `run_${"x".repeat(257)}`, destinationId: "mana", fileName: "meeting.txt" },
    )), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      destinations: [],
      resolveTenantEffects,
      send,
      defer,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "slack_interaction_invalid" });
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });

  it("rejects malformed task approval identifiers before tenant durable-object access", async () => {
    const resolveTenantEffects = vi.fn(async (source: TenantInteractionIdentity) => effects(source));
    const approveTaskWrite = vi.fn();
    const response = await handleMeetingMinutesInteraction(signedRequest(basePayload(
      "mana_task_write_approve",
      { approvalId: "../../arbitrary", payloadHash: "not-a-sha256" },
    )), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      resolveTenantEffects,
      send: vi.fn(),
      approveTaskWrite,
    });

    expect(response.status).toBe(400);
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(approveTaskWrite).not.toHaveBeenCalled();
  });

  it("rejects an invalid meeting task-card run id before resolving tenant effects", async () => {
    const resolveTenantEffects = vi.fn(async (source: TenantInteractionIdentity) => effects(source));
    const handleMeetingTaskAction = vi.fn();
    const response = await handleMeetingMinutesInteraction(signedRequest(basePayload(
      "mana_meeting_minutes_task_edit",
      {
        runId: `run_${"x".repeat(257)}`,
        index: 0,
        sourceWorkspaceId: "T1",
        sourceAppId: "A1",
        sourceChannelId: "C1",
        sourceThreadTs: "1.0",
      },
    )), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      resolveTenantEffects,
      send: vi.fn(),
      handleMeetingTaskAction,
    });

    expect(response.status).toBe(400);
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(handleMeetingTaskAction).not.toHaveBeenCalled();
  });
});
