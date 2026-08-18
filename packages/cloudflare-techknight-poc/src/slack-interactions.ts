import { MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, MEETING_MINUTES_CHOOSE_ACTION_ID,
  MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID, MEETING_MINUTES_CONFIRM_REDO_ACTION_ID,
  MEETING_MINUTES_REDO_ACTION_ID, type MeetingMinutesDestination,
  type MeetingMinutesRedo, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { meetingMinutesRuntimeConfig, type MeetingMinutesEnvironment } from "./meeting-minutes-entrypoints.js";
import { destinationSelectedMessage, organizationSelectionMessage, projectSelectionMessage, redoConfirmationMessage,
  redoFailedMessage, redoProcessingMessage,
  MeetingMinutesSlackClient, type SlackSelectionMessage } from "./meeting-minutes-slack.js";
import { verifySlackRequest } from "./slack.js";

interface InteractionOptions {
  signingSecret: string;
  expectedTeamId: string;
  expectedAppId?: string;
  additionalAuthenticators?: readonly {
    signingSecret: string;
    expectedTeamId: string;
    expectedAppId?: string;
  }[];
  expectedChannelId?: string;
  operatorUserIds: ReadonlySet<string>;
  destinations?: readonly MeetingMinutesDestination[];
  resolveDestinations?(): readonly MeetingMinutesDestination[];
  nowMs?: number;
  send(selection: MeetingMinutesSelection | MeetingMinutesRedo): Promise<unknown>;
  showProcessing?(input: { channelId: string; threadTs: string; destinationName: string }): Promise<void>;
  clearProcessing?(input: { channelId: string; threadTs: string }): Promise<void>;
  resolveThreadTs?(runId: string): Promise<string | undefined>;
  updateOriginal?(responseUrl: string, message: SlackInteractionMessage): Promise<void>;
  defer?(work: Promise<void>): void;
  approveTaskWrite?(input: { approvalId: string; payloadHash: string; approverId: string; channelId: string }): Promise<Response>;
  handleMeetingTaskAction?(payload: Record<string, unknown>): Promise<Response | undefined>;
  isIntakePaused?(): Promise<boolean>;
}

export type SlackInteractionMessage = SlackSelectionMessage;

export interface MeetingMinutesInteractionEnvironment extends MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_SIGNING_SECRET_TECHKNIGHT?: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON?: string;
  TECHKNIGHT_EVENTS: { send(selection: MeetingMinutesSelection | MeetingMinutesRedo): Promise<unknown> };
  SLACK_BOT_TOKEN?: string;
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
  resolveThreadTs?: InteractionOptions["resolveThreadTs"],
  handleMeetingTaskAction?: InteractionOptions["handleMeetingTaskAction"],
  isIntakePaused?: InteractionOptions["isIntakePaused"],
): Promise<Response> {
  const slack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "");
  const destinationTeamIds = (() => {
    try { return JSON.parse(env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON ?? "{}") as Record<string, string>; }
    catch { return {}; }
  })();
  const techKnightTeamId = destinationTeamIds["tech-knight"]?.trim();
  return handleMeetingMinutesInteraction(request, { signingSecret: env.SLACK_SIGNING_SECRET,
    expectedTeamId: env.SLACK_EXPECTED_TEAM_ID, expectedAppId: env.SLACK_EXPECTED_APP_ID, operatorUserIds,
    additionalAuthenticators: env.SLACK_SIGNING_SECRET_TECHKNIGHT && techKnightTeamId ? [{
      signingSecret: env.SLACK_SIGNING_SECRET_TECHKNIGHT,
      expectedTeamId: techKnightTeamId,
    }] : [],
    expectedChannelId: env.MEETING_MINUTES_ROUTER_CHANNEL_ID?.trim(),
    resolveDestinations: () => meetingMinutesRuntimeConfig(env).destinations,
    send: (selection) => env.TECHKNIGHT_EVENTS.send(selection),
    showProcessing: (input) => slack.showProcessingStatus(input.channelId, input.threadTs, input.destinationName),
    clearProcessing: (input) => slack.clearProcessingStatus(input.channelId, input.threadTs),
    resolveThreadTs,
    updateOriginal: (responseUrl, message) => updateSlackInteractionMessage(responseUrl, message),
    defer: (work) => ctx.waitUntil(work), approveTaskWrite, handleMeetingTaskAction, isIntakePaused });
}

