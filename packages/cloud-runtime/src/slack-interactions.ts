import { MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, MEETING_MINUTES_CHOOSE_ACTION_ID,
  MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID, MEETING_MINUTES_CONFIRM_REDO_ACTION_ID,
  MEETING_MINUTES_REDO_ACTION_ID, type MeetingMinutesDestination,
  type MeetingMinutesRedo, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { meetingMinutesRuntimeConfig, type MeetingMinutesEnvironment } from "./meeting-minutes-entrypoints.js";
import { destinationSelectedMessage, organizationSelectionMessage, projectSelectionMessage, redoConfirmationMessage,
  immediateStatusFailedMessage, interactionEnqueueFailedMessage, redoFailedMessage, redoProcessingMessage,
  selectionConfirmationFailedMessage, statusProjectionFailedMessage, threadCoordinateMissingMessage,
  tenantInteractionFailedMessage, interactionActionFailedMessage, MeetingMinutesSlackClient,
  type SlackSelectionMessage } from "./meeting-minutes-slack.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";
import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import { createUserFailure } from "./multitenancy/failure.js";
import { deriveCorrelationId } from "./multitenancy/ids.js";
import { verifySlackRequest } from "./slack.js";
import { readSlackRequestBody, slackRequestBodyErrorResponse } from "./slack-request-body.js";

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
  send(selection: MeetingMinutesSelection | MeetingMinutesRedo,
    destination?: MeetingMinutesDestination): Promise<unknown>;
  showProcessing?(input: { channelId: string; threadTs: string; destinationName: string },
    credentialFetch: typeof fetch): Promise<void>;
  clearProcessing?(input: { channelId: string; threadTs: string }, credentialFetch: typeof fetch): Promise<void>;
  resolveThreadTs?(runId: string): Promise<string | undefined>;
  updateOriginal?(responseUrl: string, message: SlackInteractionMessage, credentialFetch: typeof fetch): Promise<void>;
  updateBeforeTenant?(responseUrl: string, message: SlackInteractionMessage): Promise<void>;
  defer?(work: Promise<void>): void;
  approveTaskWrite?(input: { approvalId: string; payloadHash: string; approverId: string; channelId: string },
    effects: TenantInteractionEffects): Promise<Response>;
  handleMeetingTaskAction?(payload: Record<string, unknown>, effects: TenantInteractionEffects): Promise<Response | undefined>;
  handleContractLedgerAction?(payload: Record<string, unknown>): Promise<Response | undefined>;
  resolveTenantEffects(identity: TenantInteractionIdentity,
    destination?: MeetingMinutesDestination): Promise<TenantInteractionEffects>;
  isIntakePaused?(): Promise<boolean>;
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
  durableObject<T>(effectId: string, target: TenantInteractionTarget,
    execute: (tenantContext: TenantContextEnvelope) => Promise<T>): Promise<T>;
  brainbaseProxy<T>(effectId: string, target: TenantInteractionTarget, mode: "read" | "write",
    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
  slackDelivery(effectId: string, target: TenantInteractionTarget, event: unknown,
    execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void>;
}

export type SlackInteractionMessage = Omit<SlackSelectionMessage, "replace_original"> & {
  replace_original: boolean;
  response_type?: "ephemeral" | "in_channel";
};

/**
 * Redo responses acknowledge a button click rather than replace durable run
 * status. Keep them ephemeral so a stale button cannot overwrite the current
 * generation's message through response_url.
 */
function ephemeralRedoMessage(message: SlackSelectionMessage): SlackInteractionMessage {
  return { ...message, replace_original: false, response_type: "ephemeral" };
}

export interface MeetingMinutesInteractionEnvironment extends MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_SIGNING_SECRET_TECHKNIGHT?: string;
  SLACK_EXPECTED_APP_ID_TECHKNIGHT?: string;
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

const slackIdPattern = /^[A-Z0-9_-]{2,64}$/;
const timestampPattern = /^\d{1,20}(?:\.\d{1,12})?$/;
const meetingMinutesRunIdPattern = /^[A-Za-z0-9_-]{3,260}$/;
const meetingMinutesDestinationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const taskWriteApprovalIdPattern = /^[a-f0-9-]{36}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function validOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0 && value.length <= maxLength);
}

function validOptionalMeetingMinutesRevision(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isMeetingMinutesInteractionAction(actionId: string | undefined): boolean {
  return actionId === MEETING_MINUTES_CHOOSE_ACTION_ID ||
    actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`) === true ||
    actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`) === true ||
    actionId === MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID ||
    actionId === MEETING_MINUTES_REDO_ACTION_ID ||
    actionId === MEETING_MINUTES_CONFIRM_REDO_ACTION_ID;
}

