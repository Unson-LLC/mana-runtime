import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./multitenancy/contracts.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";
import { createDeterministicSharedId } from "./multitenancy/ids.js";
import { resolveCanonicalProjectScope } from "./multitenancy/project-scope.js";
import { assertSecretArtifactFree } from "./multitenancy/secret-guard.js";
import { TenantRuntimeBoundaryVerifier } from "./multitenancy/runtime-boundaries.js";

const CANONICAL_ORIGIN = "https://brainbase.internal";
const RUNTIME_PREFIX = "/api/v1/runtime";
const REQUIRED_AUTHORITY_PREFIXES = [
  "company_authority:decision:",
  "company_authority:membership:",
  "company_authority:resource:",
  "company_authority:raci:",
  "company_authority:policy:",
  "company_authority:placement:",
  "company_authority:identity_receipt:",
  "company_authority:authority_receipt:",
] as const;

type DesiredEffect = "read" | "write" | "external_side_effect";

export interface AutonomyTenantRuntimeService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ResolveAutonomyTenantContextInput {
  service: AutonomyTenantRuntimeService;
  workspaceConnection: WorkspaceConnectionSnapshot;
  tenantRevision: string;
  actorId: string;
  project: string;
  capabilityId: string;
  audience: string;
  runId: string;
  channelId: string;
  now: string;
  timeoutMs?: number;
  resolveVerificationKey(keyId: string): Promise<CryptoKey | undefined>;
}

export interface ResolvedAutonomyTenantContext {
  tenant_context: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
  expected_scope: ExpectedTenantScope;
}

