import { TenantBoundaryError } from "./errors.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./contracts.js";
import {
  consumeTenantQueueMessage,
  type TenantRuntimeBoundaryVerifier,
} from "./runtime-boundaries.js";
import type { IdempotencyStore } from "./idempotency.js";

const {
  acceptCompanyAuthorityResponse,
  validateObservedExecutionRequest,
// @ts-expect-error The exact A0 producer reference is intentionally vendored as an .mjs contract artifact.
} = await import("../../../../contracts/mana-brainbase-company-authority/v1/reference/wire.mjs");

export type CompanyAuthorityDesiredEffect = "read" | "write" | "external_side_effect";

export interface AuthenticatedSlackObservation {
  provider: "slack";
  authentication: {
    status: "verified";
    scheme: "slack_signature_v0";
  };
  authenticated_subject_id: string;
  workspace_id?: string;
  app_id?: string;
  enterprise_id?: string;
  capability_id: string;
  resource_ref: string;
  project_hint?: string;
  channel_id?: string;
  thread_ts?: string;
  event_id?: string;
  correlation_id: string;
}

export interface ObservedExecutionRequestV1 {
  provider_identity: {
    provider: "slack";
    authenticated_subject_id: string;
    workspace_id?: string;
    app_id?: string;
    enterprise_id?: string;
  };
  requested_action: {
    capability_id: string;
    resource_ref: string;
    project_hint?: string;
    desired_effect: CompanyAuthorityDesiredEffect;
  };
  delivery?: {
    channel_id?: string;
    thread_ts?: string;
    event_id?: string;
  };
  correlation_id: string;
}

export interface CompanyAuthorityClient {
  resolve(request: ObservedExecutionRequestV1): Promise<CompanyAuthorityResolution>;
}

export type CompanyAuthorityResolution =
  | { state: "resolved"; response: unknown }
  | { state: "no_data" | "unknown" | "partial" | "not_collected" };

export interface CompanyAuthorityAcceptanceOptions {
  expected_audience: string | readonly string[];
  expected_deployment_id: string;
  now: string;
  public_jwk: JsonWebKey;
  tenant_context_public_jwk?: JsonWebKey;
  tenant_context_key_id?: string;
}

export interface AcceptedCompanyAuthorityContext {
  readonly schema_version: string;
  readonly tenant_context: Readonly<Record<string, unknown>>;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly authority: Readonly<{
    decision: "auto" | "approval" | "human_action";
    [key: string]: unknown;
  }>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly integrity: Readonly<Record<string, unknown>>;
}

export interface CompanyAuthorityRuntimeEnvelope<T> {
  readonly schema_version: "1.0";
  readonly correlation_id: string;
  readonly company_authority_request: ObservedExecutionRequestV1;
  readonly company_authority_response: unknown;
  readonly payload: T;
}

export interface CompanyAuthorityRuntimeEnvelopeDiagnostic {
  readonly code: "AUTHORITY_ENVELOPE_INVALID" | "AUTHORITY_SCOPE_MISMATCH";
  readonly stage: "company_authority_runtime_envelope";
  readonly reason: "unknown_schema" | "missing_response" | "correlation_mismatch" | "invalid_shape";
  readonly correlation_id: string;
}