function isMeetingMinutesDestinationAction(actionId: string | undefined): boolean {
  return actionId === MEETING_MINUTES_CHOOSE_ACTION_ID ||
    actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`) === true;
}

function isMeetingMinutesTaskInteraction(
  actionId: string | undefined,
  callbackId: string | undefined,
): boolean {
  return actionId === "mana_meeting_minutes_task_edit" ||
    actionId === "mana_meeting_minutes_task_cancel" ||
    actionId === "mana_meeting_minutes_task_assignee" ||
    callbackId === "mana_meeting_minutes_task_edit_view";
}

function validMeetingMinutesTaskMetadata(value: Record<string, unknown> | undefined): boolean {
  const runId = string(value?.runId);
  // Preserve tenant-binding rejection precedence for payloads with no usable card metadata;
  // once an identifier is supplied, validate it before deriving tenant-scoped effects.
  if (!runId) return true;
  const index = value?.index;
  if (!meetingMinutesRunIdPattern.test(runId) || !Number.isInteger(index) ||
    Number(index) < 0 || Number(index) > 10_000) return false;
  const boundedIdentifiers: readonly [unknown, RegExp][] = [
    [value?.organizationId, meetingMinutesDestinationIdPattern],
    [value?.projectId, meetingMinutesDestinationIdPattern],
    [value?.channelId, slackIdPattern],
    [value?.sourceWorkspaceId, slackIdPattern],
    [value?.sourceAppId, slackIdPattern],
    [value?.sourceChannelId, slackIdPattern],
  ];
  if (boundedIdentifiers.some(([candidate, pattern]) => candidate !== undefined &&
    !pattern.test(string(candidate) ?? ""))) return false;
  const sourceThreadTs = string(value?.sourceThreadTs);
  return (sourceThreadTs === undefined || timestampPattern.test(sourceThreadTs)) &&
    validOptionalText(value?.title, 120) && validOptionalText(value?.due, 32) &&
    validOptionalText(value?.assigneePersonId, 512) && validOptionalText(value?.assigneeDisplayName, 256);
}

function validMeetingMinutesInteractionValue(
  actionId: string,
  value: Record<string, unknown> | undefined,
  actionTs: string | undefined,
): boolean {
  const runId = string(value?.runId);
  if (!runId || !meetingMinutesRunIdPattern.test(runId) || !actionTs || !timestampPattern.test(actionTs) ||
    !validOptionalText(value?.fileName, 1_024) || !validOptionalText(value?.sourceThreadTs, 32) ||
    (typeof value?.sourceThreadTs === "string" && !timestampPattern.test(value.sourceThreadTs.trim()))) return false;

  if (actionId === MEETING_MINUTES_CHOOSE_ACTION_ID || actionId.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`)) {
    const destinationId = string(value?.destinationId);
    const qualifiedDestinationId = actionId.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`)
      ? actionId.slice(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`.length) : undefined;
    return !!destinationId && meetingMinutesDestinationIdPattern.test(destinationId) &&
      (!qualifiedDestinationId || meetingMinutesDestinationIdPattern.test(qualifiedDestinationId));
  }
  if (actionId.startsWith(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`)) {
    const organizationId = string(value?.organizationId);
    const qualifiedOrganizationId = actionId.slice(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`.length);
    return !!organizationId && meetingMinutesDestinationIdPattern.test(organizationId) &&
      meetingMinutesDestinationIdPattern.test(qualifiedOrganizationId);
  }
  if ((actionId === MEETING_MINUTES_REDO_ACTION_ID || actionId === MEETING_MINUTES_CONFIRM_REDO_ACTION_ID) &&
    !validOptionalMeetingMinutesRevision(value?.revision)) return false;
  return true;
}

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

/**
 * A response_url is a capability from the signed Slack payload, but it is not
 * safe to use it when tenant resolution did not establish which installation
 * owns that payload.  Keep this gate explicit so a resolver can still surface
 * typed transient/authentication failures without turning an unknown binding
 * into a user-visible side channel.
 */
const TENANT_RESPONSE_URL_ELIGIBLE_CODES = new Set([
  // Installation/authentication state is actionable for the signed Slack user.
  "INSTALLATION_REQUIRED",
  "WORKSPACE_CONNECTION_UNINSTALLED",
  "WORKSPACE_CONNECTION_REAUTH_REQUIRED",
  "WORKSPACE_CONNECTION_REVOKED",
  "CREDENTIAL_LEASE_EXPIRED",
  "CREDENTIAL_LEASE_INVALID",
  // Known transient/quota failures may be safely surfaced without revealing a binding.
  "UPSTREAM_UNAVAILABLE",
  "WORKSPACE_CONNECTION_UNAVAILABLE",
  "QUOTA_EXCEEDED",
  "QUOTA_APPROVAL_REQUIRED",
]);

