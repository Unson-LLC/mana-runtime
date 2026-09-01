import { TenantBoundaryError } from "./errors.js";

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

function fail(code: string, details?: Readonly<Record<string, unknown>>): never {
  throw new TenantBoundaryError("worker_ingress", code, code, details);
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

export async function resolveCompanyAuthorityWorkerIngress(input: {
  observation: AuthenticatedSlackObservation;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  client: CompanyAuthorityClient;
  acceptance: CompanyAuthorityAcceptanceOptions;
}): Promise<AcceptedCompanyAuthorityContext> {
  const request = createObservedExecutionRequest(input.observation, input.desired_effect_by_capability);
  let resolution: CompanyAuthorityResolution;
  try {
    resolution = await input.client.resolve(request);
  } catch (error) {
    const code = canonicalCode(error);
    fail(code ?? "AUTHORITY_UNAVAILABLE", {
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
  return structuredClone(accepted.context);
}

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
