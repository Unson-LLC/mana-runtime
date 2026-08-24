import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteraction,
  isTenantFailureResponseUrlEligible,
  updateSlackInteractionMessage,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";
import { MAX_SLACK_REQUEST_BODY_BYTES } from "../slack-request-body.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";

const secret = "secret"; const now = 1_786_420_000;
function request(payload: unknown): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;
  return new Request("https://worker/slack/interactions", { method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(now), "x-slack-signature": signature } });
}
const payload = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
  message: { ts: "1.1", thread_ts: "1.0" },
  response_url: "https://hooks.slack.com/actions/T1/B1/token",
  actions: [{ action_id: "mana_meeting_minutes_choose_destination", action_ts: "1.2",
    value: JSON.stringify({ runId: "Ev1_F1", destinationId: "mana", fileName: "meeting.txt" }) }] };
const destinations = [
  { id: "mana", projectId: "p1", contextProjectCode: "back-office", taskProjectCodes: ["back-office"],
    taskBoardTargetId: "minutes-back-office", name: "Back Office", organization: { id: "unson-business", name: "雲孫 事業運営" },
    slackChannelId: "C2", github: { owner: "Unson-LLC", repo: "back_office" } },
  { id: "board", projectId: "p2", contextProjectCode: "techknight", taskProjectCodes: ["techknight"],
    taskBoardTargetId: "minutes-board", name: "ボード定例", organization: { id: "tech-knight", name: "Tech Knight" },
    slackChannelId: "C3", github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" } },
];
const tenantBoundary = {
  resolveTenantEffects: async (source: TenantInteractionIdentity): Promise<TenantInteractionEffects> => {
    const credentialFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    return {
      tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source,
      durableObject: async (_effectId, _target, execute) => execute(),
      brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(credentialFetch),
      slackDelivery: async (_effectId, _target, _event, execute) => execute(credentialFetch),
    };
  },
};

describe("handleMeetingMinutesInteraction", () => {
  function deferred() { const work: Promise<void>[] = []; return { work, defer: (promise: Promise<void>) => { work.push(promise); } }; }
  it("rejects an oversized declared body before signature verification or tenant resolution", async () => {
    const send = vi.fn();
    const resolveTenantEffects = vi.fn(tenantBoundary.resolveTenantEffects);
    const oversized = new Request("https://worker/slack/interactions", {
      method: "POST",
      headers: {
        "content-length": String(MAX_SLACK_REQUEST_BODY_BYTES + 1),
        "x-slack-request-timestamp": String(now),
        "x-slack-signature": "v0=not-a-valid-signature",
      },
      body: "payload=%7B%7D",
    });

    const result = await handleMeetingMinutesInteraction(oversized, {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
    });

    expect(result.status).toBe(413);
    await expect(result.json()).resolves.toEqual({ error: "slack_request_body_too_large" });
    expect(resolveTenantEffects).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts destination-qualified action ids", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const qualifiedPayload = structuredClone(payload);
    qualifiedPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_destination:mana";
    const result = await handleMeetingMinutesInteraction(request(qualifiedPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(updateOriginal).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      text: "meeting.txt の保存先に Back Office を選択しました。",
    }), expect.any(Function));
  });

  it("verifies and queues an authorized selection", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn(); const showProcessing = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledWith(expect.objectContaining({
      runId: "Ev1_F1", destinationId: "mana", threadTs: "1.0",
    }));
    expect(updateOriginal).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      text: "meeting.txt の保存先に Back Office を選択しました。",
    }), expect.any(Function));
    expect(showProcessing).toHaveBeenCalledWith(
      { channelId: "C1", threadTs: "1.0", destinationName: "Back Office" }, expect.any(Function));
    expect(showProcessing.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(await response.json()).toEqual({ ok: true });
  });
  it("converts a meeting task handler rejection into one safe failure response and does not double-handle", async () => {
    const taskPayload = structuredClone(payload);
    taskPayload.actions[0]!.action_id = "mana_meeting_minutes_task_edit";
    taskPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", index: 0, fileName: "meeting.txt",
      organizationId: "unson-business", projectId: "p1", channelId: "C1", sourceWorkspaceId: "T1",
      sourceAppId: "A1", sourceChannelId: "C1", sourceThreadTs: "1.0" });
    const handleMeetingTaskAction = vi.fn().mockRejectedValue(new Error("raw Bearer secret"));
    const handleContractLedgerAction = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const result = await handleMeetingMinutesInteraction(request(taskPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send: vi.fn(), updateOriginal, defer: background.defer,
      handleMeetingTaskAction, handleContractLedgerAction });

    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toMatchObject({ error: "temporary_failure",
      message_key: "tenant.temporary_failure", next_actions: ["retry_later"],
      correlation_id: expect.stringMatching(/^cor_[0-9A-HJKMNP-TV-Z]{26}$/) });
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(handleMeetingTaskAction).toHaveBeenCalledOnce();
    expect(handleContractLedgerAction).not.toHaveBeenCalled();
    const projected = JSON.stringify(updateOriginal.mock.calls[0]?.[1]);
    expect(updateOriginal).toHaveBeenCalledOnce();
    expect(projected).toContain("処理ID: Ev1_F1");
    expect(projected).toContain("失敗段階: 操作処理");
    expect(projected).toContain("エラーコード: temporary_failure");
    expect(projected).toContain("問い合わせID: cor_");
    expect(projected).not.toContain("Bearer secret");
  });
  it("converts a contract handler rejection into a safe envelope and rejects an untrusted response_url", async () => {
    const contractPayload = structuredClone(payload);
    contractPayload.response_url = "https://example.com/actions/not-a-slack-capability";
    contractPayload.actions[0]!.action_id = "mana_contract_ledger_approve";
    contractPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt", envelopeId: "env_1" });
    const handleMeetingTaskAction = vi.fn().mockResolvedValue(undefined);
    const handleContractLedgerAction = vi.fn().mockRejectedValue(new Error("raw Bearer secret"));
    const updateOriginal = vi.fn();
    const send = vi.fn();
    const background = deferred();
    const result = await handleMeetingMinutesInteraction(request(contractPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer,
      handleMeetingTaskAction, handleContractLedgerAction });

    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toMatchObject({ error: "temporary_failure",
      message_key: "tenant.temporary_failure", next_actions: ["retry_later"],
      correlation_id: expect.stringMatching(/^cor_[0-9A-HJKMNP-TV-Z]{26}$/) });
    await expect(Promise.all(background.work)).resolves.toEqual([]);
    expect(handleMeetingTaskAction).toHaveBeenCalledOnce();
    expect(handleContractLedgerAction).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).not.toHaveBeenCalled();
  });
  it("replaces the selector with projects for the chosen organization without queueing", async () => {
    const organizationPayload = structuredClone(payload);
    organizationPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_organization:tech-knight";
    organizationPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", organizationId: "tech-knight",
      fileName: "定例.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(organizationPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      text: "定例.txt の保存先プロジェクトを選択してください。",
    }), expect.any(Function));
    const message = updateOriginal.mock.calls[0]?.[1];
    expect(JSON.stringify(message)).toContain("ボード定例");
    expect(JSON.stringify(message)).not.toContain("Back Office");
    expect(JSON.stringify(message)).toContain("組織選択に戻る");
  });
  it("uses a bounded public fallback when the organization selector projection fails", async () => {
    const organizationPayload = structuredClone(payload);
    organizationPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_organization:tech-knight";
    organizationPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", organizationId: "tech-knight",
      fileName: "定例.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("selector unavailable"))
      .mockResolvedValueOnce(undefined); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(organizationPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("STATUS_PROJECTION_FAILED");
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("処理ID: Ev1_F1");
  });
  it("returns to the organization selector without queueing", async () => {
    const backPayload = structuredClone(payload);
    backPayload.actions[0]!.action_id = "mana_meeting_minutes_back_to_organizations";
    backPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "定例.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(backPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("雲孫 事業運営");
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("Tech Knight");
  });
  it("uses a bounded fallback when the back-action projection fails", async () => {
    const backPayload = structuredClone(payload);
    backPayload.actions[0]!.action_id = "mana_meeting_minutes_back_to_organizations";
    backPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "定例.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("selector unavailable"))
      .mockResolvedValueOnce(undefined); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(backPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("STATUS_PROJECTION_FAILED");
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("処理ID: Ev1_F1");
  });
  it("rejects an unknown organization without updating or queueing", async () => {
    const unknownPayload = structuredClone(payload);
    unknownPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_organization:unknown";
    unknownPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", organizationId: "unknown", fileName: "定例.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(unknownPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(400); expect(background.work).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); expect(updateOriginal).not.toHaveBeenCalled();
  });
  it("rejects action ids that disagree with their signed selection value", async () => {
    const mismatchedPayload = structuredClone(payload);
    mismatchedPayload.actions[0]!.action_id = "mana_meeting_minutes_choose_destination:board";
    const send = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(mismatchedPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, defer: background.defer });
    expect(response.status).toBe(400); expect(send).not.toHaveBeenCalled(); expect(background.work).toHaveLength(0);
  });
  it("queues even when Slack did not provide a response URL", async () => {
    const invalid = { ...payload, response_url: "https://example.com/actions/token" };
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(invalid), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary, send, updateOriginal, defer: background.defer });
    await Promise.all(background.work);
    expect(response.status).toBe(200); expect(send).toHaveBeenCalledOnce(); expect(updateOriginal).not.toHaveBeenCalled();
  });
  it("clears processing when the queue rejects the selection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue Authorization Bearer secret")); const updateOriginal = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const showProcessing = vi.fn(); const clearProcessing = vi.fn().mockRejectedValue(new Error("clear Bearer secret"));
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, clearProcessing, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1))).toContain("INTERACTION_ENQUEUE_FAILED");
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1))).toContain("処理ID: Ev1_F1");
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1))).toContain("失敗段階: 処理受付");
    expect(showProcessing).toHaveBeenCalledOnce();
    expect(clearProcessing).toHaveBeenCalledWith({ channelId: "C1", threadTs: "1.0" }, expect.any(Function));
    const serialized = consoleError.mock.calls.flat().join(" ");
    expect(serialized).toContain('"stage":"interaction_enqueue"');
    expect(serialized).toContain('"code":"INTERACTION_ENQUEUE_FAILED"');
    expect(serialized).not.toContain("Bearer secret");
    consoleError.mockRestore();
  });
  it("preserves a public tenant error code when queue ingress re-resolves authorization", async () => {
    const send = vi.fn().mockRejectedValue(new TenantBoundaryError(
      "worker_ingress", "WORKSPACE_CONNECTION_REAUTH_REQUIRED", "Authorization Bearer secret"));
    const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    const projected = JSON.stringify(updateOriginal.mock.calls.at(-1));
    expect(projected).toContain("エラーコード: reauthentication_required");
    expect(projected).toContain("問い合わせID: cor_");
    expect(projected).not.toContain("WORKSPACE_CONNECTION_REAUTH_REQUIRED");
    expect(projected).not.toContain("Bearer secret");
  });
  it("still queues when immediate Slack feedback fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(); const showProcessing = vi.fn().mockRejectedValue(new Error("Slack Bearer secret"));
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).toHaveBeenCalledOnce(); expect(showProcessing).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls.flat().join(" ")).toContain('"code":"IMMEDIATE_STATUS_FAILED"');
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Bearer secret");
    consoleError.mockRestore();
  });
  it("projects a stable public code when immediate Slack status feedback fails", async () => {
    const send = vi.fn(); const showProcessing = vi.fn().mockRejectedValue(new Error("status unavailable"));
    const updateOriginal = vi.fn().mockResolvedValue(undefined); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, showProcessing, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).toHaveBeenCalledOnce();
    const fallback = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(fallback).toContain("IMMEDIATE_STATUS_FAILED");
    expect(fallback).toContain("処理ID: Ev1_F1");
    expect(fallback).toContain("失敗段階: 状態表示");
  });
  it("uses one deterministic compound code when both status projections fail", async () => {
    const send = vi.fn(); const showProcessing = vi.fn().mockRejectedValue(new Error("status unavailable"));
    const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("selection unavailable"))
      .mockResolvedValueOnce(undefined); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, showProcessing, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(send).toHaveBeenCalledOnce();
    const fallback = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(fallback).toContain("STATUS_PROJECTION_FAILED");
    expect(fallback).not.toContain("IMMEDIATE_STATUS_FAILED");
    expect(fallback).not.toContain("SELECTION_CONFIRMATION_FAILED");
  });
  it("still queues when the selection confirmation update fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(); const updateOriginal = vi.fn().mockRejectedValue(new Error("Slack Bearer secret"));
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("SELECTION_CONFIRMATION_FAILED");
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("処理ID: Ev1_F1");
    expect(consoleError.mock.calls.flat().join(" ")).toContain('"code":"SELECTION_CONFIRMATION_FAILED"');
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Bearer secret");
    consoleError.mockRestore();
  });
  it("shows a confirmation before queueing a redo", async () => {
    const redoPayload = structuredClone(payload);
    redoPayload.actions[0]!.action_id = "mana_meeting_minutes_redo";
    redoPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(redoPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("GitHubの議事録・文字起こしと自動登録タスクを取り消し");
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("取り消して選び直す");
  });
  it("uses a bounded fallback when the redo confirmation projection fails", async () => {
    const redoPayload = structuredClone(payload);
    redoPayload.actions[0]!.action_id = "mana_meeting_minutes_redo";
    redoPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn();
    const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("confirmation projection unavailable"))
      .mockResolvedValueOnce(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(redoPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    const fallback = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(fallback).toContain("STATUS_PROJECTION_FAILED");
    expect(fallback).toContain("処理ID: Ev1_F1");
    expect(fallback).toContain("失敗段階: 状態表示");
    expect(fallback).toContain("エラーコード: STATUS_PROJECTION_FAILED");
  });
  it("queues a confirmed redo command", async () => {
    const confirmPayload = structuredClone(payload);
    confirmPayload.actions[0]!.action_id = "mana_meeting_minutes_confirm_redo";
    confirmPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn().mockResolvedValue(undefined); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(confirmPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("保存先をやり直しています");
    expect(send).toHaveBeenCalledWith({ kind: "meeting_minutes_redo", runId: "Ev1_F1", workspaceId: "T1", appId: "A1",
      channelId: "C1", threadTs: "1.0", userId: "U1", actionTs: "1.2" });
  });
  it("replaces the confirmation with a durable retry when redo enqueue fails", async () => {
    const confirmPayload = structuredClone(payload);
    confirmPayload.actions[0]!.action_id = "mana_meeting_minutes_confirm_redo";
    confirmPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(confirmPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("保存先をやり直しています");
    expect(JSON.stringify(updateOriginal.mock.calls[1]?.[1])).toContain("取り消しを再実行");
  });
  it("does not log raw errors when redo status projections fail", async () => {
    const confirmPayload = structuredClone(payload);
    confirmPayload.actions[0]!.action_id = "mana_meeting_minutes_confirm_redo";
    confirmPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn().mockRejectedValue(new Error("queue Authorization Bearer secret"));
    const updateOriginal = vi.fn().mockRejectedValue(new Error("projection Authorization Bearer secret"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(confirmPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    const serialized = consoleError.mock.calls.flat().join(" ");
    expect(serialized).toContain('"code":"REDO_ENQUEUE_FAILED"');
    expect(serialized).toContain('"code":"STATUS_PROJECTION_FAILED"');
    expect(serialized).not.toContain("Bearer secret");
    consoleError.mockRestore();
  });
  it("uses a bounded fallback when the redo processing projection fails", async () => {
    const confirmPayload = structuredClone(payload);
    confirmPayload.actions[0]!.action_id = "mana_meeting_minutes_confirm_redo";
    confirmPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", fileName: "meeting.txt" });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValueOnce(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(confirmPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(send).toHaveBeenCalledOnce(); expect(updateOriginal).toHaveBeenCalledTimes(2);
    const fallback = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(fallback).toContain("STATUS_PROJECTION_FAILED");
    expect(fallback).toContain("処理ID: Ev1_F1");
    expect(fallback).toContain("失敗段階: 状態表示");
  });
  it("shows a safe error code when Slack omitted the tenant thread coordinate", async () => {
    const missingThread = structuredClone(payload); delete (missingThread as { message?: unknown }).message;
    const send = vi.fn(); const showProcessing = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(missingThread), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(send).not.toHaveBeenCalled(); expect(showProcessing).not.toHaveBeenCalled();
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("THREAD_COORDINATE_MISSING");
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).not.toContain("INTERACTION_ENQUEUE_FAILED");
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("失敗段階: スレッド特定");
    expect(JSON.stringify(updateOriginal.mock.calls[0]?.[1])).toContain("処理ID: Ev1_F1");
  });
  it("shows immediate feedback for an existing retry button using the signed container thread", async () => {
    const retryPayload = structuredClone(payload);
    delete (retryPayload as { message?: unknown }).message;
    (retryPayload as typeof retryPayload & { container: { thread_ts: string } }).container = { thread_ts: "1.0" };
    const send = vi.fn(); const showProcessing = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(retryPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(showProcessing).toHaveBeenCalledWith(
      { channelId: "C1", threadTs: "1.0", destinationName: "Back Office" }, expect.any(Function));
    expect(send).toHaveBeenCalledOnce();
  });
  it("loads the durable thread coordinate for legacy retry buttons", async () => {
    const retryPayload = structuredClone(payload); delete (retryPayload as { message?: unknown }).message;
    const send = vi.fn(); const showProcessing = vi.fn(); const resolveThreadTs = vi.fn().mockResolvedValue("1.0");
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(retryPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, resolveThreadTs, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(resolveThreadTs).toHaveBeenCalledWith("Ev1_F1");
    expect(showProcessing).toHaveBeenCalledWith(
      { channelId: "C1", threadTs: "1.0", destinationName: "Back Office" }, expect.any(Function));
    expect(showProcessing.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  });
  it("uses the durable retry thread coordinate and rejects conflicting signed coordinates", async () => {
    const retryPayload = structuredClone(payload);
    delete (retryPayload as { message?: unknown }).message;
    retryPayload.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", destinationId: "mana", sourceThreadTs: "1.0" });
    const send = vi.fn(); const showProcessing = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(retryPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(showProcessing).toHaveBeenCalledWith(
      { channelId: "C1", threadTs: "1.0", destinationName: "Back Office" }, expect.any(Function));

    const conflicting = structuredClone(payload);
    conflicting.actions[0]!.value = JSON.stringify({ runId: "Ev1_F1", destinationId: "mana", sourceThreadTs: "2.0" });
    const rejected = await handleMeetingMinutesInteraction(request(conflicting), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, defer: background.defer });
    expect(rejected.status).toBe(400);
  });
  it("fails closed for a non-operator", async () => {
    const send = vi.fn(); const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000, ...tenantBoundary, send });
    expect(response.status).toBe(403); expect(send).not.toHaveBeenCalled();
  });
  it("shows the durable pause reason to an authorized operator without queueing even when minutes are disabled", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", expectedChannelId: "C1",
      operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations: [], send, updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(true), defer: background.defer });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, intake_paused: true });
    await Promise.all(background.work);
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).toHaveBeenCalledWith(payload.response_url, expect.objectContaining({
      text: expect.stringContaining("受付は一時停止中"),
    }), expect.any(Function));
  });
  it("uses a bounded public fallback when the intake-paused projection fails", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn().mockRejectedValueOnce(new Error("pause projection unavailable"))
      .mockResolvedValueOnce(undefined); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, destinations: [], send, updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(true), defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).resolves.toEqual([undefined]);
    expect(send).not.toHaveBeenCalled();
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("STATUS_PROJECTION_FAILED");
  });
  it("delegates router channel authorization to the canonical tenant authority", async () => {
    const send = vi.fn(); const showProcessing = vi.fn(); const background = deferred();
    const resolveTenantEffects = vi.fn(async () => { throw new Error("channel_scope_mismatch"); });
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", expectedChannelId: "C_ROUTER",
      operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary, resolveTenantEffects,
      destinations, send, showProcessing, defer: background.defer });
    expect(response.status).toBe(503); expect(background.work).toHaveLength(0);
    expect(resolveTenantEffects).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "T1", channel_id: "C1",
    }));
    expect(showProcessing).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it("projects a safe tenant error code and run id back to the clicked Slack message", async () => {
    const background = deferred();
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const resolveTenantEffects = vi.fn(async () => {
      throw new TenantBoundaryError("worker_ingress", "WORKSPACE_CONNECTION_REAUTH_REQUIRED", "Bearer secret");
    });
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, resolveTenantEffects,
      destinations, send: vi.fn(), updateBeforeTenant, defer: background.defer });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "reauthentication_required",
      message_key: "tenant.reauthentication_required", next_actions: ["reauthenticate_connection"] }));
    await Promise.all(background.work);
    const projected = JSON.stringify(updateBeforeTenant.mock.calls);
    expect(projected).toContain("処理ID: Ev1_F1");
    expect(projected).toContain("失敗段階: テナント認証");
    expect(projected).toContain("エラーコード: reauthentication_required");
    expect(projected).toContain("問い合わせID: cor_");
    expect(projected).not.toContain("Bearer secret");
  });
  it.each([
    ["INSTALLATION_REQUIRED", "installation_required", true],
    ["WORKSPACE_CONNECTION_UNINSTALLED", "installation_required", true],
    ["QUOTA_EXCEEDED", "usage_limit_reached", true],
    ["QUOTA_APPROVAL_REQUIRED", "administrator_action_required", true],
    ["CREDENTIAL_LEASE_EXPIRED", "reauthentication_required", true],
    ["CREDENTIAL_LEASE_INVALID", "reauthentication_required", true],
    ["TENANT_CONTEXT_SIGNATURE_INVALID", "temporary_failure", false],
    ["TENANT_CONTEXT_INVALID", "temporary_failure", false],
    ["TENANT_CONTEXT_MISSING", "temporary_failure", false],
    ["TENANT_CONTEXT_EXPIRED", "temporary_failure", false],
    ["TENANT_CONTEXT_REQUIRED", "temporary_failure", false],
    ["TENANT_UNKNOWN", "administrator_action_required", false],
    ["TENANT_AMBIGUOUS", "administrator_action_required", false],
    ["UPSTREAM_UNAVAILABLE", "temporary_failure", true],
    ["WORKSPACE_CONNECTION_UNAVAILABLE", "temporary_failure", true],
    ["WORKSPACE_CONNECTION_REAUTH_REQUIRED", "reauthentication_required", true],
    ["WORKSPACE_CONNECTION_REVOKED", "reauthentication_required", true],
    ["WORKSPACE_CONNECTION_STALE_REVISION", "administrator_action_required", false],
    ["WORKSPACE_SCOPE_INSUFFICIENT", "administrator_action_required", false],
    ["WORKSPACE_OR_APP_MISMATCH", "administrator_action_required", false],
    ["AUDIENCE_SCOPE_MISMATCH", "temporary_failure", false],
    ["CAPABILITY_SCOPE_MISMATCH", "administrator_action_required", false],
    ["PROJECT_SCOPE_MISMATCH", "administrator_action_required", false],
    ["ACTOR_SCOPE_MISMATCH", "administrator_action_required", false],
    ["DELIVERY_SCOPE_MISMATCH", "temporary_failure", false],
    ["CROSS_TENANT_CANDIDATE", "administrator_action_required", false],
    ["PROTOCOL_VERSION_UNSUPPORTED", "administrator_action_required", false],
    ["PROTOCOL_CAPABILITY_UNSUPPORTED", "administrator_action_required", false],
    ["REPLY_OWNERSHIP_CONFLICT", "administrator_action_required", false],
    ["NEW_UNKNOWN_BOUNDARY_CODE", "temporary_failure", false],
  ])("maps resolver failure %s to public code %s and notification eligibility %s", async (code, publicCode, shouldProject) => {
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const resolveTenantEffects = vi.fn(async () => {
      throw new TenantBoundaryError("worker_ingress", code, "Bearer secret");
    });
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, resolveTenantEffects,
      destinations, send: vi.fn(), updateBeforeTenant });
    expect(await response.json()).toEqual(expect.objectContaining({ error: publicCode,
      message_key: `tenant.${publicCode}`, correlation_id: expect.stringMatching(/^cor_/) }));
    if (shouldProject) {
      const projected = JSON.stringify(updateBeforeTenant.mock.calls);
      expect(projected).toContain(`エラーコード: ${publicCode}`);
      expect(projected).not.toContain(code);
      expect(projected).not.toContain("Bearer secret");
    } else {
      expect(updateBeforeTenant).not.toHaveBeenCalled();
    }
  });
  it("classifies tenant resolution deadlines without exposing the raw timeout", async () => {
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const resolveTenantEffects = vi.fn(async () => { throw new DOMException("Bearer secret", "TimeoutError"); });
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000,
      ...tenantBoundary, resolveTenantEffects,
      destinations, send: vi.fn(), updateBeforeTenant });
    expect(await response.json()).toEqual(expect.objectContaining({ error: "temporary_failure",
      message_key: "tenant.temporary_failure", next_actions: ["retry_later"] }));
    expect(updateBeforeTenant).not.toHaveBeenCalled();
  });
  it("fails closed for untyped and unknown tenant failures before touching response_url", () => {
    expect(isTenantFailureResponseUrlEligible(new Error("temporary connectivity"))).toBe(false);
    expect(isTenantFailureResponseUrlEligible({ code: "UPSTREAM_UNAVAILABLE" })).toBe(false);
    expect(isTenantFailureResponseUrlEligible({ code: "NEW_UNKNOWN_BOUNDARY_CODE" })).toBe(false);
    expect(isTenantFailureResponseUrlEligible({ code: "WORKSPACE_OR_APP_MISMATCH" })).toBe(false);
    expect(isTenantFailureResponseUrlEligible(new TenantBoundaryError(
      "worker_ingress", "UPSTREAM_UNAVAILABLE", "temporary connectivity",
    ))).toBe(true);
  });
  it("keeps the public HTTP failure when a signed payload has no response_url", async () => {
    const updateBeforeTenant = vi.fn().mockResolvedValue(undefined);
    const resolveTenantEffects = vi.fn(async () => {
      throw new TenantBoundaryError("worker_ingress", "WORKSPACE_CONNECTION_UNINSTALLED", "Bearer secret");
    });
    const response = await handleMeetingMinutesInteraction(request({ ...payload, response_url: undefined }), {
      signingSecret: secret, expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000, ...tenantBoundary, resolveTenantEffects, destinations, send: vi.fn(), updateBeforeTenant,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: "installation_required", correlation_id: expect.stringMatching(/^cor_/),
    }));
    expect(updateBeforeTenant).not.toHaveBeenCalled();
  });
  it("routes a signed task approval with the immutable payload hash", async () => {
    const send = vi.fn(); const updateOriginal = vi.fn();
    const approveTaskWrite = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const approvalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const approvalPayload = { ...payload, user: { id: "U_APPROVER" }, actions: [{ action_id: "mana_task_write_approve",
      value: JSON.stringify({ approvalId, payloadHash: "a".repeat(64) }) }] };
    const response = await handleMeetingMinutesInteraction(request(approvalPayload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(), nowMs: now * 1000, ...tenantBoundary,
      send, updateOriginal, resolveDestinations: () => { throw new Error("minutes config unavailable"); }, approveTaskWrite });
    expect(response.status).toBe(200);
    expect(approveTaskWrite).toHaveBeenCalledWith({ approvalId, payloadHash: "a".repeat(64),
      approverId: "U_APPROVER", channelId: "C1" }, expect.objectContaining({
      tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }));
    expect(send).not.toHaveBeenCalled(); expect(updateOriginal).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: true });
  });
});
describe("updateSlackInteractionMessage", () => {
  it("posts the replacement to Slack's response URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    const message = { replace_original: true as const, text: "議事録を作成中です。", blocks: [] };
    await updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token", message, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://hooks.slack.com/actions/T1/B1/token", expect.objectContaining({
      method: "POST", body: JSON.stringify(message),
    }));
  });
  it("rejects a non-Slack response URL before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(updateSlackInteractionMessage("https://example.com/actions/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_response_url_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects non-standard ports and does not follow redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));
    await expect(updateSlackInteractionMessage("https://hooks.slack.com:8443/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_response_url_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
    await updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual" }));
  });
  it("fails closed when Slack's response URL redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302,
      headers: { location: "https://example.com/collect" } }));
    await expect(updateSlackInteractionMessage("https://hooks.slack.com/actions/T1/B1/token",
      { replace_original: true, text: "processing", blocks: [] }, fetchImpl)).rejects.toThrow("slack_interaction_update_failed:302");
  });
});