export function isTenantFailureResponseUrlEligible(error: unknown): boolean {
  // Tenant resolution has not established ownership at this point. Require a
  // typed, explicitly allow-listed category; untyped errors and new boundary
  // codes fail closed until their notification policy is reviewed. In
  // particular, this excludes unknown/ambiguous tenants, workspace/app or
  // scope mismatches, stale revisions, and cross-tenant candidates.
  const code = error instanceof TenantBoundaryError ? error.code : undefined;
  return !!code && TENANT_RESPONSE_URL_ELIGIBLE_CODES.has(code);
}

/**
 * Attempt exactly one safe update of the original interaction message. This is a
 * fallback, not a retry loop: failures are represented by a fixed public code and
 * never recurse back into the projection path.
 */
async function attemptInteractionFailureProjection(input: {
  effects: TenantInteractionEffects;
  effectId: string;
  effectTarget: TenantInteractionTarget;
  effect: unknown;
  responseUrl: string | undefined;
  runId: string;
  message: SlackInteractionMessage;
  options: InteractionOptions;
  failureEvent: string;
}): Promise<boolean> {
  if (!input.responseUrl || !input.options.updateOriginal) return false;
  try {
    await guardedSlackEffect(input.effects, input.effectId, input.effectTarget, input.effect,
      (credentialFetch) => input.options.updateOriginal!(input.responseUrl!, input.message, credentialFetch));
    return true;
  } catch {
    console.error(JSON.stringify({ event: input.failureEvent, runId: input.runId,
      stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
      correlation_id: deriveCorrelationId(input.runId, "status_projection", "STATUS_PROJECTION_FAILED"), retryable: true }));
    return false;
  }
}

async function interactionActionFailureResponse(input: {
  action: "meeting_task" | "contract_ledger" | "task_write_approve" | "intake_gate";
  error: unknown;
  interactionId: string;
  payload: Record<string, unknown>;
  actionValue: Record<string, unknown> | undefined;
  channelId: string;
  threadTs: string;
  effects: TenantInteractionEffects;
  options: InteractionOptions;
}): Promise<Response> {
  const runId = string(input.actionValue?.runId) ?? input.interactionId;
  const fileName = string(input.actionValue?.fileName) ?? "議事録";
  const correlationId = deriveCorrelationId(runId, `interaction_${input.action}`, "INTERACTION_ACTION_FAILED");
  const failure = createUserFailure({ error: input.error, correlation_id: correlationId });
  const responseUrl = slackResponseUrl(input.payload.response_url);
  const projection = attemptInteractionFailureProjection({
    effects: input.effects,
    effectId: `interaction-action-failed:${input.action}:${input.interactionId}`,
    effectTarget: target(input.channelId, input.threadTs),
    effect: { kind: "interaction_action_failed", action: input.action, runId },
    responseUrl,
    runId,
    message: interactionActionFailedMessage(runId, fileName, failure),
    options: input.options,
    failureEvent: "meeting_minutes_interaction_action_failure_projection_failed",
  });
  if (responseUrl && input.options.updateOriginal) {
    const notice = projection.then(() => undefined);
    if (input.options.defer) input.options.defer(notice); else await notice;
  }
  return Response.json({ error: failure.code, message_key: failure.message_key,
    next_actions: failure.next_actions, correlation_id: failure.correlation_id }, { status: 503 });
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
  isIntakePaused?: InteractionOptions["isIntakePaused"],
  handleContractLedgerAction?: InteractionOptions["handleContractLedgerAction"],
): Promise<Response> {
  if (!send || !resolveTenantEffects) return Promise.resolve(response("FALLBACK_FORBIDDEN", 503));
  return handleMeetingMinutesInteraction(request, { signingSecret: env.SLACK_SIGNING_SECRET,
    expectedAppId: env.SLACK_EXPECTED_APP_ID, operatorUserIds,
    additionalAuthenticators: env.SLACK_SIGNING_SECRET_TECHKNIGHT && env.SLACK_EXPECTED_APP_ID_TECHKNIGHT ? [{
      signingSecret: env.SLACK_SIGNING_SECRET_TECHKNIGHT,
      expectedAppId: env.SLACK_EXPECTED_APP_ID_TECHKNIGHT,
    }] : [],
    resolveDestinations: () => meetingMinutesRuntimeConfig(env).destinations,
    send,
    showProcessing: (input, credentialFetch) => new MeetingMinutesSlackClient(
      undefined, credentialFetch).showProcessingStatus(
      input.channelId, input.threadTs, input.destinationName),
    clearProcessing: (input, credentialFetch) => new MeetingMinutesSlackClient(
      undefined, credentialFetch).clearProcessingStatus(input.channelId, input.threadTs),
    resolveThreadTs,
    updateOriginal: (responseUrl, message, credentialFetch) => updateSlackInteractionMessage(
      responseUrl, message, credentialFetch),
    updateBeforeTenant: (responseUrl, message) => updateSlackInteractionMessage(responseUrl, message),
    defer: (work) => ctx.waitUntil(work), approveTaskWrite, handleMeetingTaskAction,
    resolveTenantEffects, isIntakePaused, handleContractLedgerAction });
}

