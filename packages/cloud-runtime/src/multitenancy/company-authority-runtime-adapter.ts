import { TenantBoundaryError } from "./errors.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./contracts.js";
import type { TenantRuntimeBoundaryVerifier } from "./runtime-boundaries.js";

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
  ): void;
  execute_auto(context: AcceptedCompanyAuthorityContext, payload: T): Promise<R>;
}): Promise<{
  context: AcceptedCompanyAuthorityContext;
  decision: AcceptedCompanyAuthorityContext["authority"]["decision"];
  payload: T;
  result?: R;
}> {
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
  const payload = structuredClone(runtimeEnvelope.payload);
  try {
    input.validate_payload_binding(context, runtimeEnvelope.company_authority_request, payload);
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
