import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { validateTenantBoundary } from "./envelope.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { assertSecretArtifactFree } from "./secret-guard.js";
import {
  claimIdempotency,
  completeIdempotency,
  IDEMPOTENCY_LEASE_MS,
  type IdempotencyStore,
  renewIdempotency,
  releaseIdempotency,
} from "./idempotency.js";
import type { IdempotencyClaim } from "./idempotency.js";
import { validateCanonicalIdempotencyClaim } from "./canonical-consumer.js";
import type { WorkspaceConnectionLookup } from "./workspace-connection.js";

export interface SlackIngressIdentity extends WorkspaceConnectionLookup {
  installation_id?: string;
  event_id: string;
  channel_id: string;
  thread_ts: string;
  requester_id: string;
}

export interface TenantContextIssueRequest {
  workspace_connection: WorkspaceConnectionSnapshot;
  tenant_revision?: string;
  slack: Pick<SlackIngressIdentity,
    "event_id" | "channel_id" | "thread_ts" | "requester_id" | "enterprise_id">;
  actor?: TenantContextEnvelope["actor"];
  authorization?: TenantContextEnvelope["authorization"];
  correlation_id?: string;
  operation_id?: string;
  billing_principal_id?: string;
  required_authorization: {
    audience: string;
    project_id: string;
    capability_id: string;
  };
  /** Trusted project scope resolved from the runtime placement, never from Slack input. */
  trusted_project_ids?: readonly string[];
}