export async function handleMeetingMinutesInteraction(request: Request, options: InteractionOptions): Promise<Response> {
  let body: string;
  try {
    body = await readSlackRequestBody(request);
  } catch (error) {
    const rejected = slackRequestBodyErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }
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
      authenticators: authenticators.map((authenticator) => ({ expectedAppId: authenticator.expectedAppId })) }));
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
  const actionId = string(action?.action_id);
  const actionTs = string(action?.action_ts);
  const view = object(payload?.view);
  const viewMetadata = parsedObject(view?.private_metadata);
  const taskActionId = string(payload?.action_id) ?? actionId;
  const viewCallbackId = string(view?.callback_id);
  if (actionId && actionId.length > 256) return response("slack_interaction_invalid", 400);
  const threadTsCandidates = [string(sourceMessage?.thread_ts), string(sourceContainer?.thread_ts),
    string(actionValue?.sourceThreadTs)].filter((item): item is string => Boolean(item));
  if (isMeetingMinutesInteractionAction(actionId) && (!actionId ||
    !validMeetingMinutesInteractionValue(actionId, actionValue, actionTs) ||
    threadTsCandidates.some((item) => !timestampPattern.test(item)) || new Set(threadTsCandidates).size > 1)) {
    return response("slack_interaction_invalid", 400);
  }
  if (isMeetingMinutesTaskInteraction(taskActionId, viewCallbackId) &&
    !validMeetingMinutesTaskMetadata(viewCallbackId ? viewMetadata : actionValue)) {
    return response("slack_interaction_invalid", 400);
  }
  if (actionId === "mana_task_write_approve" && options.approveTaskWrite &&
    (!taskWriteApprovalIdPattern.test(string(actionValue?.approvalId) ?? "") ||
      !sha256Pattern.test(string(actionValue?.payloadHash) ?? ""))) {
    return response("slack_interaction_invalid", 400);
  }
  const interactionId = await interactionEventId(body);
  const interactionWorkspaceId = string(team?.id);
  const interactionRequesterId = string(user?.id);
  const interactionChannelId = string(channel?.id) ?? string(actionValue?.channelId) ?? string(viewMetadata?.channelId);
  const interactionThreadTs = string(sourceMessage?.thread_ts) ?? string(sourceContainer?.thread_ts)
    ?? string(actionValue?.sourceThreadTs) ?? string(sourceMessage?.ts) ?? string(action?.action_ts)
    ?? `interaction:${interactionId.slice("slack-interaction-".length)}`;
  const destinationAction = isMeetingMinutesDestinationAction(actionId);
  let destinations: readonly MeetingMinutesDestination[] | undefined;
  let destinationResolutionFailed = false;
  let selectedDestination: MeetingMinutesDestination | undefined;
  if (!options.resolveTenantEffects) return response("FALLBACK_FORBIDDEN", 503);
  const enterpriseId = string(object(payload?.enterprise)?.id);
  const threadIdentityValid = timestampPattern.test(interactionThreadTs) ||
    /^interaction:[A-Za-z0-9_-]{43}$/.test(interactionThreadTs);
  if (!interactionWorkspaceId || !slackIdPattern.test(interactionWorkspaceId) ||
    !appId || !slackIdPattern.test(appId) ||
    !interactionRequesterId || !slackIdPattern.test(interactionRequesterId) ||
    !interactionChannelId || !slackIdPattern.test(interactionChannelId) ||
    (enterpriseId !== undefined && !slackIdPattern.test(enterpriseId)) || !threadIdentityValid) {
    return response("slack_interaction_invalid", 400);
  }
  if (destinationAction) {
    try {
      destinations = options.destinations ?? options.resolveDestinations?.();
      const destinationId = string(actionValue?.destinationId);
      const qualifiedDestinationId = actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`)
        ? actionId.slice(`${MEETING_MINUTES_CHOOSE_ACTION_ID}:`.length)
        : undefined;
      if (!qualifiedDestinationId || qualifiedDestinationId === destinationId) {
        selectedDestination = destinations?.find((item) => item.id === destinationId);
      }
    } catch {
      destinationResolutionFailed = true;
    }
  }
  let tenantEffects: TenantInteractionEffects;
  try {
    const tenantIdentity: TenantInteractionIdentity = {
      app_id: appId,
      workspace_id: interactionWorkspaceId,
      event_id: interactionId,
      channel_id: interactionChannelId,
      thread_ts: interactionThreadTs,
      requester_id: interactionRequesterId,
      ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
    };
    tenantEffects = selectedDestination
      ? await options.resolveTenantEffects(tenantIdentity, selectedDestination)
      : await options.resolveTenantEffects(tenantIdentity);
  } catch (error) {
    const responseUrl = slackResponseUrl(payload?.response_url);
    const runId = string(actionValue?.runId) ?? interactionId;
    const failureSeedCode = error instanceof TenantBoundaryError ? error.code : "TENANT_RESOLUTION_FAILED";
    const correlationId = deriveCorrelationId(runId, "tenant_authentication", failureSeedCode);
    const failure = createUserFailure({ error, correlation_id: correlationId });
    if (responseUrl && options.updateBeforeTenant && isMeetingMinutesInteractionAction(actionId) &&
      isTenantFailureResponseUrlEligible(error)) {
      const notice = options.updateBeforeTenant(responseUrl,
        tenantInteractionFailedMessage(runId, string(actionValue?.fileName) ?? "議事録", failure)).catch(() => {
          console.error(JSON.stringify({ event: "meeting_minutes_tenant_failure_projection_failed", runId,
            stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
            correlation_id: deriveCorrelationId(runId, "status_projection", "STATUS_PROJECTION_FAILED"), retryable: true }));
        });
      if (options.defer) options.defer(notice); else await notice;
    }
    return Response.json({ error: failure.code, message_key: failure.message_key,
      next_actions: failure.next_actions, correlation_id: failure.correlation_id }, { status: 503 });
  }
  if (options.handleMeetingTaskAction) {
    try {
      const taskResponse = await options.handleMeetingTaskAction(payload!, tenantEffects);
      if (taskResponse) return taskResponse;
    } catch (error) {
      return interactionActionFailureResponse({ action: "meeting_task", error, interactionId,
        payload: payload!, actionValue: actionValue ?? viewMetadata, channelId: interactionChannelId, threadTs: interactionThreadTs,
        effects: tenantEffects, options });
    }
  }
  if (options.handleContractLedgerAction) {
    try {
      const contractResponse = await options.handleContractLedgerAction(payload!);
      if (contractResponse) return contractResponse;
    } catch (error) {
      return interactionActionFailureResponse({ action: "contract_ledger", error, interactionId,
        payload: payload!, actionValue: actionValue ?? viewMetadata, channelId: interactionChannelId, threadTs: interactionThreadTs,
        effects: tenantEffects, options });
    }
  }
  const userId = string(user?.id);
  const channelId = string(channel?.id);
  if (actionId === "mana_task_write_approve" && options.approveTaskWrite) {
    const approvalId = string(actionValue?.approvalId); const payloadHash = string(actionValue?.payloadHash);
    if (!userId || !channelId || !approvalId || !payloadHash) return response("slack_interaction_invalid", 400);
    try {
      return await options.approveTaskWrite({ approvalId, payloadHash, approverId: userId, channelId }, tenantEffects);
    } catch (error) {
      return interactionActionFailureResponse({ action: "task_write_approve", error, interactionId,
        payload: payload!, actionValue, channelId: interactionChannelId, threadTs: interactionThreadTs,
        effects: tenantEffects, options });
    }
  }
  if (!userId || !options.operatorUserIds.has(userId)) return response("meeting_minutes_operator_forbidden", 403);
  const organizationAction = actionId?.startsWith(`${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:`);
  const backAction = actionId === MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID;
  const redoAction = actionId === MEETING_MINUTES_REDO_ACTION_ID;
  const confirmRedoAction = actionId === MEETING_MINUTES_CONFIRM_REDO_ACTION_ID;
  if (!destinationAction && !organizationAction && !backAction && !redoAction && !confirmRedoAction) {
    return response("slack_interaction_invalid", 400);
  }
  const value = actionValue;
  const runId = string(value?.runId); const destinationId = string(value?.destinationId);
  const organizationId = string(value?.organizationId); const fileName = string(value?.fileName);
  const revision = typeof value?.revision === "number" ? value.revision : 0;
  const sourceThreadTs = threadTsCandidates[0];
  let intakePaused = false;
  if (options.isIntakePaused) {
    try {
      intakePaused = await options.isIntakePaused();
    } catch (error) {
      return interactionActionFailureResponse({ action: "intake_gate", error, interactionId,
        payload: payload!, actionValue, channelId: interactionChannelId, threadTs: interactionThreadTs,
        effects: tenantEffects, options });
    }
  }
  if (intakePaused) {
    const responseUrl = slackResponseUrl(payload?.response_url);
    const intakeCorrelationId = deriveCorrelationId(runId ?? interactionId, "intake", "INTAKE_PAUSED");
    if (responseUrl && options.updateOriginal && options.defer) {
      options.defer((async () => {
        try {
          await guardedSlackEffect(tenantEffects, `intake-paused:${interactionId}`,
            target(channelId, sourceThreadTs), { kind: "intake_paused" },
            (credentialFetch) => options.updateOriginal!(responseUrl, {
              replace_original: true,
              text: `議事録の新規受付は一時停止中です。復旧後にもう一度選択してください。問い合わせID: ${intakeCorrelationId}`,
              blocks: [{ type: "section", text: { type: "mrkdwn",
                text: `:warning: *議事録の新規受付は一時停止中です*\n復旧後にもう一度選択してください。\n問い合わせID: ${intakeCorrelationId}` } }],
            }, credentialFetch));
        } catch {
          await attemptInteractionFailureProjection({
            effects: tenantEffects,
            effectId: `intake-paused-projection:${interactionId}`,
            effectTarget: target(channelId, sourceThreadTs),
            effect: { kind: "intake_paused_projection_fallback", interactionId },
            responseUrl,
            runId: runId ?? interactionId,
            message: statusProjectionFailedMessage(runId ?? interactionId, fileName ?? "議事録"),
            options,
            failureEvent: "meeting_minutes_intake_paused_projection_failed",
          });
        }
      })());
    }
    return Response.json({ ok: true, intake_paused: true });
  }
  if (destinationAction) {
    if (destinationResolutionFailed) return response("slack_interaction_invalid", 400);
  } else {
    try { destinations = options.destinations ?? options.resolveDestinations?.(); }
    catch { return response("slack_interaction_invalid", 400); }
  }
  if (redoAction) {
    const responseUrl = slackResponseUrl(payload?.response_url);
    if (!runId || !fileName || !responseUrl || !options.updateOriginal || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer((async () => {
      try {
        await guardedSlackEffect(tenantEffects, `redo-confirm:${runId}:${revision}`,
          target(channelId, sourceThreadTs), { kind: "redo_confirmation", runId, revision },
          (credentialFetch) => options.updateOriginal!(responseUrl,
            ephemeralRedoMessage(redoConfirmationMessage(runId, fileName, revision, sourceThreadTs)), credentialFetch));
      } catch {
        await attemptInteractionFailureProjection({
          effects: tenantEffects,
          effectId: `redo-confirm-projection:${runId}:${revision}`,
          effectTarget: target(channelId, sourceThreadTs),
          effect: { kind: "redo_confirmation_projection_fallback", runId, revision },
          responseUrl,
          runId,
          message: ephemeralRedoMessage(statusProjectionFailedMessage(runId, fileName)),
          options,
          failureEvent: "meeting_minutes_redo_confirmation_failure_projection_failed",
        });
      }
    })());
    return Response.json({ ok: true });
  }
  if (confirmRedoAction) {
    const responseUrl = slackResponseUrl(payload?.response_url);
    if (!runId || !fileName || !channelId || !sourceThreadTs || !actionTs || !responseUrl ||
      !options.updateOriginal || !options.defer) {
      return response("slack_interaction_invalid", 400);
    }
    options.defer((async () => {
      let processingProjectionFailed = false;
      try {
        await guardedSlackEffect(tenantEffects, `redo-processing:${runId}:${revision}`,
          target(channelId, sourceThreadTs), { kind: "redo_processing", runId, revision },
          (credentialFetch) => options.updateOriginal!(responseUrl,
            ephemeralRedoMessage(redoProcessingMessage(fileName, runId)), credentialFetch));
      } catch {
        processingProjectionFailed = true;
        console.error(JSON.stringify({ event: "meeting_minutes_redo_processing_projection_failed", runId,
          stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
          correlation_id: deriveCorrelationId(runId, "status_projection", "STATUS_PROJECTION_FAILED"), retryable: true }));
      }
      try {
        await options.send({ kind: "meeting_minutes_redo", runId, revision,
          workspaceId: interactionWorkspaceId, appId,
          channelId, threadTs: sourceThreadTs, userId, actionTs });
      } catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_enqueue_failed", runId,
          stage: "redo_enqueue", code: "REDO_ENQUEUE_FAILED",
          correlation_id: deriveCorrelationId(runId, "redo_enqueue", "REDO_ENQUEUE_FAILED"), retryable: true }));
        try {
          await guardedSlackEffect(tenantEffects, `redo-failed:${runId}:${revision}`,
            target(channelId, sourceThreadTs), { kind: "redo_failed", runId, revision },
            (credentialFetch) => options.updateOriginal!(responseUrl,
              ephemeralRedoMessage(redoFailedMessage(runId, fileName, undefined, revision, sourceThreadTs)), credentialFetch));
        } catch {
          await attemptInteractionFailureProjection({
            effects: tenantEffects,
            effectId: `redo-failed-projection:${runId}:${revision}`,
            effectTarget: target(channelId, sourceThreadTs),
            effect: { kind: "redo_failure_projection_fallback", runId, revision },
            responseUrl,
            runId,
            message: ephemeralRedoMessage(statusProjectionFailedMessage(runId, fileName)),
            options,
            failureEvent: "meeting_minutes_redo_enqueue_failure_projection_failed",
          });
        }
        return;
      }
      if (processingProjectionFailed) {
        await attemptInteractionFailureProjection({
          effects: tenantEffects,
          effectId: `redo-processing-projection:${runId}:${revision}`,
          effectTarget: target(channelId, sourceThreadTs),
          effect: { kind: "redo_processing_projection_fallback", runId, revision },
          responseUrl,
          runId,
          message: ephemeralRedoMessage(statusProjectionFailedMessage(runId, fileName)),
          options,
          failureEvent: "meeting_minutes_redo_processing_failure_projection_failed",
        });
      }
    })());
    return Response.json({ ok: true });
  }
  if ((organizationAction || backAction)) {
    const responseUrl = slackResponseUrl(payload?.response_url);
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
    options.defer((async () => {
      try {
        await guardedSlackEffect(tenantEffects, `destination-menu:${runId}:${organizationId ?? "root"}`,
          target(channelId, sourceThreadTs), { kind: organizationAction ? "project_selection" : "organization_selection", runId },
          (credentialFetch) => options.updateOriginal!(responseUrl, message, credentialFetch));
      } catch {
        await attemptInteractionFailureProjection({
          effects: tenantEffects,
          effectId: `destination-menu-projection:${runId}:${organizationId ?? "root"}`,
          effectTarget: target(channelId, sourceThreadTs),
          effect: { kind: "destination_menu_projection_fallback", runId },
          responseUrl,
          runId,
          message: statusProjectionFailedMessage(runId, fileName),
          options,
          failureEvent: "meeting_minutes_destination_menu_projection_failed",
        });
      }
    })());
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
    const responseUrl = slackResponseUrl(payload?.response_url);
    let feedbackThreadTs: string | undefined = sourceThreadTs;
    if (!feedbackThreadTs && options.resolveThreadTs) {
      try {
        feedbackThreadTs = await tenantEffects.durableObject(
          `resolve-thread:${runId}`, target(channelId, interactionThreadTs),
          () => options.resolveThreadTs!(runId));
      }
      catch (error) {
        console.error(JSON.stringify({ event: "meeting_minutes_thread_coordinate_lookup_failed", runId,
          stage: "interaction_enqueue", code: "THREAD_COORDINATE_LOOKUP_FAILED",
          correlation_id: deriveCorrelationId(runId, "interaction_enqueue", "THREAD_COORDINATE_LOOKUP_FAILED"), retryable: true }));
      }
    }
    if (!feedbackThreadTs || !timestampPattern.test(feedbackThreadTs)) {
      console.error(JSON.stringify({ event: "meeting_minutes_thread_coordinate_missing", runId,
        stage: "interaction_enqueue", code: "THREAD_COORDINATE_MISSING",
        correlation_id: deriveCorrelationId(runId, "interaction_enqueue", "THREAD_COORDINATE_MISSING"), retryable: true }));
      await attemptInteractionFailureProjection({
        effects: tenantEffects,
        effectId: `thread-coordinate-failed:${runId}`,
        effectTarget: target(channelId, undefined),
        effect: { kind: "thread_coordinate_failed", runId },
        responseUrl,
        runId,
        message: threadCoordinateMissingMessage(runId, fileName ?? "議事録"),
        options,
        failureEvent: "meeting_minutes_thread_coordinate_failure_projection_failed",
      });
      return;
    }
    let immediateStatusFailed = false;
    try {
      await options.send({ kind: "meeting_minutes_selection", runId, destinationId,
        workspaceId: interactionWorkspaceId, appId,
        channelId, threadTs: feedbackThreadTs, userId, actionTs }, destination);
    } catch (error) {
      const enqueueCode = error instanceof TenantBoundaryError
        ? error.code : "INTERACTION_ENQUEUE_FAILED";
      const enqueueCorrelationId = deriveCorrelationId(runId, "interaction_enqueue", enqueueCode);
      console.error(JSON.stringify({ event: "meeting_minutes_interaction_enqueue_failed", runId,
        stage: "interaction_enqueue", code: enqueueCode, correlation_id: enqueueCorrelationId, retryable: true }));
      if (responseUrl && options.updateOriginal) {
        try {
          const correlationId = deriveCorrelationId(runId, "interaction_enqueue", error instanceof TenantBoundaryError
            ? error.code : "INTERACTION_ENQUEUE_FAILED");
          const failure = createUserFailure({ error, correlation_id: correlationId });
          await guardedSlackEffect(tenantEffects, `enqueue-failed:${runId}`,
            target(channelId, feedbackThreadTs), { kind: "enqueue_failed", runId },
            (credentialFetch) => options.updateOriginal!(responseUrl,
              error instanceof TenantBoundaryError
                ? tenantInteractionFailedMessage(runId, fileName ?? "議事録", failure)
                : interactionEnqueueFailedMessage(runId, fileName ?? "議事録"), credentialFetch));
        } catch {
          await attemptInteractionFailureProjection({
            effects: tenantEffects,
            effectId: `enqueue-failed-projection:${runId}`,
            effectTarget: target(channelId, feedbackThreadTs),
            effect: { kind: "enqueue_failure_projection_fallback", runId },
            responseUrl,
            runId,
            message: statusProjectionFailedMessage(runId, fileName ?? "議事録"),
            options,
            failureEvent: "meeting_minutes_interaction_enqueue_failure_projection_failed",
          });
        }
      }
      return;
    }
    if (options.showProcessing && feedbackThreadTs && timestampPattern.test(feedbackThreadTs) && destination) {
      try {
        await guardedSlackEffect(tenantEffects, `processing-show:${runId}:${destination.id}`,
          target(channelId, feedbackThreadTs), { kind: "processing_status", runId, destinationId: destination.id },
          (credentialFetch) => options.showProcessing!(
            { channelId, threadTs: feedbackThreadTs!, destinationName: destination.name }, credentialFetch));
      } catch {
        immediateStatusFailed = true;
        console.error(JSON.stringify({ event: "meeting_minutes_immediate_status_failed", runId,
          stage: "status_projection", code: "IMMEDIATE_STATUS_FAILED",
          correlation_id: deriveCorrelationId(runId, "status_projection", "IMMEDIATE_STATUS_FAILED"), retryable: true }));
      }
    }
    let selectionConfirmationFailed = false;
    if (responseUrl && options.updateOriginal && destination && fileName) {
      try {
        await guardedSlackEffect(tenantEffects, `destination-confirm:${runId}:${destination.id}`,
          target(channelId, feedbackThreadTs), { kind: "destination_confirmation", runId, destinationId: destination.id },
          (credentialFetch) => options.updateOriginal!(
            responseUrl, destinationSelectedMessage(runId, fileName, destination), credentialFetch));
      } catch {
        selectionConfirmationFailed = true;
        console.error(JSON.stringify({ event: "meeting_minutes_selection_confirmation_failed", runId,
          stage: "status_projection", code: "SELECTION_CONFIRMATION_FAILED",
          correlation_id: deriveCorrelationId(runId, "status_projection", "SELECTION_CONFIRMATION_FAILED"), retryable: true }));
      }
    }
    if (selectionConfirmationFailed || immediateStatusFailed) {
      await attemptInteractionFailureProjection({
        effects: tenantEffects,
        effectId: `status-failed:${runId}`,
        effectTarget: target(channelId, feedbackThreadTs),
        effect: { kind: "status_projection_fallback", runId },
        responseUrl,
        runId,
        message: immediateStatusFailed && selectionConfirmationFailed
          ? statusProjectionFailedMessage(runId, fileName ?? "議事録")
          : selectionConfirmationFailed
            ? selectionConfirmationFailedMessage(runId, fileName ?? "議事録")
            : immediateStatusFailedMessage(runId, fileName ?? "議事録"),
        options,
        failureEvent: "meeting_minutes_interaction_status_failure_projection_failed",
      });
    }
  })());
  return Response.json({ ok: true });
}
