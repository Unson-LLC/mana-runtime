import { MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, MEETING_MINUTES_CHOOSE_ACTION_ID,
  MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID, MEETING_MINUTES_CONFIRM_REDO_ACTION_ID,
  MEETING_MINUTES_REDO_ACTION_ID, type MeetingMinutesDestination,
  type MeetingMinutesRedo, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { meetingMinutesRuntimeConfig, type MeetingMinutesEnvironment } from "./meeting-minutes-entrypoints.js";
import { destinationSelectedMessage, organizationSelectionMessage, projectSelectionMessage, redoConfirmationMessage,
  MeetingMinutesSlackClient, type SlackSelectionMessage } from "./meeting-minutes-slack.js";
import { verifySlackRequest } from "./slack.js";

interface InteractionOptions {
  signingSecret: string;
  /** @deprecated Tenant workspace authorization belongs to resolveTenantEffects. */
  expectedTeamId?: string;
  expectedAppId?: string;
  additionalAuthenticators?: readonly {
    signingSecret: string;
    /** @deprecated Tenant workspace authorization belongs to resolveTenantEffects. */
    expectedTeamId?: string;
    expectedAppId?: string;
  }[];
  /** @deprecated Tenant channel authorization belongs to resolveTenantEffects. */
  expectedChannelId?: string;
  operatorUserIds: ReadonlySet<string>;
  destinations?: readonly MeetingMinutesDestination[];
  resolveDestinations?(): readonly MeetingMinutesDestination[];
  nowMs?: number;
  send(selection: MeetingMinutesSelection | MeetingMinutesRedo): Promise<unknown>;
  showProcessing?(input: { channelId: string; threadTs: string; destinationName: string },
    credentialFetch: typeof fetch): Promise<void>;
  clearProcessing?(input: { channelId: string; threadTs: string }, credentialFetch: typeof fetch): Promise<void>;
  resolveThreadTs?(runId: string): Promise<string | undefined>;
  updateOriginal?(responseUrl: string, message: SlackInteractionMessage, credentialFetch: typeof fetch): Promise<void>;
  defer?(work: Promise<void>): void;
  approveTaskWrite?(input: { approvalId: string; payloadHash: string; approverId: string; channelId: string },
    effects: TenantInteractionEffects): Promise<Response>;
  handleMeetingTaskAction?(payload: Record<string, unknown>, effects: TenantInteractionEffects): Promise<Response | undefined>;
  resolveTenantEffects(identity: TenantInteractionIdentity): Promise<TenantInteractionEffects>;
}

export interface TenantInteractionIdentity {
  app_id: string;
  workspace_id: string;
  enterprise_id?: string;
  event_id: string;
  channel_id: string;
  thread_ts: string;
  requester_id: string;
}

export type TenantInteractionTarget = Partial<Omit<TenantInteractionIdentity, "event_id">>;

export interface TenantInteractionEffects {
  readonly tenant_id: string;
  readonly source: TenantInteractionIdentity;
  durableObject<T>(effectId: string, target: TenantInteractionTarget, execute: () => Promise<T>): Promise<T>;
  brainbaseProxy<T>(effectId: string, target: TenantInteractionTarget, mode: "read" | "write",
    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
  slackDelivery(effectId: string, target: TenantInteractionTarget, event: unknown,
    execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void>;
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

async function interactionEventId(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `slack-interaction-${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  try { return object(JSON.parse(raw)); } catch { return undefined; }
}

function target(channelId: string | undefined, threadTs: string | undefined): TenantInteractionTarget {
  return {
    ...(channelId ? { channel_id: channelId } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };
}

function guardedSlackEffect(
  effects: TenantInteractionEffects,
  effectId: string,
  effectTarget: TenantInteractionTarget,
  event: unknown,
  execute: (credentialFetch: typeof fetch) => Promise<void>,
): Promise<void> {
  return effects.slackDelivery(effectId, effectTarget, event, execute);
}

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
  send?: InteractionOptions["send"],
  resolveTenantEffects?: InteractionOptions["resolveTenantEffects"],
): Promise<Response> {
  if (!send || !resolveTenantEffects) return Promise.resolve(response("FALLBACK_FORBIDDEN", 503));
  return handleMeetingMinutesInteraction(request, { signingSecret: env.SLACK_SIGNING_SECRET,
    expectedAppId: env.SLACK_EXPECTED_APP_ID, operatorUserIds,
    additionalAuthenticators: env.SLACK_SIGNING_SECRET_TECHKNIGHT ? [{
      signingSecret: env.SLACK_SIGNING_SECRET_TECHKNIGHT,
    }] : [],
    resolveDestinations: () => meetingMinutesRuntimeConfig(env).destinations,
    send,
    showProcessing: (input, credentialFetch) => new MeetingMinutesSlackClient(
      "tenant-credential-injected", credentialFetch).showProcessingStatus(
      input.channelId, input.threadTs, input.destinationName),
    clearProcessing: (input, credentialFetch) => new MeetingMinutesSlackClient(
      "tenant-credential-injected", credentialFetch).clearProcessingStatus(input.channelId, input.threadTs),
    resolveThreadTs,
    updateOriginal: (responseUrl, message, credentialFetch) => updateSlackInteractionMessage(
      responseUrl, message, credentialFetch),
    defer: (work) => ctx.waitUntil(work), approveTaskWrite, handleMeetingTaskAction, resolveTenantEffects });
}

export async function handleMeetingMinutesInteraction(request: Request, options: InteractionOptions): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const authenticators = [{ signingSecret: options.signingSecret,
    expectedAppId: options.expectedAppId }, ...(options.additionalAuthenticators ?? [])];
  const verifiedAuthenticators = (await Promise.all(authenticators.map(async (authenticator) => ({ authenticator,
    verified: await verifySlackRequest({ body, timestamp, signature, signingSecret: authenticator.signingSecret,
      nowMs: options.nowMs }) })))).filter((result) => result.verified).map((result) => result.authenticator);
  if (verifiedAuthenticators.length === 0) {
    console.warn(JSON.stringify({ event: "slack_interaction_signature_invalid",
      authenticatorCount: authenticators.length,
      authenticators: authenticators.map((authenticator) => ({ expectedAppId: authenticator.expectedAppId,
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
    !authenticator.expectedAppId || appId === authenticator.expectedAppId);
  if (!verifiedAuthenticator) return response("slack_app_forbidden", 403);
  const actionValue = parsedObject(action?.value);
  const view = object(payload?.view);
  const viewMetadata = parsedObject(view?.private_metadata);
  const interactionId = await interactionEventId(body);
  const interactionWorkspaceId = string(team?.id);
  const interactionRequesterId = string(user?.id);
  const interactionChannelId = string(channel?.id) ?? string(actionValue?.channelId) ?? string(viewMetadata?.channelId);
  const interactionThreadTs = string(sourceMessage?.thread_ts) ?? string(sourceContainer?.thread_ts)
    ?? string(sourceMessage?.ts) ?? string(actionValue?.sourceThreadTs) ?? string(action?.action_ts)
    ?? `interaction:${interactionId.slice("slack-interaction-".length)}`;
  if (!options.resolveTenantEffects) return response("FALLBACK_FORBIDDEN", 503);
  if (!interactionWorkspaceId || !appId || !interactionRequesterId || !interactionChannelId) {
    return response("slack_interaction_invalid", 400);
  }
  let tenantEffects: TenantInteractionEffects;
  try {
    tenantEffects = await options.resolveTenantEffects({
      app_id: appId,
      workspace_id: interactionWorkspaceId,
      event_id: interactionId,
      channel_id: interactionChannelId,
      thread_ts: interactionThreadTs,
      requester_id: interactionRequesterId,
      ...(string(object(payload?.enterprise)?.id) ? { enterprise_id: string(object(payload?.enterprise)?.id) } : {}),
    });
  } catch {
    return response("TENANT_INTERACTION_UNAVAILABLE", 503);
  }
  if (options.handleMeetingTaskAction) {
    const taskResponse = await options.handleMeetingTaskAction(payload!, tenantEffects);
    if (taskResponse) return taskResponse;
  }
  const userId = string(user?.id);
  const channelId = string(channel?.id);
  if (string(action?.action_id) === "mana_task_write_approve" && options.approveTaskWrite) {
    let value: Record<string, unknown> | undefined;
    try { value = object(JSON.parse(string(action?.value) ?? "")); } catch { return response("slack_interaction_invalid", 400); }
    const approvalId = string(value?.approvalId); const payloadHash = string(value?.payloadHash);
    if (!userId || !channelId || !approvalId || !payloadHash) return response("slack_interaction_invalid", 400);
    return options.approveTaskWrite({ approvalId, payloadHash, approverId: userId, channelId }, tenantEffects);
  }
  if (!userId || !options.operatorUserIds.has(userId)) return response("meeting_minutes_operator_forbidden", 403);
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
  let destinations: readonly MeetingMinutesDestination[] | undefined;
  try { destinations = options.destinations ?? options.resolveDestinations?.(); }
  catch { return response("slack_interaction_invalid", 400); }
  if (redoAction) {
    const responseUrl = string(payload?.response_url);
    if (!runId || !fileName || !responseUrl || !options.updateOriginal || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer(guardedSlackEffect(tenantEffects, `redo-confirm:${runId}`,
      target(channelId, sourceThreadTs), { kind: "redo_confirmation", runId },
      (credentialFetch) => options.updateOriginal!(
        responseUrl, redoConfirmationMessage(runId, fileName), credentialFetch)));
    return Response.json({ ok: true });
  }
  if (confirmRedoAction) {
    if (!runId || !channelId || !sourceThreadTs || !actionTs || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer(options.send({ kind: "meeting_minutes_redo", runId,
      workspaceId: interactionWorkspaceId, appId,
      channelId, threadTs: sourceThreadTs, userId, actionTs }).then(() => undefined));
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
    options.defer(guardedSlackEffect(tenantEffects, `destination-menu:${runId}:${organizationId ?? "root"}`,
      target(channelId, sourceThreadTs), { kind: organizationAction ? "project_selection" : "organization_selection", runId },
      (credentialFetch) => options.updateOriginal!(responseUrl, message, credentialFetch)));
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
      try {
        feedbackThreadTs = await tenantEffects.durableObject(
          `resolve-thread:${runId}`, target(channelId, interactionThreadTs),
          () => options.resolveThreadTs!(runId));
      }
      catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_thread_coordinate_lookup_failed", runId,
          error: error instanceof Error ? error.message : "unexpected_error" }));
      }
    }
    if (!feedbackThreadTs || !timestampPattern.test(feedbackThreadTs)) {
      throw new Error("meeting_minutes_thread_coordinate_missing");
    }
    let processingShown = false;
    if (options.showProcessing && feedbackThreadTs && timestampPattern.test(feedbackThreadTs) && destination) {
      try {
        await guardedSlackEffect(tenantEffects, `processing-show:${runId}:${destination.id}`,
          target(channelId, feedbackThreadTs), { kind: "processing_status", runId, destinationId: destination.id },
          (credentialFetch) => options.showProcessing!(
            { channelId, threadTs: feedbackThreadTs!, destinationName: destination.name }, credentialFetch));
        processingShown = true;
      } catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_immediate_status_failed", runId,
          error: error instanceof Error ? error.message : "unexpected_error" }));
      }
    }
    try {
      const responseUrl = string(payload?.response_url);
      if (responseUrl && options.updateOriginal && destination && fileName) {
        try {
          await guardedSlackEffect(tenantEffects, `destination-confirm:${runId}:${destination.id}`,
            target(channelId, feedbackThreadTs), { kind: "destination_confirmation", runId, destinationId: destination.id },
            (credentialFetch) => options.updateOriginal!(
              responseUrl, destinationSelectedMessage(runId, fileName, destination), credentialFetch));
        }
        catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_confirmation_failed", runId,
            error: error instanceof Error ? error.message : "unexpected_error" }));
        }
      }
      await options.send({ kind: "meeting_minutes_selection", runId, destinationId,
        workspaceId: interactionWorkspaceId, appId,
        channelId, threadTs: feedbackThreadTs, userId, actionTs });
    } catch (error) {
      if (processingShown && options.clearProcessing && feedbackThreadTs) {
        try {
          await guardedSlackEffect(tenantEffects, `processing-clear:${runId}:${destinationId}`,
            target(channelId, feedbackThreadTs), { kind: "processing_status_clear", runId, destinationId },
            (credentialFetch) => options.clearProcessing!(
              { channelId, threadTs: feedbackThreadTs! }, credentialFetch));
        }
        catch (clearError) {
          console.error(JSON.stringify({ event: "meeting_minutes_immediate_status_clear_failed", runId,
            error: clearError instanceof Error ? clearError.message : "unexpected_error" }));
        }
      }
      throw error;
    }
  })());
  return Response.json({ ok: true });
}