export interface TenantAuthorityClient {
  resolve_workspace_connection(lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot>;
  read_workspace_connection(connectionId: string): Promise<WorkspaceConnectionSnapshot>;
  issue_tenant_context(request: TenantContextIssueRequest): Promise<TenantContextEnvelope>;
}

export interface TenantRuntimeBoundaryVerifierOptions {
  read_authoritative_snapshot(connectionId: string): Promise<WorkspaceConnectionSnapshot>;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
}

async function readAuthoritativeSnapshot(
  read: (connectionId: string) => Promise<WorkspaceConnectionSnapshot>,
  connectionId: string,
  boundary: BoundaryName,
): Promise<WorkspaceConnectionSnapshot> {
  try {
    const snapshot = await read(connectionId);
    if (!snapshot) deny(boundary, "WORKSPACE_CONNECTION_UNAVAILABLE");
    return snapshot;
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny(boundary, "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
}

export class TenantRuntimeBoundaryVerifier {
  readonly #readAuthoritativeSnapshot: TenantRuntimeBoundaryVerifierOptions["read_authoritative_snapshot"];
  readonly #resolveVerificationKey: TenantRuntimeBoundaryVerifierOptions["resolve_verification_key"];

  constructor(options: TenantRuntimeBoundaryVerifierOptions) {
    this.#readAuthoritativeSnapshot = options.read_authoritative_snapshot;
    this.#resolveVerificationKey = options.resolve_verification_key;
  }

  async validate(input: {
    boundary: BoundaryName;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    now: string;
  }): Promise<TenantContextEnvelope> {
    const snapshot = await readAuthoritativeSnapshot(
      this.#readAuthoritativeSnapshot,
      input.tenant_context.workspace_connection.connection_id,
      input.boundary,
    );
    return validateTenantBoundary({
      boundary: input.boundary,
      envelope: input.tenant_context,
      authoritative_snapshot: snapshot,
      expected_scope: input.expected_scope,
      now: input.now,
      resolve_verification_key: this.#resolveVerificationKey,
    });
  }
}

function assertActiveIngressConnection(
  identity: SlackIngressIdentity,
  snapshot: WorkspaceConnectionSnapshot,
  requiredScopes: readonly string[],
): void {
  if (snapshot.status === "revoked" || snapshot.status === "uninstalled" || snapshot.status === "expired") {
    deny("worker_ingress", "WORKSPACE_CONNECTION_REVOKED");
  }
  if (snapshot.status !== "active") deny("worker_ingress", "WORKSPACE_CONNECTION_REAUTH_REQUIRED");
  if (snapshot.app_id !== identity.app_id || snapshot.workspace_id !== identity.workspace_id
    || (identity.installation_id !== undefined && snapshot.installation_id !== identity.installation_id)
    || (identity.enterprise_id !== undefined && snapshot.enterprise_id !== identity.enterprise_id)) {
    deny("worker_ingress", "WORKSPACE_OR_APP_MISMATCH");
  }
  if (requiredScopes.some((scope) => !snapshot.granted_scopes.includes(scope))) {
    deny("worker_ingress", "WORKSPACE_SCOPE_INSUFFICIENT");
  }
}

export async function resolveSlackWorkerIngress(input: {
  identity: SlackIngressIdentity;
  required_scopes: readonly string[];
  required_authorization: TenantContextIssueRequest["required_authorization"];
  trusted_project_ids?: readonly string[];
  tenant_revision?: string;
  authority: TenantAuthorityClient;
  now: string;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
}): Promise<{
  tenant_context: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
}> {
  const trustedProjectIds = input.trusted_project_ids === undefined
    ? undefined
    : [...input.trusted_project_ids];
  if (trustedProjectIds !== undefined && (
    trustedProjectIds.length === 0 ||
    trustedProjectIds.some((projectId) => typeof projectId !== "string" || projectId.trim().length === 0) ||
    new Set(trustedProjectIds).size !== trustedProjectIds.length ||
    !trustedProjectIds.includes(input.required_authorization.project_id)
  )) {
    deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  }
  const lookup: WorkspaceConnectionLookup = {
    provider: "slack",
    app_id: input.identity.app_id,
    workspace_id: input.identity.workspace_id,
    ...(input.identity.enterprise_id ? { enterprise_id: input.identity.enterprise_id } : {}),
  };
  let resolved: WorkspaceConnectionSnapshot;
  try {
    resolved = await input.authority.resolve_workspace_connection(lookup);
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny("worker_ingress", "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
  assertActiveIngressConnection(input.identity, resolved, input.required_scopes);

  const issueRequest: TenantContextIssueRequest = {
    workspace_connection: structuredClone(resolved),
    ...(input.tenant_revision ? { tenant_revision: input.tenant_revision } : {}),
    slack: {
      event_id: input.identity.event_id,
      channel_id: input.identity.channel_id,
      thread_ts: input.identity.thread_ts,
      requester_id: input.identity.requester_id,
      ...(input.identity.enterprise_id ? { enterprise_id: input.identity.enterprise_id } : {}),
    },
    required_authorization: structuredClone(input.required_authorization),
    ...(trustedProjectIds ? { trusted_project_ids: trustedProjectIds } : {}),
  };
  assertSecretArtifactFree(issueRequest);
  let tenantContext: TenantContextEnvelope;
  try {
    tenantContext = await input.authority.issue_tenant_context(issueRequest);
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
  if (tenantContext.actor.authenticated_subject_id !== input.identity.requester_id) {
    deny("worker_ingress", "ACTOR_SCOPE_MISMATCH");
  }
  if (tenantContext.slack.event_id !== input.identity.event_id
    || tenantContext.slack.channel_id !== input.identity.channel_id
    || tenantContext.slack.thread_ts !== input.identity.thread_ts
    || tenantContext.slack.requester_id !== input.identity.requester_id) {
    deny("worker_ingress", "DELIVERY_SCOPE_MISMATCH");
  }
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: (connectionId) => input.authority.read_workspace_connection(connectionId),
    resolve_verification_key: input.resolve_verification_key,
  });
  await verifier.validate({
    boundary: "worker_ingress",
    tenant_context: tenantContext,
    expected_scope: {
      ...input.required_authorization,
      project_id: tenantContext.authorization.project_ids[0]!,
      ...(trustedProjectIds ? { project_ids: tenantContext.authorization.project_ids } : {}),
      workspace_id: input.identity.workspace_id,
      app_id: input.identity.app_id,
      channel_id: input.identity.channel_id,
      thread_ts: input.identity.thread_ts,
      actor_principal_id: tenantContext.actor.principal_id,
      deployment_id: resolved.deployment_id,
    },
    now: input.now,
  });
  return { tenant_context: tenantContext, authoritative_snapshot: resolved };
}

export async function executeTenantBoundary<T>(input: {
  boundary: BoundaryName;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  now: string;
  verifier: TenantRuntimeBoundaryVerifier;
  execute(): Promise<T>;
}): Promise<T> {
  await input.verifier.validate({
    boundary: input.boundary,
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    now: input.now,
  });
  return input.execute();
}

export interface TenantQueueBody<T> {
  schema_version: "1.0";
  tenant_context: TenantContextEnvelope;
  payload: T;
}

export interface TenantQueueMessageLike<T> {
  body: TenantQueueBody<T>;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

const RETRYABLE_BOUNDARY_CODES = new Set(["WORKSPACE_CONNECTION_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]);

const SAFE_OPERATIONAL_FAILURE_REASONS = new Set([
  "meeting_minutes_run_not_found",
  "meeting_minutes_run_corrupt",
  "meeting_minutes_selection_boundary_mismatch",
  "meeting_minutes_destination_forbidden",
  "meeting_minutes_destination_changed",
  "meeting_minutes_transcript_empty",
  "meeting_minutes_context_client_unconfigured",
  "meeting_minutes_context_invalid_response",
  "meeting_minutes_generation_result_error",
  "meeting_minutes_generation_failed",
  "meeting_minutes_task_registration_failed",
]);

function safeGenerationFailureDiagnostics(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object" || !("generationDiagnostics" in error)) return {};
  const diagnostics = (error as { generationDiagnostics?: unknown }).generationDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return {};
  const value = diagnostics as Record<string, unknown>;
  const progress = value.progress && typeof value.progress === "object" && !Array.isArray(value.progress)
    ? value.progress as Record<string, unknown> : {};
  return {
    ...(typeof value.outcome === "string" ? { generation_outcome: value.outcome.slice(0, 32) } : {}),
    ...(typeof value.stderrCode === "string" ? { generation_stderr_code: value.stderrCode.slice(0, 64) } : {}),
    ...(typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)
      ? { generation_exit_code: String(value.exitCode) } : {}),
    ...(typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs)
      ? { generation_elapsed_ms: String(Math.max(0, Math.round(value.elapsedMs))) } : {}),
    ...(typeof progress.prompt_written === "boolean"
      ? { generation_prompt_written: String(progress.prompt_written) } : {}),
    ...(typeof progress.exec_started === "boolean"
      ? { generation_exec_started: String(progress.exec_started) } : {}),
    ...(typeof progress.stdout_observed === "boolean"
      ? { generation_stdout_observed: String(progress.stdout_observed) } : {}),
    ...(typeof progress.hook_observed === "boolean"
      ? { generation_hook_observed: String(progress.hook_observed) } : {}),
    ...(typeof progress.result_observed === "boolean"
      ? { generation_result_observed: String(progress.result_observed) } : {}),
  };
}

export function safeOperationalFailureReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.length <= 96 && SAFE_OPERATIONAL_FAILURE_REASONS.has(error.message)
    ? error.message : undefined;
}

function inProgressRetryDelaySeconds(claim: IdempotencyClaim, now: string): number {
  const nowMs = Date.parse(now);
  const leaseUntilMs = claim.lease_until
    ? Date.parse(claim.lease_until)
    : Date.parse(claim.updated_at) + IDEMPOTENCY_LEASE_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(leaseUntilMs)) return 1;
  // Retry after the lease boundary so the next delivery can atomically reclaim
  // a crashed Worker. The one-second guard avoids a same-boundary race.
  return Math.max(1, Math.ceil((leaseUntilMs - nowMs) / 1_000) + 1);
}

function terminalTimestamp(previous: string | undefined, current: string): string {
  if (previous === undefined) return current;
  const previousMs = Date.parse(previous);
  const currentMs = Date.parse(current);
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return current;
  return currentMs >= previousMs ? current : previous;
}

export async function consumeTenantQueueMessage<T, R>(
  message: TenantQueueMessageLike<T>,
  options: {
    verifier: TenantRuntimeBoundaryVerifier;
    expected_scope(body: TenantQueueBody<T>): ExpectedTenantScope;
    now(): string;
    process(payload: T, tenantContext: TenantContextEnvelope): Promise<R>;
    ownership: IdempotencyStore;
    payload_hash(payload: T): string | Promise<string>;
    retention_until(now: string): string;
    /** Test/edge tuning hook; production defaults to one heartbeat per lease third. */
    heartbeat_interval_ms?: number;
    log?(entry: Record<string, string>): void;
    log_error?(entry: Record<string, string>): void;
  },
): Promise<void> {
  const eventId = message.body.tenant_context.slack.event_id;
  const tenantContext = message.body.tenant_context;
  let idempotencyClaimed = false;
  let idempotencyPartitionKey: string | undefined;
  let idempotencyClaimToken: string | undefined;
  let idempotencyTerminalAt: string | undefined;
  let failureStage = "queue_context_validation";
  try {
    assertSecretArtifactFree(message.body);
    await options.verifier.validate({
      boundary: "queue_consumer",
      tenant_context: message.body.tenant_context,
      expected_scope: options.expected_scope(message.body),
      now: options.now(),
    });
    const contextDigest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(tenantContext.integrity.value),
    ));
    const contextHash = `sha256:${[...contextDigest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const observedAt = options.now();
    const retentionUntil = options.retention_until(observedAt);
    const payloadHash = await options.payload_hash(message.body.payload);
    failureStage = "idempotency_claim";
    await validateCanonicalIdempotencyClaim({
      message_type: "idempotency_claim",
      owner: "mana_runtime",
      scope: "queue_execution",
      tenant_id: tenantContext.tenant.tenant_id,
      connection_id: tenantContext.workspace_connection.connection_id,
      slack_event_id: tenantContext.slack.event_id,
      operation_id: tenantContext.operation_id,
      idempotency_key: tenantContext.idempotency_key,
      context_hash: contextHash,
      payload_hash: payloadHash,
      state: "claimed",
      retention_until: retentionUntil,
    });
    const claim = await claimIdempotency(options.ownership, {
      key: tenantContext.idempotency_key,
      owner: "mana_runtime",
      scope: "queue_execution",
      tenant_id: tenantContext.tenant.tenant_id,
      connection_id: tenantContext.workspace_connection.connection_id,
      slack_event_id: tenantContext.slack.event_id,
      operation_id: tenantContext.operation_id,
      context_hash: contextHash,
      payload_hash: payloadHash,
      connection_revision: tenantContext.workspace_connection.connection_revision,
      updated_at: observedAt,
    });
    if (claim.disposition !== "claimed") {
      if (claim.disposition === "in_progress") {
        message.retry({ delaySeconds: inProgressRetryDelaySeconds(claim.claim, options.now()) });
      } else {
        message.ack();
      }
      return;
    }
    idempotencyClaimed = true;
    idempotencyPartitionKey = claim.claim.partition_key;
    idempotencyClaimToken = claim.claim.claim_token;
    idempotencyTerminalAt = claim.claim.updated_at;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    let heartbeatError: unknown;
    const heartbeatIntervalMs = Math.max(1, Math.floor(
      options.heartbeat_interval_ms ?? IDEMPOTENCY_LEASE_MS / 3,
    ));
    const heartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = Promise.resolve().then(async () => {
        const updatedAt = options.now();
        await renewIdempotency(options.ownership, {
          key: tenantContext.idempotency_key,
          tenant_id: tenantContext.tenant.tenant_id,
          claim_token: idempotencyClaimToken as string,
          updated_at: updatedAt,
          partition_key: idempotencyPartitionKey,
        });
        idempotencyTerminalAt = terminalTimestamp(idempotencyTerminalAt, updatedAt);
      }).catch((error: unknown) => {
        heartbeatError = error instanceof TenantBoundaryError && error.code === "IDEMPOTENCY_CONFLICT"
          ? error
          : new TenantBoundaryError("idempotency", "UPSTREAM_UNAVAILABLE");
      }).finally(() => {
        heartbeatInFlight = undefined;
      });
    };
    heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
    try {
      failureStage = "tenant_process";
      await options.process(message.body.payload, tenantContext);
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
    if (heartbeatError !== undefined) throw heartbeatError;
    failureStage = "idempotency_complete";
    const completedAt = terminalTimestamp(idempotencyTerminalAt, options.now());
    await completeIdempotency(options.ownership, {
      key: tenantContext.idempotency_key,
      tenant_id: tenantContext.tenant.tenant_id,
      state: "succeeded",
      claim_token: idempotencyClaimToken,
      updated_at: completedAt,
      retained_until: options.retention_until(completedAt),
      partition_key: idempotencyPartitionKey,
    });
    options.log?.({ event: "tenant_queue_completed", event_id: eventId });
    message.ack();
  } catch (error) {
    const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
    const failureReason = safeOperationalFailureReason(error);
    options.log_error?.({
      event: "tenant_queue_failed",
      event_id: eventId,
      code,
      stage: failureStage,
      ...(error instanceof TenantBoundaryError ? {
        boundary: error.boundary,
        ...(typeof error.details?.phase === "string" ? { phase: error.details.phase } : {}),
        ...(typeof error.details?.path === "string" ? { path: error.details.path } : {}),
        ...(typeof error.details?.error_name === "string" ? { error_name: error.details.error_name } : {}),
        ...(typeof error.details?.status === "number" ? { status: String(error.details.status) } : {}),
        ...(typeof error.details?.provider_operation === "string"
          ? { provider_operation: error.details.provider_operation }
          : {}),
      } : {}),
      ...(failureReason ? { failure_reason: failureReason } : {}),
      ...safeGenerationFailureDiagnostics(error),
    });
    if (idempotencyClaimed) {
      try {
        if (RETRYABLE_BOUNDARY_CODES.has(code)) {
          await releaseIdempotency(options.ownership, tenantContext.idempotency_key,
            tenantContext.tenant.tenant_id, idempotencyPartitionKey, idempotencyClaimToken);
        } else {
          const completedAt = terminalTimestamp(idempotencyTerminalAt, options.now());
          await completeIdempotency(options.ownership, {
            key: tenantContext.idempotency_key,
            tenant_id: tenantContext.tenant.tenant_id,
            state: "failed_terminal",
            claim_token: idempotencyClaimToken,
            updated_at: completedAt,
            retained_until: options.retention_until(completedAt),
            partition_key: idempotencyPartitionKey,
          });
        }
      } catch (claimError) {
        // A later delivery may have reclaimed an expired lease. The old Worker
        // must not delete or overwrite that newer claim; the newer delivery
        // owns the retry, so acknowledge this stale attempt.
        if (claimError instanceof TenantBoundaryError && claimError.code === "IDEMPOTENCY_CONFLICT") {
          message.ack();
          return;
        }
        throw claimError;
      }
    }
    if (RETRYABLE_BOUNDARY_CODES.has(code)) message.retry(); else message.ack();
  }
}