export interface CompanyAuthorityQueueMessageLike<T> {
  readonly body: CompanyAuthorityRuntimeEnvelope<T>;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface CompanyAuthorityQueueDecisionSnapshot {
  readonly request: ObservedExecutionRequestV1;
  readonly execution_hash: string;
}

export interface CompanyAuthorityRuntimeResolutionInput<T = unknown> {
  readonly context: AcceptedCompanyAuthorityContext;
  readonly request: ObservedExecutionRequestV1;
  readonly payload: T;
}

export interface CompanyAuthorityRuntimeDependencies {
  readonly tenant_verifier: TenantRuntimeBoundaryVerifier;
  readonly expected_tenant_scope: ExpectedTenantScope;
  readonly ownership: IdempotencyStore;
}

export type CompanyAuthorityRuntimeResolver<T = unknown> = (
  input: CompanyAuthorityRuntimeResolutionInput<T>,
) => CompanyAuthorityRuntimeDependencies | Promise<CompanyAuthorityRuntimeDependencies>;

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Identifies only the namespaced Company Authority protocol marker. Keeping
 * this separate from the strict type guard lets Queue reject malformed
 * envelopes without classifying ordinary Slack or legacy payloads as this
 * protocol.
 */
export function isCompanyAuthorityRuntimeEnvelopeCandidate(value: unknown): boolean {
  const envelope = record(value);
  return !!envelope
    && ("company_authority_request" in envelope || "company_authority_response" in envelope);
}

export function diagnoseCompanyAuthorityRuntimeEnvelope(
  value: unknown,
): CompanyAuthorityRuntimeEnvelopeDiagnostic {
  const envelope = record(value);
  const correlationId = envelope && typeof envelope.correlation_id === "string"
    && envelope.correlation_id.length > 0
    ? envelope.correlation_id
    : "unknown";
  const request = record(envelope?.company_authority_request);
  if (envelope && typeof envelope.correlation_id === "string"
    && request && typeof request.correlation_id === "string"
    && envelope.correlation_id !== request.correlation_id) {
    return {
      code: "AUTHORITY_SCOPE_MISMATCH",
      stage: "company_authority_runtime_envelope",
      reason: "correlation_mismatch",
      correlation_id: correlationId,
    };
  }
  if (envelope?.schema_version !== "1.0") {
    return {
      code: "AUTHORITY_ENVELOPE_INVALID",
      stage: "company_authority_runtime_envelope",
      reason: "unknown_schema",
      correlation_id: correlationId,
    };
  }
  if (!record(envelope?.company_authority_response)) {
    return {
      code: "AUTHORITY_ENVELOPE_INVALID",
      stage: "company_authority_runtime_envelope",
      reason: "missing_response",
      correlation_id: correlationId,
    };
  }
  return {
    code: "AUTHORITY_ENVELOPE_INVALID",
    stage: "company_authority_runtime_envelope",
    reason: "invalid_shape",
    correlation_id: correlationId,
  };
}

export function isCompanyAuthorityRuntimeEnvelope<T = unknown>(
  value: unknown,
): value is CompanyAuthorityRuntimeEnvelope<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Partial<CompanyAuthorityRuntimeEnvelope<T>>;
  const request = envelope.company_authority_request;
  const response = envelope.company_authority_response;
  return envelope.schema_version === "1.0"
    && typeof envelope.correlation_id === "string"
    && envelope.correlation_id.length > 0
    && !!request
    && typeof request === "object"
    && request.correlation_id === envelope.correlation_id
    && !!request.provider_identity
    && typeof request.provider_identity === "object"
    && !!request.requested_action
    && typeof request.requested_action === "object"
    && !!response
    && typeof response === "object"
    && !Array.isArray(response)
    && "payload" in envelope;
}

function fail(code: string, details?: Readonly<Record<string, unknown>>): never {
  throw new TenantBoundaryError("worker_ingress", code, code, details);
}

function failAtBoundary(
  boundary: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new TenantBoundaryError(boundary, code, code, details);
}

function canonicalCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function mapContractFailure(error: unknown): never {
  if (error instanceof TenantBoundaryError) throw error;
  const code = canonicalCode(error);
  if (code) fail(code);
  throw error;
}

function mapContractFailureAtBoundary(error: unknown, boundary: string): never {
  if (error instanceof TenantBoundaryError) {
    failAtBoundary(boundary, error.code, error.details);
  }
  const code = canonicalCode(error);
  if (code) failAtBoundary(boundary, code);
  throw error;
}

function desiredEffect(
  capabilityId: string,
  mapping: Readonly<Record<string, CompanyAuthorityDesiredEffect>>,
): CompanyAuthorityDesiredEffect {
  const effect = mapping[capabilityId];
  if (!effect) fail("DESIRED_EFFECT_REQUIRED", { capability_id: capabilityId });
  return effect;
}

function assertAuthenticatedSlackObservation(
  observation: AuthenticatedSlackObservation,
): void {
  if (observation.provider !== "slack"
    || observation.authentication?.status !== "verified"
    || observation.authentication.scheme !== "slack_signature_v0") {
    fail("PROVIDER_NOT_IMPLEMENTED", { provider: observation.provider });
  }
}

function isResolution(value: unknown): value is CompanyAuthorityResolution {
  if (!value || typeof value !== "object" || !("state" in value)) return false;
  const state = (value as { state?: unknown }).state;
  if (state === "resolved") return "response" in value;
  return state === "no_data" || state === "unknown" || state === "partial" || state === "not_collected";
}

