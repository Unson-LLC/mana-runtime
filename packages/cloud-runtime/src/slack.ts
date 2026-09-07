import type { SlackFileReference, SlackQueueEvent } from "./types.js";
import {
  resolveRuntimePlacement,
  RuntimeBindingError,
  type RuntimePlacementConfig,
} from "./runtime-config.js";
import { readSlackRequestBody, slackRequestBodyErrorResponse } from "./slack-request-body.js";
import {
  TenantBoundaryError,
  assertSecretArtifactFree,
  companyAuthoritySlackResourceRef,
  resolveCompanyAuthorityRuntimeEnvelope,
  resolveSlackWorkerIngress,
  type CompanyAuthorityAcceptanceOptions,
  type CompanyAuthorityClient,
  type CompanyAuthorityDesiredEffect,
  type CompanyAuthorityRuntimeEnvelope,
  type TenantAuthorityClient,
  type TenantContextIssueRequest,
  type TenantQueueBody,
} from "./multitenancy/index.js";
import type { CompanyAuthoritySlackRolloutTuple } from "./multitenancy/company-authority-runtime-config.js";
import { deriveCorrelationId } from "./multitenancy/ids.js";

const SLACK_REPLAY_WINDOW_SECONDS = 300;
const MAX_SLACK_FILES = 10;
const MAX_SLACK_FILE_SIZE_BYTES = 20 * 1024 * 1024;

interface VerifySlackRequestOptions {
  body: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  nowMs?: number;
}

interface HandleSlackRequestOptions {
  signingSecret: string;
  tenantId?: string;
  expectedTeamId: string;
  expectedAppId?: string;
  nowMs?: number;
  intercept?(event: SlackQueueEvent): Promise<boolean>;
  send(event: SlackQueueEvent): Promise<unknown>;
}