export async function handleMeetingMinutesInteraction(request: Request, options: InteractionOptions): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const authenticators = [{ signingSecret: options.signingSecret, expectedTeamId: options.expectedTeamId,
    expectedAppId: options.expectedAppId }, ...(options.additionalAuthenticators ?? [])];
  const verifiedAuthenticators = (await Promise.all(authenticators.map(async (authenticator) => ({ authenticator,
    verified: await verifySlackRequest({ body, timestamp, signature, signingSecret: authenticator.signingSecret,
      nowMs: options.nowMs }) })))).filter((result) => result.verified).map((result) => result.authenticator);
  if (verifiedAuthenticators.length === 0) {
    console.warn(JSON.stringify({ event: "slack_interaction_signature_invalid",
      authenticatorCount: authenticators.length,
      authenticators: authenticators.map((authenticator) => ({ expectedTeamId: authenticator.expectedTeamId,
        signingSecretLength: authenticator.signingSecret.length })) }));
    return response("slack_signature_invalid", 401);
  }
  const encoded = new URLSearchParams(body).get("payload");
  if (!encoded) return response("slack_interaction_invalid", 400);
  let payload: Record<string, unknown> | undefined;
  try { payload = object(JSON.parse(encoded)); } catch { return response("slack_interaction_invalid", 400); }
  const team = object(payload?.team); const appId = string(payload?.api_app_id);
  const user = object(payload?.user); const channel = object(payload?.channel);
  const sourceMessage = object(payload?.message);
  const sourceContainer = object(payload?.container);
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const action = actions.length === 1 ? object(actions[0]) : undefined;
  const verifiedAuthenticator = verifiedAuthenticators.find((authenticator) =>
    string(team?.id) === authenticator.expectedTeamId &&
    (!authenticator.expectedAppId || appId === authenticator.expectedAppId));
  if (!verifiedAuthenticator) return response("slack_app_or_team_forbidden", 403);
  if (options.handleMeetingTaskAction) {
    const taskResponse = await options.handleMeetingTaskAction(payload!);
    if (taskResponse) return taskResponse;
  }
  if (string(team?.id) !== options.expectedTeamId) return response("slack_team_forbidden", 403);
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
  if (options.expectedChannelId && channelId !== options.expectedChannelId) return response("slack_channel_forbidden", 403);
  const actionId = string(action?.action_id);
  const destinationAction = actionId === MEETING_MINUTES_CHOOSE_ACTION_ID || actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`);
  const organizationAction = actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`);
  const backAction = actionId === MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID;
  const redoAction = actionId === MEETING_MINUTES_REDO_ACTION_ID;
  const confirmRedoAction = actionId === MEETING_MINUTES_CONFIRM_REDO_ACTION_ID;
  if (!destinationAction && !organizationAction && !backAction && !redoAction && !confirmRedoAction) {
    return response("slack_interaction_invalid", 400);
  }
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(string(action?.value) ?? "")); } catch { return response("slack_interaction_invalid", 400); }
  const runId = string(value?.runId); const destinationId = string(value?.destinationId);
  const organizationId = string(value?.organizationId); const fileName = string(value?.fileName);
  const actionTs = string(action?.action_ts);
  const timestampPattern = /^\d{1,20}(?:\.\d{1,12})?$/;
  const threadTsCandidates = [string(sourceMessage?.thread_ts), string(sourceContainer?.thread_ts),
    string(value?.sourceThreadTs)].filter((item): item is string => Boolean(item));
  if (threadTsCandidates.some((item) => !timestampPattern.test(item)) || new Set(threadTsCandidates).size > 1) {
    return response("slack_interaction_invalid", 400);
  }
  const sourceThreadTs = threadTsCandidates[0];
  if (options.isIntakePaused && await options.isIntakePaused()) {
    const responseUrl = string(payload?.response_url);
    if (responseUrl && options.updateOriginal && options.defer) {
      options.defer(options.updateOriginal(responseUrl, {
        replace_original: true,
        text: "議事録の新規受付は一時停止中です。復旧後にもう一度選択してください。",
        blocks: [{ type: "section", text: { type: "mrkdwn",
          text: ":warning: *議事録の新規受付は一時停止中です*\n復旧後にもう一度選択してください。" } }],
      }));
    }
    return Response.json({ ok: true, intake_paused: true });
  }
  let destinations: readonly MeetingMinutesDestination[] | undefined;
  try { destinations = options.destinations ?? options.resolveDestinations?.(); }
  catch { return response("slack_interaction_invalid", 400); }
  if (redoAction) {
    const responseUrl = string(payload?.response_url);
    if (!runId || !fileName || !responseUrl || !options.updateOriginal || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer(options.updateOriginal(responseUrl, redoConfirmationMessage(runId, fileName)));
    return Response.json({ ok: true });
  }
  if (confirmRedoAction) {
    const responseUrl = string(payload?.response_url);
    if (!runId || !fileName || !channelId || !actionTs || !responseUrl || !options.updateOriginal || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer((async () => {
      try { await options.updateOriginal!(responseUrl, redoProcessingMessage(fileName)); }
      catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_processing_projection_failed", runId,
          error: error instanceof Error ? error.message : "unexpected_error" }));
      }
      try {
        await options.send({ kind: "meeting_minutes_redo", runId, workspaceId: options.expectedTeamId,
          channelId, userId, actionTs });
      } catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_enqueue_failed", runId,
          error: error instanceof Error ? error.message : "unexpected_error" }));
        try { await options.updateOriginal!(responseUrl, redoFailedMessage(runId, fileName)); }
        catch (projectionError) {
          console.error(JSON.stringify({ event: "meeting_minutes_redo_enqueue_failure_projection_failed", runId,
            error: projectionError instanceof Error ? projectionError.message : "unexpected_error" }));
        }
      }
    })());
    return Response.json({ ok: true });
  }
  if ((organizationAction || backAction)) {
    const responseUrl = string(payload?.response_url);
    const actionOrganizationId = organizationAction
      ? actionId?.slice(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`.length)
      : undefined;
    if (!runId || !fileName || !responseUrl || !options.updateOriginal || !options.defer || !destinations ||
      (organizationAction && actionOrganizationId !== organizationId)) {
      return response("slack_interaction_invalid", 400);
    }
    let message: SlackInteractionMessage;
    try {
      message = organizationAction
        ? projectSelectionMessage(runId, fileName, organizationId ?? "", destinations)
        : organizationSelectionMessage(runId, fileName, destinations);
    } catch { return response("slack_interaction_invalid", 400); }
    options.defer(options.updateOriginal(responseUrl, message));
    return Response.json({ ok: true });
  }
  if (!runId || !destinationId || !channelId || !actionTs || !options.defer) {
    return response("slack_interaction_invalid", 400);
  }
  const qualifiedDestinationId = actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`)
    ? actionId.slice(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`.length)
    : undefined;
  if ((qualifiedDestinationId && qualifiedDestinationId !== destinationId) ||
    (destinations && !destinations.some((item) => item.id === destinationId))) {
    return response("slack_interaction_invalid", 400);
  }
  const destination = destinations?.find((item) => item.id === destinationId);
  options.defer((async () => {
    let feedbackThreadTs: string | undefined = sourceThreadTs;
    if (!feedbackThreadTs && options.resolveThreadTs) {
      try { feedbackThreadTs = await options.resolveThreadTs(runId); }
      catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_thread_coordinate_lookup_failed", runId,
          stage: "interaction_enqueue", code: "THREAD_COORDINATE_LOOKUP_FAILED", retryable: true }));
      }
    }
    let processingShown = false;
    if (options.showProcessing && feedbackThreadTs && timestampPattern.test(feedbackThreadTs) && destination) {
      try {
        await options.showProcessing({ channelId, threadTs: feedbackThreadTs, destinationName: destination.name });
        processingShown = true;
      } catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_immediate_status_failed", runId,
          stage: "interaction_enqueue", code: "IMMEDIATE_STATUS_FAILED", retryable: true }));
      }
    }
    try {
      const responseUrl = string(payload?.response_url);
      if (responseUrl && options.updateOriginal && destination && fileName) {
        try { await options.updateOriginal(responseUrl, destinationSelectedMessage(runId, fileName, destination)); }
        catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_confirmation_failed", runId,
            stage: "interaction_enqueue", code: "SELECTION_CONFIRMATION_FAILED", retryable: true }));
        }
      }
      await options.send({ kind: "meeting_minutes_selection", runId, destinationId, workspaceId: options.expectedTeamId,
        channelId, userId, actionTs });
    } catch (error) {
      if (processingShown && options.clearProcessing && feedbackThreadTs) {
        try { await options.clearProcessing({ channelId, threadTs: feedbackThreadTs }); }
        catch (clearError) {
          console.error(JSON.stringify({ event: "meeting_minutes_immediate_status_clear_failed", runId,
            stage: "interaction_enqueue", code: "IMMEDIATE_STATUS_CLEAR_FAILED", retryable: true }));
        }
      }
      console.error(JSON.stringify({ event: "meeting_minutes_interaction_enqueue_failed", runId,
        stage: "interaction_enqueue", code: "INTERACTION_ENQUEUE_FAILED", retryable: true }));
      throw error;
    }
  })());
  return Response.json({ ok: true });
}