function nonEmpty(value: unknown, max = 500): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function desiredEffectForCapability(capabilityId: string): DesiredEffect {
  const value = capabilityId.toLowerCase();
  if (/(send|publish|post|deliver|external)/u.test(value)) return "external_side_effect";
  if (/(create|write|update|transition|delete|apply|approve|reject)/u.test(value)) return "write";
  return "read";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TenantBoundaryError("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function postJson(
  service: AutonomyTenantRuntimeService,
  path: string,
  body: unknown,
  timeoutMs: number,
  context?: TenantContextEnvelope,
): Promise<unknown> {
  assertSecretArtifactFree(body);
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  if (context) {
    headers.set("Brainbase-Protocol-Version", context.protocol_version);
    headers.set("Brainbase-Deployment-Id", context.placement.deployment_id);
  }
  try {
    const response = await service.fetch(`${CANONICAL_ORIGIN}${RUNTIME_PREFIX}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await responseBody(response);
    if (!response.ok) {
      const problem = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const code = nonEmpty(problem.code, 128) ? problem.code : "UPSTREAM_UNAVAILABLE";
      throw new TenantBoundaryError("worker_ingress", code, code, {
        status: response.status,
        ...(typeof problem.retryable === "boolean" ? { retryable: problem.retryable } : {}),
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    throw new TenantBoundaryError("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
}

function canonicalContext(value: unknown): TenantContextEnvelope {
  const context = record(value) as unknown as TenantContextEnvelope;
  if (context.protocol_id !== "mana-brainbase-tenant-context"
    || !context.integrity || context.integrity.method !== "jws_detached"
    || !context.workspace_connection?.connection_id || !context.placement?.deployment_id) {
    throw new TenantBoundaryError("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
  return structuredClone(context);
}

function hasAuthorityScope(context: TenantContextEnvelope, expected: string): boolean {
  return context.authorization.data_scopes.includes(expected);
}

function hasAuthorityPrefix(context: TenantContextEnvelope, prefix: string): boolean {
  return context.authorization.data_scopes.some((scope) => scope.startsWith(prefix));
}

function assertServiceAuthority(
  context: TenantContextEnvelope,
  input: ResolveAutonomyTenantContextInput,
  desiredEffect: DesiredEffect,
): void {
  if (context.actor.principal_type !== "service"
    || context.actor.authenticated_subject_id !== input.actorId) {
    throw new TenantBoundaryError("worker_ingress", "ACTOR_SCOPE_MISMATCH");
  }
  if (context.slack.requester_id !== undefined) {
    throw new TenantBoundaryError("worker_ingress", "ACTOR_SCOPE_MISMATCH");
  }
  if (context.workspace_connection.workspace_id !== input.workspaceConnection.workspace_id
    || context.workspace_connection.app_id !== input.workspaceConnection.app_id) {
    throw new TenantBoundaryError("worker_ingress", "WORKSPACE_OR_APP_MISMATCH");
  }
  if (context.slack.event_id !== input.runId
    || context.slack.channel_id !== input.channelId
    || context.slack.thread_ts !== input.runId) {
    throw new TenantBoundaryError("worker_ingress", "DELIVERY_SCOPE_MISMATCH");
  }
  resolveCanonicalProjectScope(context.authorization, [input.project], "worker_ingress");
  if (!context.authorization.capability_ids.includes(input.capabilityId)) {
    throw new TenantBoundaryError("worker_ingress", "CAPABILITY_SCOPE_MISMATCH");
  }
  if (!hasAuthorityScope(context, `company_authority:effect:${desiredEffect}`)) {
    throw new TenantBoundaryError("worker_ingress", "COMPANY_AUTHORITY_EFFECT_MISMATCH");
  }
  for (const prefix of REQUIRED_AUTHORITY_PREFIXES) {
    if (!hasAuthorityPrefix(context, prefix)) {
      throw new TenantBoundaryError("worker_ingress", "COMPANY_AUTHORITY_EVIDENCE_MISSING", prefix);
    }
  }
  if (hasAuthorityScope(context, "company_authority:decision:deny")) {
    throw new TenantBoundaryError("worker_ingress", "COMPANY_AUTHORITY_DENIED");
  }
}

function authoritativeSnapshot(
  response: unknown,
  context: TenantContextEnvelope,
  hint: WorkspaceConnectionSnapshot,
): WorkspaceConnectionSnapshot {
  const value = record(response);
  if (value.valid !== true || value.authoritative !== true) {
    throw new TenantBoundaryError("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  const revision = String(value.connection_revision ?? context.workspace_connection.connection_revision);
  if (revision !== context.workspace_connection.connection_revision
    || context.workspace_connection.connection_id !== hint.connection_id
    || context.workspace_connection.workspace_id !== hint.workspace_id
    || context.workspace_connection.app_id !== hint.app_id) {
    throw new TenantBoundaryError("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  return {
    ...structuredClone(hint),
    connection_revision: revision,
    status: context.workspace_connection.status,
    deployment_id: context.placement.deployment_id,
    profile: context.placement.profile,
    contract_revision: context.contract_revision,
  };
}

export async function resolveAutonomyTenantContext(
  input: ResolveAutonomyTenantContextInput,
): Promise<ResolvedAutonomyTenantContext> {
  if (!nonEmpty(input.tenantRevision, 128)
    || !nonEmpty(input.actorId, 128)
    || !nonEmpty(input.project, 128)
    || !nonEmpty(input.capabilityId, 128)
    || !nonEmpty(input.audience, 128)
    || !nonEmpty(input.runId, 500)
    || !nonEmpty(input.channelId, 128)
    || !Number.isFinite(Date.parse(input.now))) {
    throw new TenantBoundaryError("worker_ingress", "SCHEMA_INVALID");
  }
  if (input.workspaceConnection.status !== "active") {
    throw new TenantBoundaryError("worker_ingress", "WORKSPACE_CONNECTION_REAUTH_REQUIRED");
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TenantBoundaryError("runtime_configuration", "CONFIGURATION_INVALID");
  }
  const desiredEffect = desiredEffectForCapability(input.capabilityId);
  const seed = [input.workspaceConnection.tenant_id, input.workspaceConnection.connection_id, input.runId].join(":");
  const issueBody = {
    tenant_id: input.workspaceConnection.tenant_id,
    expected_tenant_revision: input.tenantRevision,
    connection_id: input.workspaceConnection.connection_id,
    expected_connection_revision: input.workspaceConnection.connection_revision,
    workspace_id: input.workspaceConnection.workspace_id,
    app_id: input.workspaceConnection.app_id,
    provider_identity: {
      provider: "service",
      authenticated_subject_id: input.actorId,
      workspace_id: input.workspaceConnection.workspace_id,
      app_id: input.workspaceConnection.app_id,
    },
    requested_action: {
      capability_id: input.capabilityId,
      resource_ref: `project:${input.project}`,
      project_hint: input.project,
      project_ids: [input.project],
      desired_effect: desiredEffect,
    },
    slack: {
      event_id: input.runId,
      channel_id: input.channelId,
      thread_ts: input.runId,
    },
    correlation_id: await createDeterministicSharedId("cor_", seed),
    operation_id: await createDeterministicSharedId("op_", seed),
  };
  const context = canonicalContext(await postJson(
    input.service,
    "/tenant-context:resolve",
    issueBody,
    timeoutMs,
  ));
  assertServiceAuthority(context, input, desiredEffect);

  const snapshot = authoritativeSnapshot(await postJson(
    input.service,
    "/workspace-connections:validate-revision",
    {
      tenant_context: context,
      connection_id: context.workspace_connection.connection_id,
      expected_connection_revision: context.workspace_connection.connection_revision,
    },
    timeoutMs,
    context,
  ), context, input.workspaceConnection);

  const expectedScope: ExpectedTenantScope = {
    audience: input.audience,
    workspace_id: input.workspaceConnection.workspace_id,
    app_id: input.workspaceConnection.app_id,
    channel_id: input.channelId,
    thread_ts: input.runId,
    actor_principal_id: context.actor.principal_id,
    project_id: context.authorization.project_ids[0]!,
    project_ids: [...context.authorization.project_ids],
    capability_id: input.capabilityId,
    deployment_id: context.placement.deployment_id,
  };
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: async () => snapshot,
    resolve_verification_key: input.resolveVerificationKey,
  });
  await verifier.validate({
    boundary: "worker_ingress",
    tenant_context: context,
    expected_scope: expectedScope,
    now: input.now,
  });
  return {
    tenant_context: context,
    authoritative_snapshot: snapshot,
    expected_scope: expectedScope,
  };
}