export interface HandleTenantSlackRequestOptions {
  signing_secret: string;
  expected_app_id: string;
  required_scopes: readonly string[];
  /** Audience/capability are static; project_id is always supplied by the resolved placement. */
  required_authorization: Omit<TenantContextIssueRequest["required_authorization"], "project_id">
    & Partial<Pick<TenantContextIssueRequest["required_authorization"], "project_id">>;
  /** Placement configuration is mandatory so a global project cannot authorize every channel. */
  placement_config: RuntimePlacementConfig;
  authority: TenantAuthorityClient;
  /**
   * Explicit business-operation opt-in for the Company Authority path.
   * Omitting this block keeps every operation on the existing path; a protocol
   * marker inside TenantContext never selects this route.
   */
  company_authority?: {
    /** Canonical tenant id used in the signed payload and at the Queue boundary. */
    tenant_id?: string;
    opted_in_capability_ids: readonly string[];
    desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
    client: CompanyAuthorityClient;
    acceptance: Omit<CompanyAuthorityAcceptanceOptions, "now">;
    slack_rollout?: readonly CompanyAuthoritySlackRolloutTuple[];
    send(event: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>): Promise<unknown>;
  };
  now_ms?: number;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
  send(event: TenantQueueBody<SlackQueueEvent>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function matchesCompanyAuthoritySlackRollout(
  rollout: readonly CompanyAuthoritySlackRolloutTuple[] | undefined,
  identity: {
    workspace_id: string;
    channel_id: string;
    authenticated_subject_id: string;
  },
): boolean {
  if (rollout === undefined) return true;
  return rollout.some((candidate) => candidate.workspace_id === identity.workspace_id
    && candidate.channel_id === identity.channel_id
    && candidate.authenticated_subject_id === identity.authenticated_subject_id);
}

function normalizeSlackFiles(value: unknown): SlackFileReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_SLACK_FILES) throw new Error("slack_files_too_many");
  const files = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("slack_file_invalid");
    const id = nonEmptyString(candidate.id);
    const name = nonEmptyString(candidate.name);
    const mimetype = nonEmptyString(candidate.mimetype);
    const size = candidate.size;
    if (!id || !name || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("slack_file_invalid");
    }
    if (typeof size === "number" &&
      (!Number.isSafeInteger(size) || size < 0 || size > MAX_SLACK_FILE_SIZE_BYTES)) {
      throw new Error("slack_file_size_invalid");
    }
    return { id, name: name.slice(0, 255), ...(mimetype ? { mimetype } : {}),
      ...(typeof size === "number" ? { size } : {}) };
  });
  return files.length > 0 ? files : undefined;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifySlackRequest(
  options: VerifySlackRequestOptions,
): Promise<boolean> {
  if (!/^\d+$/.test(options.timestamp) || !/^v0=[a-f0-9]{64}$/.test(options.signature)) {
    return false;
  }

  const timestampSeconds = Number(options.timestamp);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > SLACK_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${options.timestamp}:${options.body}`),
  );
  return constantTimeEqual(`v0=${bytesToHex(digest)}`, options.signature);
}

export function normalizeSlackEvent(
  payload: unknown,
  expectedTeamId: string,
  receivedAt: string,
  tenantId = "techknight",
): SlackQueueEvent {
  if (!isRecord(payload) || payload.team_id !== expectedTeamId) {
    throw new Error("slack_team_forbidden");
  }
  if (payload.type !== "event_callback" || !isRecord(payload.event)) {
    throw new Error("slack_event_invalid");
  }

  const eventId = nonEmptyString(payload.event_id);
  const rawEventType = nonEmptyString(payload.event.type);
  const channelId = nonEmptyString(payload.event.channel);
  const messageTs = nonEmptyString(payload.event.ts);
  if (!eventId || !rawEventType || !channelId || !messageTs) {
    throw new Error("slack_event_invalid");
  }

  const userId = nonEmptyString(payload.event.user);
  const botId = nonEmptyString(payload.event.bot_id);
  const subtype = nonEmptyString(payload.event.subtype);
  const channelType = nonEmptyString(payload.event.channel_type);
  const text = typeof payload.event.text === "string" ? payload.event.text : "";
  const authorization = Array.isArray(payload.authorizations)
    ? payload.authorizations.find(isRecord)
    : undefined;
  const authorizedBotUserId = authorization ? nonEmptyString(authorization.user_id) : undefined;
  const eventType = rawEventType === "message" && authorizedBotUserId && text.includes(`<@${authorizedBotUserId}>`)
    ? "app_mention"
    : rawEventType;
  const files = normalizeSlackFiles(payload.event.files);
  return {
    tenantId,
    eventId,
    workspaceId: expectedTeamId,
    channelId,
    ...(channelType ? { channelType } : {}),
    threadTs: nonEmptyString(payload.event.thread_ts) ?? messageTs,
    messageTs,
    ...(userId ? { userId } : {}),
    ...(botId ? { botId } : {}),
    ...(subtype ? { subtype } : {}),
    eventType,
    text,
    receivedAt,
    ...(files ? { files } : {}),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function handleSlackRequest(
  request: Request,
  options: HandleSlackRequestOptions,
): Promise<Response> {
  let body: string;
  try {
    body = await readSlackRequestBody(request);
  } catch (error) {
    const rejected = slackRequestBodyErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }
  const validSignature = await verifySlackRequest({
    body,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "",
    signingSecret: options.signingSecret,
    nowMs: options.nowMs,
  });
  if (!validSignature) return jsonResponse({ error: "slack_signature_invalid" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "slack_payload_invalid" }, 400);
  }
  if (isRecord(payload) && payload.type === "url_verification") {
    const challenge = nonEmptyString(payload.challenge);
    return challenge
      ? jsonResponse({ challenge }, 200)
      : jsonResponse({ error: "slack_payload_invalid" }, 400);
  }

  if (
    options.expectedAppId &&
    (!isRecord(payload) || payload.api_app_id !== options.expectedAppId)
  ) {
    return jsonResponse({ error: "slack_app_forbidden" }, 403);
  }

  if (!isRecord(payload) || payload.team_id !== options.expectedTeamId) {
    return jsonResponse({ error: "slack_team_forbidden" }, 403);
  }

  try {
    const event = normalizeSlackEvent(
      payload,
      options.expectedTeamId,
      new Date(options.nowMs ?? Date.now()).toISOString(),
      options.tenantId,
    );
    if (await options.intercept?.(event)) return jsonResponse({ ok: true }, 200);
    await options.send(event);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "slack_event_invalid";
    return jsonResponse({ error: message }, message === "slack_team_forbidden" ? 403 : 400);
  }
}

function tenantBoundaryStatus(error: TenantBoundaryError): number {
  if (error.code === "WORKSPACE_CONNECTION_UNAVAILABLE"
    || error.code === "UPSTREAM_UNAVAILABLE"
    || error.code === "AUTHORITY_UNAVAILABLE") return 503;
  if (error.code === "TENANT_CONTEXT_EXPIRED" || error.code === "WORKSPACE_CONNECTION_STALE_REVISION") return 409;
  return 403;
}

type SlackIngressFailureStage =
  | "event_normalization"
  | "runtime_placement"
  | "tenant_context_resolution"
  | "queue_enqueue";

function tenantSlackIngressFailureResponse(input: {
  error: unknown;
  stage: SlackIngressFailureStage;
  eventId: string;
  workspaceId: string;
  channelId: string;
}): Response {
  const code = input.error instanceof TenantBoundaryError || input.error instanceof RuntimeBindingError
    ? input.error.code : "WORKSPACE_CONNECTION_UNAVAILABLE";
  const status = input.error instanceof TenantBoundaryError
    ? tenantBoundaryStatus(input.error)
    : input.error instanceof RuntimeBindingError ? 403 : 503;
  const retryable = status === 503;
  const correlationId = deriveCorrelationId(input.eventId, input.stage, code);
  const diagnostic = input.error instanceof TenantBoundaryError
    ? input.error.details
    : undefined;
  console.error(JSON.stringify({
    event: "slack_tenant_ingress_failed",
    event_id: input.eventId,
    workspace_id: input.workspaceId,
    channel_id: input.channelId,
    stage: input.stage,
    code,
    correlation_id: correlationId,
    retryable,
    ...(input.error instanceof TenantBoundaryError ? { boundary: input.error.boundary } : {}),
    ...(typeof diagnostic?.phase === "string" ? { failure_phase: diagnostic.phase } : {}),
    ...(typeof diagnostic?.retrieval_state === "string"
      ? { authority_retrieval_state: diagnostic.retrieval_state }
      : {}),
    ...(typeof diagnostic?.status === "number" ? { upstream_status: diagnostic.status } : {}),
  }));
  return Response.json({
    error: code,
    stage: input.stage,
    correlation_id: correlationId,
    retryable,
  }, {
    status,
    headers: {
      "x-mana-error-code": code,
      "x-mana-failure-stage": input.stage,
      "x-mana-correlation-id": correlationId,
    },
  });
}

export async function handleTenantSlackRequest(
  request: Request,
  options: HandleTenantSlackRequestOptions,
): Promise<Response> {
  let body: string;
  try {
    body = await readSlackRequestBody(request);
  } catch (error) {
    const rejected = slackRequestBodyErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }
  const validSignature = await verifySlackRequest({
    body,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "",
    signingSecret: options.signing_secret,
    nowMs: options.now_ms,
  });
  if (!validSignature) return jsonResponse({ error: "slack_signature_invalid" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "slack_payload_invalid" }, 400);
  }
  if (isRecord(payload) && payload.type === "url_verification") {
    const challenge = nonEmptyString(payload.challenge);
    return challenge ? jsonResponse({ challenge }, 200) : jsonResponse({ error: "slack_payload_invalid" }, 400);
  }
  if (!isRecord(payload) || payload.api_app_id !== options.expected_app_id) {
    return jsonResponse({ error: "slack_app_forbidden" }, 403);
  }
  if (payload.type !== "event_callback" || !isRecord(payload.event)) {
    return jsonResponse({ error: "slack_event_invalid" }, 400);
  }

  const workspaceId = nonEmptyString(payload.team_id);
  const eventId = nonEmptyString(payload.event_id);
  const channelId = nonEmptyString(payload.event.channel);
  const messageTs = nonEmptyString(payload.event.ts);
  const threadTs = nonEmptyString(payload.event.thread_ts) ?? messageTs;
  const requesterId = nonEmptyString(payload.event.user);
  const enterpriseId = nonEmptyString(payload.context_enterprise_id) ?? nonEmptyString(payload.enterprise_id);
  if (!workspaceId || !eventId || !channelId || !messageTs || !threadTs || !requesterId) {
    return jsonResponse({ error: "slack_event_invalid" }, 400);
  }

  let failureStage: SlackIngressFailureStage = "event_normalization";
  try {
    const receivedAt = new Date(options.now_ms ?? Date.now()).toISOString();
    const event = normalizeSlackEvent(
      payload,
      workspaceId,
      receivedAt,
      options.placement_config.tenantId,
    );
    failureStage = "runtime_placement";
    const placement = resolveRuntimePlacement(event, options.placement_config);
    const placementProjectIds = [...placement.projectCodes];
    const requiredAuthorization = {
      ...options.required_authorization,
      // The first project is the canonical singular resource hint. The complete
      // placement set is carried separately and checked for exact equality.
      project_id: placementProjectIds[0]!,
    };
    failureStage = "tenant_context_resolution";
    const companyAuthority = options.company_authority;
    const companyAuthoritySelected = companyAuthority?.opted_in_capability_ids.includes(requiredAuthorization.capability_id)
      && matchesCompanyAuthoritySlackRollout(companyAuthority.slack_rollout, {
        workspace_id: workspaceId,
        channel_id: channelId,
        authenticated_subject_id: requesterId,
      });
    if (companyAuthority && companyAuthoritySelected) {
      if (placementProjectIds.length !== 1) {
        throw new TenantBoundaryError(
          "worker_ingress",
          "AUTHORITY_SCOPE_MISMATCH",
          "AUTHORITY_SCOPE_MISMATCH",
          {
            phase: "company_authority_project_binding",
            expected_project_count: 1,
            observed_project_count: placementProjectIds.length,
          },
        );
      }
      const correlationId = deriveCorrelationId(
        eventId,
        "company_authority",
        requiredAuthorization.capability_id,
      );
      const companyAuthorityEvent = companyAuthority.tenant_id
        ? { ...event, tenantId: companyAuthority.tenant_id }
        : event;
      const accepted = await resolveCompanyAuthorityRuntimeEnvelope({
        observation: {
          provider: "slack",
          authentication: { status: "verified", scheme: "slack_signature_v0" },
          authenticated_subject_id: requesterId,
          workspace_id: workspaceId,
          app_id: options.expected_app_id,
          ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
          capability_id: requiredAuthorization.capability_id,
          resource_ref: await companyAuthoritySlackResourceRef(
            requiredAuthorization.project_id,
            companyAuthorityEvent,
          ),
          project_hint: requiredAuthorization.project_id,
          channel_id: channelId,
          thread_ts: threadTs,
          event_id: eventId,
          correlation_id: correlationId,
        },
        desired_effect_by_capability: companyAuthority.desired_effect_by_capability,
        client: companyAuthority.client,
        acceptance: { ...companyAuthority.acceptance, now: receivedAt },
        payload: companyAuthorityEvent,
      });
      assertSecretArtifactFree(accepted.envelope);
      failureStage = "queue_enqueue";
      await companyAuthority.send(accepted.envelope);
      return jsonResponse({ ok: true }, 200);
    }
    const resolved = await resolveSlackWorkerIngress({
      identity: {
        provider: "slack",
        app_id: options.expected_app_id,
        workspace_id: workspaceId,
        ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
        event_id: eventId,
        channel_id: channelId,
        thread_ts: threadTs,
        requester_id: requesterId,
      },
      required_scopes: options.required_scopes,
      required_authorization: requiredAuthorization,
      trusted_project_ids: placementProjectIds,
      authority: options.authority,
      now: receivedAt,
      resolve_verification_key: options.resolve_verification_key,
    });
    const message: TenantQueueBody<SlackQueueEvent> = {
      schema_version: "1.0",
      tenant_context: resolved.tenant_context,
      payload: { ...event, tenantId: resolved.tenant_context.tenant.tenant_id },
    };
    assertSecretArtifactFree(message);
    failureStage = "queue_enqueue";
    await options.send(message);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return tenantSlackIngressFailureResponse({
      error,
      stage: failureStage,
      eventId,
      workspaceId,
      channelId,
    });
  }
}
