import { createHmac } from "node:crypto";
import {
  handleMeetingMinutesInteraction,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
} from "../slack-interactions.js";

const secret = "secret";
const now = 1_786_420_000;

function request(payload: unknown): Request {
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

const destinations = [
  {
    id: "mana",
    projectId: "p1",
    contextProjectCode: "back-office",
    taskProjectCodes: ["back-office"],
    taskBoardTargetId: "minutes-back-office",
    name: "Back Office",
    organization: { id: "unson-business", name: "雲孫 事業運営" },
    slackChannelId: "C2",
    github: { owner: "Unson-LLC", repo: "back_office" },
  },
  {
    id: "board",
    projectId: "p2",
    contextProjectCode: "techknight",
    taskProjectCodes: ["techknight"],
    taskBoardTargetId: "minutes-board",
    name: "ボード定例",
    organization: { id: "tech-knight", name: "Tech Knight" },
    slackChannelId: "C3",
    github: { owner: "Tech-Knight-inc", repo: "tech-knight-project" },
  },
];

const tenantBoundary = {
  resolveTenantEffects: async (source: TenantInteractionIdentity): Promise<TenantInteractionEffects> => {
    const credentialFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    return {
      tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source,
      durableObject: async (_effectId, _target, execute) => execute({} as never),
      brainbaseProxy: async (_effectId, _target, _mode, execute) => execute(credentialFetch),
      slackDelivery: async (_effectId, _target, _event, execute) => execute(credentialFetch),
    };
  },
};

function basePayload(actionId: string, value: Record<string, unknown>) {
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

function deferred() {
  const work: Promise<void>[] = [];
  return { work, defer: (promise: Promise<void>) => { work.push(promise); } };
}

function feedbackTenantIdentity(): TenantInteractionIdentity {
  return {
    app_id: "A1",
    workspace_id: "T1",
    event_id: "slack-interaction-feedback",
    channel_id: "C1",
    thread_ts: "1.0",
    requester_id: "U1",
  };
}

function expectPendingMessage(message: unknown, text: string, ephemeral = false) {
  expect(JSON.stringify(message)).toContain(text);
  expect(message).toMatchObject({ replace_original: ephemeral ? false : true });
  if (ephemeral) expect(message).toMatchObject({ response_type: "ephemeral" });
}

describe("meeting minutes routing feedback", () => {
  it.each([
    {
      name: "project navigation",
      actionId: "mana_meeting_minutes_choose_organization:tech-knight",
      value: { runId: "Ev1_F1", organizationId: "tech-knight", fileName: "定例.txt" },
      pending: "プロジェクト一覧を開いています",
      final: "保存先プロジェクトを選択してください",
      ephemeral: false,
    },
    {
      name: "workspace navigation",
      actionId: "mana_meeting_minutes_back_to_organizations",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "ワークスペース一覧を開いています",
      final: "保存先組織を選択してください",
      ephemeral: false,
    },
    {
      name: "destination selection",
      actionId: "mana_meeting_minutes_choose_destination",
      value: { runId: "Ev1_F1", destinationId: "mana", fileName: "定例.txt" },
      pending: "処理の開始を確認しています",
      final: undefined,
      ephemeral: false,
    },
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "保存先のやり直しを確認しています",
      final: "保存先をやり直しますか",
      ephemeral: true,
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
      value: { runId: "Ev1_F1", fileName: "定例.txt" },
      pending: "やり直しの開始を確認しています",
      final: "保存先変更の要求を受け付けました",
      ephemeral: true,
    },
  ])("projects $name feedback before the intake gate", async ({ actionId, value, pending, final, ephemeral }) => {
    let release!: (paused: boolean) => void;
    const intakeGate = new Promise<boolean>((resolve) => { release = resolve; });
    const isIntakePaused = vi.fn(() => intakeGate);
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    let releaseTenant!: (effects: TenantInteractionEffects) => void;
    const tenantGate = new Promise<TenantInteractionEffects>((resolve) => { releaseTenant = resolve; });
    const resolveTenantEffects = vi.fn(() => tenantGate);
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId, value)), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      resolveTenantEffects,
      destinations,
      send,
      updateOriginal,
      isIntakePaused,
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    expect(updateOriginal).not.toHaveBeenCalled();
    releaseTenant(await tenantBoundary.resolveTenantEffects(feedbackTenantIdentity()));
    await vi.waitFor(() => expect(isIntakePaused).toHaveBeenCalledOnce());
    expect(updateOriginal).toHaveBeenCalledOnce();
    expectPendingMessage(updateOriginal.mock.calls[0]?.[1], pending, ephemeral);
    expect(isIntakePaused).toHaveBeenCalledOnce();
    expect(updateOriginal.mock.invocationCallOrder[0]).toBeLessThan(isIntakePaused.mock.invocationCallOrder[0]!);

    release(false);
    await Promise.all(background.work);
    if (final) expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain(final);
    if (actionId === "mana_meeting_minutes_choose_destination") expect(send).toHaveBeenCalledOnce();
    if (actionId === "mana_meeting_minutes_confirm_redo") expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
    },
  ])("keeps the $name pause notice ephemeral", async ({ actionId }) => {
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId,
      { runId: "Ev1_F1", fileName: "定例.txt" })), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send,
      updateOriginal,
      isIntakePaused: vi.fn().mockResolvedValue(true),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expectPendingMessage(updateOriginal.mock.calls[0]?.[1], "定例.txt", true);
    expect(updateOriginal.mock.calls[1]?.[1]).toMatchObject({ replace_original: false, response_type: "ephemeral" });
    expect(JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1])).toContain("受付は一時停止中");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "redo confirmation",
      actionId: "mana_meeting_minutes_redo",
    },
    {
      name: "redo processing",
      actionId: "mana_meeting_minutes_confirm_redo",
    },
  ])("keeps the $name intake error ephemeral", async ({ actionId }) => {
    const updateOriginal = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const background = deferred();
    const response = await handleMeetingMinutesInteraction(request(basePayload(actionId,
      { runId: "Ev1_F1", fileName: "定例.txt" })), {
      signingSecret: secret,
      expectedAppId: "A1",
      operatorUserIds: new Set(["U1"]),
      nowMs: now * 1000,
      ...tenantBoundary,
      destinations,
      send,
      updateOriginal,
      isIntakePaused: vi.fn().mockRejectedValue(new Error("raw Bearer secret")),
      defer: background.defer,
      acknowledgeBeforeTenant: true,
    });

    expect(response.status).toBe(200);
    await Promise.all(background.work);
    expect(updateOriginal).toHaveBeenCalledTimes(2);
    expectPendingMessage(updateOriginal.mock.calls[0]?.[1], "定例.txt", true);
    expect(updateOriginal.mock.calls[1]?.[1]).toMatchObject({ replace_original: false, response_type: "ephemeral" });
    const projected = JSON.stringify(updateOriginal.mock.calls.at(-1)?.[1]);
    expect(projected).toContain("temporary_failure");
    expect(projected).not.toContain("Bearer secret");
    expect(send).not.toHaveBeenCalled();
  });
});
