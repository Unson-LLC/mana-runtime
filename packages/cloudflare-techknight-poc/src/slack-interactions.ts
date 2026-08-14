import { MEETING_MINUTES_CHOOSE_ACTION_ID, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { verifySlackRequest } from "./slack.js";

interface InteractionOptions {
  signingSecret: string;
  expectedTeamId: string;
  expectedAppId?: string;
  operatorUserIds: ReadonlySet<string>;
  nowMs?: number;
  send(selection: MeetingMinutesSelection): Promise<unknown>;
  updateOriginal?(responseUrl: string, message: SlackInteractionMessage): Promise<void>;
  defer?(work: Promise<void>): void;
  approveTaskWrite?(input: { approvalId: string; payloadHash: string; approverId: string; channelId: string }): Promise<Response>;
}

export interface SlackInteractionMessage {
  replace_original: true;
  text: string;
  blocks: Array<{ type: "section"; text: { type: "mrkdwn"; text: string } }>;
}

export interface MeetingMinutesInteractionEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  TECHKNIGHT_EVENTS: { send(selection: MeetingMinutesSelection): Promise<unknown> };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function response(error: string, status: number): Response { return Response.json({ error }, { status }); }

function slackResponseUrl(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || (url.port && url.port !== "443") ||
      !url.pathname.startsWith("/actions/") || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export async function updateSlackInteractionMessage(
  responseUrl: string,
  message: SlackInteractionMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const safeUrl = slackResponseUrl(responseUrl);
  if (!safeUrl) throw new Error("slack_response_url_invalid");
  const result = await fetchImpl(safeUrl, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/json" }, body: JSON.stringify(message), signal: AbortSignal.timeout(1_500) });
  if (!result.ok) throw new Error(`slack_interaction_update_failed:${result.status}`);
}

export function handleMeetingMinutesInteractionEntrypoint(
  request: Request,
  env: MeetingMinutesInteractionEnvironment,
  ctx: Pick<ExecutionContext, "waitUntil">,
  operatorUserIds: ReadonlySet<string>,
  approveTaskWrite?: InteractionOptions["approveTaskWrite"],
): Promise<Response> {
  return handleMeetingMinutesInteraction(request, { signingSecret: env.SLACK_SIGNING_SECRET,
    expectedTeamId: env.SLACK_EXPECTED_TEAM_ID, expectedAppId: env.SLACK_EXPECTED_APP_ID, operatorUserIds,
    send: (selection) => env.TECHKNIGHT_EVENTS.send(selection),
    updateOriginal: (responseUrl, message) => updateSlackInteractionMessage(responseUrl, message),
    defer: (work) => ctx.waitUntil(work), approveTaskWrite });
}

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
  if (!runId || !destinationId || !channelId || !actionTs || !options.defer) {
    return response("slack_interaction_invalid", 400);
  }
  options.defer((async () => {
    await options.send({ kind: "meeting_minutes_selection", runId, destinationId, workspaceId: options.expectedTeamId,
      channelId, userId, actionTs });
  })());
  return Response.json({ ok: true });
}