export function createObservedExecutionRequest(
  observation: AuthenticatedSlackObservation,
  desiredEffectByCapability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>,
): ObservedExecutionRequestV1 {
  assertAuthenticatedSlackObservation(observation);
  const delivery = {
    ...(observation.channel_id ? { channel_id: observation.channel_id } : {}),
    ...(observation.thread_ts ? { thread_ts: observation.thread_ts } : {}),
    ...(observation.event_id ? { event_id: observation.event_id } : {}),
  };
  const request: ObservedExecutionRequestV1 = {
    provider_identity: {
      provider: "slack",
      authenticated_subject_id: observation.authenticated_subject_id,
      ...(observation.workspace_id ? { workspace_id: observation.workspace_id } : {}),
      ...(observation.app_id ? { app_id: observation.app_id } : {}),
      ...(observation.enterprise_id ? { enterprise_id: observation.enterprise_id } : {}),
    },
    requested_action: {
      capability_id: observation.capability_id,
      resource_ref: observation.resource_ref,
      ...(observation.project_hint ? { project_hint: observation.project_hint } : {}),
      desired_effect: desiredEffect(observation.capability_id, desiredEffectByCapability),
    },
    ...(Object.keys(delivery).length > 0 ? { delivery } : {}),
    correlation_id: observation.correlation_id,
  };
  try {
    validateObservedExecutionRequest(request);
  } catch (error) {
    mapContractFailure(error);
  }
  return request;
}

