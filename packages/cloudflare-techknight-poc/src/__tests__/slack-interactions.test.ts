import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteraction,
  updateSlackInteractionMessage,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";
import { MAX_SLACK_REQUEST_BODY_BYTES } from "../slack-request-body.js";

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
    await expect(Promise.all(background.work)).rejects.toThrow("queue Authorization Bearer secret");
    expect(updateOriginal).toHaveBeenCalledOnce();
    expect(showProcessing).toHaveBeenCalledOnce();
    expect(clearProcessing).toHaveBeenCalledWith({ channelId: "C1", threadTs: "1.0" }, expect.any(Function));
    const serialized = consoleError.mock.calls.flat().join(" ");
    expect(serialized).toContain('"stage":"interaction_enqueue"');
    expect(serialized).toContain('"code":"INTERACTION_ENQUEUE_FAILED"');
    expect(serialized).not.toContain("Bearer secret");
    consoleError.mockRestore();
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
  it("still queues when the selection confirmation update fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(); const updateOriginal = vi.fn().mockRejectedValue(new Error("Slack Bearer secret"));
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(payload), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, updateOriginal, defer: background.defer });
    expect(response.status).toBe(200); await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
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
  it("fails closed when Slack omitted the tenant thread coordinate", async () => {
    const missingThread = structuredClone(payload); delete (missingThread as { message?: unknown }).message;
    const send = vi.fn(); const showProcessing = vi.fn(); const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(missingThread), { signingSecret: secret,
      expectedTeamId: "T1", expectedAppId: "A1", operatorUserIds: new Set(["U1"]), nowMs: now * 1000, ...tenantBoundary,
      destinations, send, showProcessing, defer: background.defer });
    expect(response.status).toBe(200);
    await expect(Promise.all(background.work)).rejects.toThrow("meeting_minutes_thread_coordinate_missing");
    expect(send).not.toHaveBeenCalled(); expect(showProcessing).not.toHaveBeenCalled();
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
