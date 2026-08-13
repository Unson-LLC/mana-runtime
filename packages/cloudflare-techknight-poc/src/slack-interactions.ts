import { MEETING_MINUTES_CHOOSE_ACTION_ID, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { verifySlackRequest } from "./slack.js";

interface InteractionOptions {
  signingSecret: string;
  expectedTeamId: string;
  expectedAppId?: string;
  operatorUserIds: ReadonlySet<string>;
  nowMs?: number;
  send(selection: MeetingMinutesSelection): Promise<unknown>;
  approveTaskWrite?(input: { approvalId: string; payloadHash: string; approverId: string; channelId: string }): Promise<Response>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function response(error: string, status: number): Response { return Response.json({ error }, { status }); }

export async function handleMeetingMinutesInteraction(request: Request, options: InteractionOptions): Promise<Response> {
  const body = await request.text();
  if (!await verifySlackRequest({ body, timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "", signingSecret: options.signingSecret, nowMs: options.nowMs })) {
    return response("slack_signature_invalid", 401);
  }
  const encoded = new URLSearchParams(body).get("payload");
  if (!encoded) return response("slack_interaction_invalid", 400);
  let payload: Record<string, unknown> | undefined;
  try { payload = object(JSON.parse(encoded)); } catch { return response("slack_interaction_invalid", 400); }
  const team = object(payload?.team); const appId = string(payload?.api_app_id);
  const user = object(payload?.user); const channel = object(payload?.channel);
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const action = actions.length === 1 ? object(actions[0]) : undefined;
  if (string(team?.id) !== options.expectedTeamId) return response("slack_team_forbidden", 403);
  if (options.expectedAppId && appId !== options.expectedAppId) return response("slack_app_forbidden", 403);
  const userId = string(user?.id);
  const channelId = string(channel?.id);
  if (string(action?.action_id) === "mana_task_write_approve" && options.approveTaskWrite) {
    let value: Record<string, unknown> | undefined;
    try { value = object(JSON.parse(string(action?.value) ?? "")); } catch { return response("slack_interaction_invalid", 400); }
    const approvalId = string(value?.approvalId); const payloadHash = string(value?.payloadHash);
    if (!userId || !channelId || !approvalId || !payloadHash) return response("slack_interaction_invalid", 400);
    return options.approveTaskWrite({ approvalId, payloadHash, approverId: userId, channelId });
  }
  if (!userId || !options.operatorUserIds.has(userId)) return response("meeting_minutes_operator_forbidden", 403);
  const actionId = string(action?.action_id);
  if (actionId !== MEETING_MINUTES_CHOOSE_ACTION_ID && !actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`)) {
    return response("slack_interaction_invalid", 400);
  }
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(string(action?.value) ?? "")); } catch { return response("slack_interaction_invalid", 400); }
  const runId = string(value?.runId); const destinationId = string(value?.destinationId);
  const actionTs = string(action?.action_ts);
  if (!runId || !destinationId || !channelId || !actionTs) return response("slack_interaction_invalid", 400);
  await options.send({ kind: "meeting_minutes_selection", runId, destinationId, workspaceId: options.expectedTeamId,
    channelId, userId, actionTs });
  return Response.json({ ok: true }, { status: 200 });
}