async function resolveAcceptedCompanyAuthority(input: {
  observation: AuthenticatedSlackObservation;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  client: CompanyAuthorityClient;
  acceptance: CompanyAuthorityAcceptanceOptions;
}): Promise<{
  request: ObservedExecutionRequestV1;
  response: unknown;
  context: AcceptedCompanyAuthorityContext;
}> {
  const request = createObservedExecutionRequest(input.observation, input.desired_effect_by_capability);
  let resolution: CompanyAuthorityResolution;
  try {
    resolution = await input.client.resolve(request);
  } catch (error) {
    fail("AUTHORITY_UNAVAILABLE", {
      phase: "company_authority_transport",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (!isResolution(resolution)) {
    fail("AUTHORITY_UNAVAILABLE", {
      phase: "company_authority_retrieval",
      retrieval_state: "invalid",
    });
  }
  if (resolution.state !== "resolved") {
    fail("AUTHORITY_UNAVAILABLE", {
      phase: "company_authority_retrieval",
      retrieval_state: resolution.state,
    });
  }

  let accepted: {
    context: AcceptedCompanyAuthorityContext | null;
    error: { code?: unknown } | null;
  };
  try {
    accepted = acceptCompanyAuthorityResponse(resolution.response, {
      expectedAudience: input.acceptance.expected_audience,
      expectedDeploymentId: input.acceptance.expected_deployment_id,
      now: input.acceptance.now,
      publicJwk: input.acceptance.public_jwk,
      tenantContextPublicJwk: input.acceptance.tenant_context_public_jwk,
      tenantContextKeyId: input.acceptance.tenant_context_key_id,
      request,
    });
  } catch (error) {
    mapContractFailure(error);
  }
  if (!accepted.context) {
    const code = accepted.error && typeof accepted.error.code === "string"
      ? accepted.error.code
      : "AUTHORITY_UNAVAILABLE";
    fail(code, { phase: "company_authority_response" });
  }
  return {
    request: structuredClone(request),
    response: structuredClone(resolution.response),
    context: structuredClone(accepted.context),
  };
}

interface AcceptedCompanyAuthorityRuntimeEnvelope<T> {
  readonly request: ObservedExecutionRequestV1;
  readonly response: unknown;
  readonly context: AcceptedCompanyAuthorityContext;
  readonly payload: T;
}

/**
 * Accepts the signed runtime envelope without consulting tenant runtime
 * ownership. Runtime dependencies are resolved only after this function
 * returns, so an invalid or tampered envelope cannot select a tenant store or
 * verifier.
 */
async function acceptCompanyAuthorityRuntimeEnvelope<T>(input: {
  boundary: BoundaryName;
  envelope: CompanyAuthorityRuntimeEnvelope<T>;
  acceptance: CompanyAuthorityAcceptanceOptions;
}): Promise<AcceptedCompanyAuthorityRuntimeEnvelope<T>> {
  const envelope = input.envelope as unknown;
  if (!envelope || typeof envelope !== "object"
    || !("schema_version" in envelope)
    || !("correlation_id" in envelope)
    || !("company_authority_request" in envelope)
    || !("company_authority_response" in envelope)
    || !("payload" in envelope)
    || typeof envelope.correlation_id !== "string"
    || !envelope.company_authority_request
    || typeof envelope.company_authority_request !== "object") {
    failAtBoundary(input.boundary, "AUTHORITY_ENVELOPE_INVALID");
  }
  const runtimeEnvelope = envelope as CompanyAuthorityRuntimeEnvelope<T>;
  if (runtimeEnvelope.schema_version !== "1.0") {
    failAtBoundary(input.boundary, "AUTHORITY_ENVELOPE_INVALID");
  }
  if (runtimeEnvelope.correlation_id !== runtimeEnvelope.company_authority_request.correlation_id) {
    failAtBoundary(input.boundary, "AUTHORITY_SCOPE_MISMATCH", {
      phase: "runtime_envelope_correlation",
    });
  }
  try {
    validateObservedExecutionRequest(runtimeEnvelope.company_authority_request);
  } catch (error) {
    mapContractFailureAtBoundary(error, input.boundary);
  }
  let accepted: {
    context: AcceptedCompanyAuthorityContext | null;
    error: { code?: unknown } | null;
  };
  try {
    accepted = acceptCompanyAuthorityResponse(runtimeEnvelope.company_authority_response, {
      expectedAudience: input.acceptance.expected_audience,
      expectedDeploymentId: input.acceptance.expected_deployment_id,
      now: input.acceptance.now,
      publicJwk: input.acceptance.public_jwk,
      tenantContextPublicJwk: input.acceptance.tenant_context_public_jwk,
      tenantContextKeyId: input.acceptance.tenant_context_key_id,
      request: runtimeEnvelope.company_authority_request,
    });
  } catch (error) {
    mapContractFailureAtBoundary(error, input.boundary);
  }
  if (!accepted.context) {
    const code = accepted.error && typeof accepted.error.code === "string"
      ? accepted.error.code
      : "AUTHORITY_UNAVAILABLE";
    failAtBoundary(input.boundary, code, { phase: "company_authority_response" });
  }
  return {
    request: structuredClone(runtimeEnvelope.company_authority_request),
    response: structuredClone(runtimeEnvelope.company_authority_response),
    context: structuredClone(accepted.context),
    payload: structuredClone(runtimeEnvelope.payload),
  };
}

export async function resolveCompanyAuthorityWorkerIngress(input: {
  observation: AuthenticatedSlackObservation;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  client: CompanyAuthorityClient;
  acceptance: CompanyAuthorityAcceptanceOptions;
}): Promise<AcceptedCompanyAuthorityContext> {
  return (await resolveAcceptedCompanyAuthority(input)).context;
}

export async function resolveCompanyAuthorityRuntimeEnvelope<T>(input: {
  observation: AuthenticatedSlackObservation;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  client: CompanyAuthorityClient;
  acceptance: CompanyAuthorityAcceptanceOptions;
  payload: T;
}): Promise<{
  envelope: CompanyAuthorityRuntimeEnvelope<T>;
  context: AcceptedCompanyAuthorityContext;
  decision: AcceptedCompanyAuthorityContext["authority"]["decision"];
}> {
  const accepted = await resolveAcceptedCompanyAuthority(input);
  return {
    envelope: {
      schema_version: "1.0",
      correlation_id: accepted.request.correlation_id,
      company_authority_request: accepted.request,
      company_authority_response: accepted.response,
      payload: structuredClone(input.payload),
    },
    context: accepted.context,
    decision: accepted.context.authority.decision,
  };
}

export async function executeCompanyAuthorityRuntimeBoundary<T, R>(input: {
  boundary: BoundaryName;
  envelope: CompanyAuthorityRuntimeEnvelope<T>;
  acceptance: CompanyAuthorityAcceptanceOptions;
  tenant_verifier: TenantRuntimeBoundaryVerifier;
  expected_tenant_scope: ExpectedTenantScope;
  validate_payload_binding(
    context: AcceptedCompanyAuthorityContext,
    request: ObservedExecutionRequestV1,
    payload: T,
  ): void | Promise<void>;
  execute_auto(context: AcceptedCompanyAuthorityContext, payload: T): Promise<R>;
}): Promise<{
  context: AcceptedCompanyAuthorityContext;
  decision: AcceptedCompanyAuthorityContext["authority"]["decision"];
  payload: T;
  result?: R;
}> {
  const accepted = await acceptCompanyAuthorityRuntimeEnvelope({
    boundary: input.boundary,
    envelope: input.envelope,
    acceptance: input.acceptance,
  });
  try {
    await input.tenant_verifier.validate({
      boundary: input.boundary,
      tenant_context: accepted.context.tenant_context as unknown as TenantContextEnvelope,
      expected_scope: input.expected_tenant_scope,
      now: input.acceptance.now,
    });
  } catch (error) {
    mapContractFailureAtBoundary(error, input.boundary);
  }
  const context = structuredClone(accepted.context);
  const payload = structuredClone(accepted.payload);
  try {
    await input.validate_payload_binding(context, accepted.request, payload);
  } catch (error) {
    if (error instanceof TenantBoundaryError || canonicalCode(error)) {
      mapContractFailureAtBoundary(error, input.boundary);
    }
    failAtBoundary(input.boundary, "PAYLOAD_SCOPE_MISMATCH");
  }
  const decision = context.authority.decision;
  if (decision !== "auto") return { context, decision, payload };
  return {
    context,
    decision,
    payload,
    result: await input.execute_auto(context, payload),
  };
}

/**
 * Revalidates both signed authority layers at Queue ingress, then uses the
 * nested TenantContext idempotency claim to route exactly one unchanged
 * decision. A non-auto decision is never sent to the protected auto callback.
 */
export async function consumeCompanyAuthorityQueueMessage<T>(
  message: CompanyAuthorityQueueMessageLike<T>,
  options: {
    acceptance: Omit<CompanyAuthorityAcceptanceOptions, "now">;
    resolve_runtime: CompanyAuthorityRuntimeResolver<T>;
    validate_payload_binding(
      context: AcceptedCompanyAuthorityContext,
      request: ObservedExecutionRequestV1,
      payload: T,
    ): void | Promise<void>;
    process_auto(
      context: AcceptedCompanyAuthorityContext,
      payload: T,
      snapshot: CompanyAuthorityQueueDecisionSnapshot,
    ): Promise<unknown>;
    route_approval(
      context: AcceptedCompanyAuthorityContext,
      payload: T,
      snapshot: CompanyAuthorityQueueDecisionSnapshot,
    ): Promise<unknown>;
    route_human_action(
      context: AcceptedCompanyAuthorityContext,
      payload: T,
      snapshot: CompanyAuthorityQueueDecisionSnapshot,
    ): Promise<unknown>;
    execution_hash(envelope: CompanyAuthorityRuntimeEnvelope<T>): string | Promise<string>;
    retention_until(now: string): string;
    now(): string;
    heartbeat_interval_ms?: number;
    log?(entry: Record<string, string>): void;
    log_error?(entry: Record<string, string>): void;
  },
): Promise<void> {
  let accepted: AcceptedCompanyAuthorityRuntimeEnvelope<T> & {
    decision: AcceptedCompanyAuthorityContext["authority"]["decision"];
    runtime: CompanyAuthorityRuntimeDependencies;
    execution_hash: string;
  };
  try {
    const now = options.now();
    const acceptedEnvelope = await acceptCompanyAuthorityRuntimeEnvelope({
      boundary: "queue_consumer",
      envelope: message.body,
      acceptance: { ...options.acceptance, now },
    });
    const acceptedRuntimeEnvelope: CompanyAuthorityRuntimeEnvelope<T> = {
      schema_version: "1.0",
      correlation_id: acceptedEnvelope.request.correlation_id,
      company_authority_request: structuredClone(acceptedEnvelope.request),
      company_authority_response: structuredClone(acceptedEnvelope.response),
      payload: structuredClone(acceptedEnvelope.payload),
    };
    const executionHash = await options.execution_hash(acceptedRuntimeEnvelope);
    const payload = structuredClone(acceptedEnvelope.payload);
    try {
      await options.validate_payload_binding(
        structuredClone(acceptedEnvelope.context),
        structuredClone(acceptedEnvelope.request),
        payload,
      );
    } catch (error) {
      if (error instanceof TenantBoundaryError || canonicalCode(error)) {
        mapContractFailureAtBoundary(error, "queue_consumer");
      }
      failAtBoundary("queue_consumer", "PAYLOAD_SCOPE_MISMATCH");
    }
    let runtime: CompanyAuthorityRuntimeDependencies;
    try {
      runtime = await options.resolve_runtime({
        context: structuredClone(acceptedEnvelope.context),
        request: structuredClone(acceptedEnvelope.request),
        payload: structuredClone(payload),
      });
      await runtime.tenant_verifier.validate({
        boundary: "queue_consumer",
        tenant_context: acceptedEnvelope.context.tenant_context as unknown as TenantContextEnvelope,
        expected_scope: runtime.expected_tenant_scope,
        now,
      });
    } catch (error) {
      if (error instanceof TenantBoundaryError || canonicalCode(error)) {
        mapContractFailureAtBoundary(error, "queue_consumer");
      }
      throw error;
    }
    accepted = {
      ...acceptedEnvelope,
      payload,
      decision: acceptedEnvelope.context.authority.decision,
      runtime,
      execution_hash: executionHash,
    };
  } catch (error) {
    const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
    options.log_error?.({
      event: "company_authority_queue_failed",
      correlation_id: typeof message.body?.correlation_id === "string"
        ? message.body.correlation_id
        : "unknown",
      code,
      ...(error instanceof TenantBoundaryError ? { boundary: error.boundary } : {}),
    });
    if (code === "WORKSPACE_CONNECTION_UNAVAILABLE" || code === "UPSTREAM_UNAVAILABLE") {
      message.retry();
    } else {
      message.ack();
    }
    return;
  }

  await consumeTenantQueueMessage({
    body: {
      schema_version: "1.0",
      tenant_context: accepted.context.tenant_context as unknown as TenantContextEnvelope,
      payload: accepted.payload,
    },
    ack: () => message.ack(),
    retry: (retryOptions) => message.retry(retryOptions),
  }, {
    verifier: accepted.runtime.tenant_verifier,
    expected_scope: () => accepted.runtime.expected_tenant_scope,
    now: options.now,
    ownership: accepted.runtime.ownership,
    // Bind the idempotency claim to the accepted outer decision as well as the
    // nested context and payload. A redelivery cannot replace approval with
    // auto while retaining the nested idempotency key.
    payload_hash: () => accepted.execution_hash,
    retention_until: options.retention_until,
    ...(options.heartbeat_interval_ms !== undefined
      ? { heartbeat_interval_ms: options.heartbeat_interval_ms }
      : {}),
    log: options.log,
    log_error: options.log_error,
    process: async (payload) => {
      const snapshot: CompanyAuthorityQueueDecisionSnapshot = {
        request: structuredClone(accepted.request),
        execution_hash: accepted.execution_hash,
      };
      if (accepted.decision === "approval") {
        return options.route_approval(accepted.context, payload, snapshot);
      }
      if (accepted.decision === "human_action") {
        return options.route_human_action(accepted.context, payload, snapshot);
      }
      return options.process_auto(accepted.context, payload, snapshot);
    },
  });
}

/**
 * Foundation boundary invoked only after a runtime routing selector explicitly
 * opts an operation into Company Authority. This helper does not implement or
 * infer that selector; in particular, the company_authority_v1 protocol marker
 * must never select this path by itself.
 */
export async function executeCompanyAuthorityWorkerIngress<T>(input: {
  observation: AuthenticatedSlackObservation;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  client: CompanyAuthorityClient;
  acceptance: CompanyAuthorityAcceptanceOptions;
  execute_auto(context: AcceptedCompanyAuthorityContext): Promise<T>;
  legacy_authorization_fallback(): Promise<never>;
}): Promise<{
  context: AcceptedCompanyAuthorityContext;
  decision: AcceptedCompanyAuthorityContext["authority"]["decision"];
  result?: T;
}> {
  const context = await resolveCompanyAuthorityWorkerIngress(input);
  const decision = context.authority.decision;
  if (decision !== "auto") return { context, decision };
  return {
    context,
    decision,
    result: await input.execute_auto(context),
  };
}
