import type {
  CredentialLease,
  CredentialLeaseRequest,
  DeploymentProfileName,
  QuotaDecision,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { TENANT_QUOTA_METRIC, TENANT_QUOTA_REQUESTED_QUANTITY } from "./contracts.js";
import type { OperationReceipt, UsageEvent } from "./accounting.js";
import type { CredentialBrokerClient } from "./credentials.js";
import type { TenantAuthorityClient, TenantContextIssueRequest } from "./runtime-boundaries.js";
import type {
  CompanyAuthorityClient,
  CompanyAuthorityResolution,
  CompanyAuthorityDesiredEffect,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";
import type { WorkspaceConnectionLookup, WorkspaceConnectionManagementPort } from "./workspace-connection.js";
import {
  CanonicalContractError,
  validateCanonicalCredentialLease,
  validateCanonicalOperationReceipt,
  validateCanonicalQuotaDecision,
  validateCanonicalUsageEvent,
} from "./canonical-consumer.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { createDeterministicSharedId } from "./ids.js";
import { assertSecretArtifactFree } from "./secret-guard.js";
import { resolveCanonicalProjectScope } from "./project-scope.js";

const CANONICAL_ORIGIN = "https://brainbase.internal";
const RUNTIME_PREFIX = "/api/v1/runtime";

type DesiredEffect = CompanyAuthorityDesiredEffect;

export interface TenantRuntimeServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkspaceConnectionHint extends WorkspaceConnectionSnapshot {
  tenant_revision: string;
}

export function parseWorkspaceConnectionHints(value: string | undefined): WorkspaceConnectionHint[] {
  if (!value?.trim()) deny("runtime_configuration", "CONFIGURATION_INVALID", {
    missing: "BRAINBASE_WORKSPACE_CONNECTIONS_JSON",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  if (!Array.isArray(parsed)) deny("runtime_configuration", "CONFIGURATION_INVALID");
  const hints = parsed as WorkspaceConnectionHint[];
  if (hints.length === 0 || hints.some((hint) => !hint || typeof hint !== "object"
    || !hint.tenant_id || !hint.tenant_revision || !hint.connection_id || !hint.connection_revision
    || !hint.installation_id || !hint.workspace_id || !hint.app_id || !hint.installer_id
    || !Array.isArray(hint.granted_scopes)
    || hint.granted_scopes.some((scope) => typeof scope !== "string" || !scope.trim())
    || hint.status !== "active"
    || !hint.deployment_id
    || !(["shared_cloud", "dedicated_cloud", "customer_managed_oss"] as const).includes(hint.profile)
    || !(["cloud_standard", "customer_oauth", "customer_api"] as const).includes(hint.credential_mode)
    || !hint.contract_revision)) {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  return structuredClone(hints);
}

export interface TenantRuntimeHttpBindings {
  deployment_profile: DeploymentProfileName;
  service?: TenantRuntimeServiceBinding;
  timeout_ms: number;
  workspace_connections?: readonly WorkspaceConnectionHint[];
  tenant_context?: TenantContextEnvelope;
  /** Canonical capability-to-effect map for strict tenant ingress callers. */
  desired_effect_by_capability?: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
}

export interface TenantQuotaHttpClient {
  read_authoritative_decision(input: {
    tenant_context: TenantContextEnvelope;
    metric: string;
    requested_quantity: number;
  }): Promise<QuotaDecision>;
}

/**
 * Mana charges one tool call per admitted runtime operation.  The quota
 * request metric is deliberately independent from the UsageEvent unit: the
 * latter describes what we could observe (for example model_tokens), while
 * this request is the authoritative admission decision for the operation.
 */
function assertTenantQuotaRequest(input: {
  metric: string;
  requested_quantity: number;
}): void {
  // Do not normalize or fall back here.  A missing or mismatched metric must
  // fail before a request can consume quota under an unintended dimension.
  if (input.metric !== TENANT_QUOTA_METRIC
    || input.requested_quantity !== TENANT_QUOTA_REQUESTED_QUANTITY) {
    deny("quota", "QUOTA_INPUT_INVALID");
  }
}

export interface TenantAccountingHttpClient {
  write(input: {
    tenant_context: TenantContextEnvelope;
    partition_key: string;
    usage_events: readonly UsageEvent[];
    receipt: OperationReceipt;
  }): Promise<{ result_ref: string }>;
}

export interface TenantRuntimeHttpClients {
  authority: TenantAuthorityClient;
  company_authority: CompanyAuthorityClient;
  workspace_connections: WorkspaceConnectionManagementPort;
  credential_broker: CredentialBrokerClient;
  quota: TenantQuotaHttpClient;
  accounting: TenantAccountingHttpClient;
}

interface HttpDependencies {
  now(): string;
}

function validateBindings(bindings: TenantRuntimeHttpBindings): Required<Pick<TenantRuntimeHttpBindings,
  "deployment_profile" | "service" | "timeout_ms">> & TenantRuntimeHttpBindings {
  if (!( ["shared_cloud", "dedicated_cloud", "customer_managed_oss"] as const)
    .includes(bindings.deployment_profile)) deny("runtime_configuration", "CONFIGURATION_INVALID");
  if (!bindings.service || typeof bindings.service.fetch !== "function") {
    deny("runtime_configuration", "CONFIGURATION_INVALID", { missing: "BRAINBASE_TENANT_RUNTIME_SERVICE" });
  }
  if (!Number.isInteger(bindings.timeout_ms) || bindings.timeout_ms < 1 || bindings.timeout_ms > 30_000) {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  return bindings as Required<Pick<TenantRuntimeHttpBindings,
    "deployment_profile" | "service" | "timeout_ms">> & TenantRuntimeHttpBindings;
}

function record(value: unknown, boundary: string, code = "UPSTREAM_UNAVAILABLE"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny(boundary, code);
  return value as Record<string, unknown>;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function upstreamError(boundary: string, status: number, body: unknown, fallbackCode: string): never {
  const problem = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const code = typeof problem.code === "string" && problem.code ? problem.code : fallbackCode;
  throw new TenantBoundaryError(boundary, code, code, {
    status,
    ...(typeof problem.retryable === "boolean" ? { retryable: problem.retryable } : {}),
    ...(typeof problem.fault_domain === "string" ? { fault_domain: problem.fault_domain } : {}),
  });
}

function contextHeaders(context?: TenantContextEnvelope): Headers {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  if (context) {
    headers.set("Brainbase-Protocol-Version", context.protocol_version);
    headers.set("Brainbase-Deployment-Id", context.placement.deployment_id);
  }
  return headers;
}

async function postJson(
  bindings: ReturnType<typeof validateBindings>,
  path: string,
  body: unknown,
  boundary: string,
  context?: TenantContextEnvelope,
  unavailableCode = "UPSTREAM_UNAVAILABLE",
): Promise<unknown> {
  assertSecretArtifactFree(body);
  let phase = "fetch";
  try {
    const response = await bindings.service.fetch(`${CANONICAL_ORIGIN}${RUNTIME_PREFIX}${path}`, {
      method: "POST",
      headers: contextHeaders(context),
      body: JSON.stringify(body),
      // Cloudflare Service Bindings reject RequestRedirect "error" before the
      // target Worker is invoked. "manual" preserves fail-closed redirect
      // handling while remaining valid at the edge.
      redirect: "manual",
      signal: AbortSignal.timeout(bindings.timeout_ms),
    });
    phase = "response_body";
    const parsed = await responseBody(response);
    phase = "response_status";
    if (!response.ok) upstreamError(boundary, response.status, parsed, unavailableCode);
    phase = "response_contract";
    return parsed;
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    throw new TenantBoundaryError(boundary, unavailableCode, unavailableCode, {
      phase,
      path,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function sameLookup(snapshot: WorkspaceConnectionSnapshot, lookup: WorkspaceConnectionLookup): boolean {
  return snapshot.app_id === lookup.app_id
    && snapshot.workspace_id === lookup.workspace_id
    && (lookup.enterprise_id === undefined || snapshot.enterprise_id === lookup.enterprise_id);
}

function resolveHint(hints: readonly WorkspaceConnectionHint[], lookup: WorkspaceConnectionLookup): WorkspaceConnectionHint {
  const matches = hints.filter((hint) => sameLookup(hint, lookup));
  if (matches.length === 0) deny("workspace_connection", "TENANT_UNKNOWN");
  if (matches.length !== 1) deny("workspace_connection", "TENANT_AMBIGUOUS");
  return structuredClone(matches[0]);
}

function publicSnapshot(hint: WorkspaceConnectionHint): WorkspaceConnectionSnapshot {
  const { tenant_revision: _tenantRevision, ...snapshot } = hint;
  return structuredClone(snapshot);
}

function canonicalContext(value: unknown): TenantContextEnvelope {
  const context = record(value, "worker_ingress") as unknown as TenantContextEnvelope;
  if (context.protocol_id !== "mana-brainbase-tenant-context"
    || !context.integrity || context.integrity.method !== "jws_detached"
    || !context.workspace_connection?.connection_id || !context.placement?.deployment_id) {
    deny("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
  return structuredClone(context);
}

function desiredEffectForCapability(
  capabilityId: string,
  desiredEffectByCapability?: Readonly<Record<string, CompanyAuthorityDesiredEffect>>,
): DesiredEffect {
  if (desiredEffectByCapability !== undefined) {
    const desiredEffect = desiredEffectByCapability[capabilityId];
    if (!desiredEffect) {
      deny("worker_ingress", "DESIRED_EFFECT_REQUIRED", { capability_id: capabilityId });
    }
    return desiredEffect;
  }
  // runtime.execute is an externally-effectful capability. Never infer its
  // effect from a capability name when the canonical map was not supplied.
  if (capabilityId === "runtime.execute") {
    deny("worker_ingress", "DESIRED_EFFECT_REQUIRED", { capability_id: capabilityId });
  }
  const value = capabilityId.toLowerCase();
  if (/(send|publish|post|deliver|external)/u.test(value)) return "external_side_effect";
  if (/(create|write|update|transition|delete|apply|approve|reject)/u.test(value)) return "write";
  return "read";
}

function hasAuthorityScope(context: TenantContextEnvelope, expected: string): boolean {
  return context.authorization.data_scopes.includes(expected);
}

function hasAuthorityPrefix(context: TenantContextEnvelope, prefix: string): boolean {
  return context.authorization.data_scopes.some((scope) => scope.startsWith(prefix));
}

function assertExactProjectScope(
  context: TenantContextEnvelope,
  trustedProjectCodes: readonly string[],
): void {
  resolveCanonicalProjectScope(context.authorization, trustedProjectCodes, "worker_ingress");
}

function assertCanonicalCompanyAuthority(
  context: TenantContextEnvelope,
  request: TenantContextIssueRequest,
  desiredEffect: DesiredEffect,
): void {
  if (context.actor.authenticated_subject_id !== request.slack.requester_id) {
    deny("worker_ingress", "ACTOR_SCOPE_MISMATCH");
  }
  if (request.trusted_project_ids) {
    assertExactProjectScope(context, request.trusted_project_ids);
  } else if (!context.authorization.project_ids.includes(request.required_authorization.project_id)) {
    deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  }
  if (!context.authorization.capability_ids.includes(request.required_authorization.capability_id)) {
    deny("worker_ingress", "CAPABILITY_SCOPE_MISMATCH");
  }
  if (!hasAuthorityScope(context, `company_authority:effect:${desiredEffect}`)) {
    deny("worker_ingress", "COMPANY_AUTHORITY_EFFECT_MISMATCH");
  }
  for (const prefix of [
    "company_authority:decision:",
    "company_authority:membership:",
    "company_authority:resource:",
    "company_authority:raci:",
    "company_authority:policy:",
    "company_authority:placement:",
    "company_authority:identity_receipt:",
    "company_authority:authority_receipt:",
  ]) {
    if (!hasAuthorityPrefix(context, prefix)) {
      deny("worker_ingress", "COMPANY_AUTHORITY_EVIDENCE_MISSING", { missing: prefix });
    }
  }
  if (hasAuthorityScope(context, "company_authority:decision:deny")) {
    deny("worker_ingress", "COMPANY_AUTHORITY_DENIED");
  }
}

function canonicalSnapshot(
  response: unknown,
  context: TenantContextEnvelope,
  hint?: WorkspaceConnectionHint,
): WorkspaceConnectionSnapshot {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    deny("workspace_connection", "WORKSPACE_CONNECTION_UNAVAILABLE", {
      phase: "response_contract",
      path: "/workspace-connections:validate-revision",
      error_name: response === undefined ? "EmptyResponseBody" : "InvalidResponseBody",
    });
  }
  const value = response as Record<string, unknown>;
  const installation = value.installation && typeof value.installation === "object"
    ? value.installation as Record<string, unknown>
    : {};
  const credential = value.credential && typeof value.credential === "object"
    ? value.credential as Record<string, unknown>
    : {};
  const snapshot: WorkspaceConnectionSnapshot = {
    connection_id: context.workspace_connection.connection_id,
    connection_revision: String(value.connection_revision ?? context.workspace_connection.connection_revision),
    tenant_id: context.tenant.tenant_id,
    installation_id: String(installation.installation_id ?? context.workspace_connection.installation_id),
    workspace_id: String(value.workspace_id ?? context.workspace_connection.workspace_id),
    ...(context.workspace_connection.enterprise_id ? { enterprise_id: context.workspace_connection.enterprise_id } : {}),
    app_id: String(value.app_id ?? context.workspace_connection.app_id),
    installer_id: String(installation.installer_id ?? hint?.installer_id ?? "brainbase-control-plane"),
    granted_scopes: Array.isArray(value.granted_scopes)
      ? value.granted_scopes.filter((entry): entry is string => typeof entry === "string")
      : [...(hint?.granted_scopes ?? [])],
    status: String(value.status ?? context.workspace_connection.status) as WorkspaceConnectionSnapshot["status"],
    deployment_id: context.placement.deployment_id,
    profile: context.placement.profile,
    credential_mode: String(credential.mode ?? hint?.credential_mode ?? context.credential.mode) as WorkspaceConnectionSnapshot["credential_mode"],
    contract_revision: context.contract_revision,
  };
  if (value.valid !== true || value.authoritative !== true) {
    deny("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  return snapshot;
}

function usageBody(context: TenantContextEnvelope, usage: UsageEvent): Record<string, unknown> {
  return {
    tenant_context: context,
    message_type: usage.message_type,
    usage_event_id: usage.usage_event_id,
    protocol_version: usage.protocol_version,
    kind: usage.kind,
    quantity: usage.quantity,
    unit: usage.unit,
    collection_state: usage.collection_state,
    outcome: usage.outcome,
    ...(usage.failure_code !== undefined ? { failure_code: usage.failure_code } : {}),
    ...(usage.unknown_fields !== undefined ? { unknown_fields: usage.unknown_fields } : {}),
    observed_at: usage.observed_at,
  };
}

function receiptBody(context: TenantContextEnvelope, receipt: OperationReceipt): Record<string, unknown> {
  return {
    tenant_context: context,
    message_type: receipt.message_type,
    receipt_id: receipt.receipt_id,
    protocol_version: receipt.protocol_version,
    operation_ids: receipt.operation_ids,
    idempotency_keys: receipt.idempotency_keys,
    actor_principal_id: receipt.actor_principal_id,
    project_id: receipt.project_id,
    capability_id: receipt.capability_id,
    quota_decision: receipt.quota_decision,
    credential_mode: receipt.credential_mode,
    collection_state: receipt.collection_state,
    outcome: receipt.outcome,
    ...(receipt.failure_code !== undefined ? { failure_code: receipt.failure_code } : {}),
    usage_event_ids: receipt.usage_event_ids,
    reply: receipt.reply,
    completed_at: receipt.completed_at,
  };
}

export function createTenantRuntimeHttpClients(
  inputBindings: TenantRuntimeHttpBindings,
  dependencies: Partial<HttpDependencies> = {},
): TenantRuntimeHttpClients {
  const bindings = validateBindings(inputBindings);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const hints = bindings.workspace_connections ?? [];
  const contexts = new Map<string, TenantContextEnvelope>();
  if (bindings.tenant_context) {
    contexts.set(bindings.tenant_context.workspace_connection.connection_id, structuredClone(bindings.tenant_context));
  }

  const resolve = async (lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot> => {
    return publicSnapshot(resolveHint(hints, lookup));
  };

  const read = async (connectionId: string): Promise<WorkspaceConnectionSnapshot> => {
    const context = contexts.get(connectionId);
    if (!context) deny("workspace_connection", "WORKSPACE_CONNECTION_UNAVAILABLE");
    const response = await postJson(bindings, "/workspace-connections:validate-revision", {
      tenant_context: context,
      connection_id: context.workspace_connection.connection_id,
      expected_connection_revision: context.workspace_connection.connection_revision,
    }, "workspace_connection", context, "WORKSPACE_CONNECTION_UNAVAILABLE");
    return canonicalSnapshot(response, context, hints.find((hint) => hint.connection_id === connectionId));
  };

  const resolveCompanyAuthority = async (
    request: ObservedExecutionRequestV1,
  ): Promise<CompanyAuthorityResolution> => {
    const response = await postJson(
      bindings,
      "/company-authority:resolve",
      request,
      "company_authority",
    );
    // A successful HTTP response with malformed JSON is evidence of no
    // authority response, not a resolved response. Valid JSON remains
    // intentionally opaque so the adapter owns signature and scope checks.
    if (response === undefined) return { state: "not_collected" };
    return { state: "resolved", response };
  };

  return {
    authority: {
      resolve_workspace_connection: resolve,
      read_workspace_connection: read,
      async issue_tenant_context(request: TenantContextIssueRequest): Promise<TenantContextEnvelope> {
        const seed = [request.workspace_connection.tenant_id, request.workspace_connection.connection_id,
          request.slack.event_id].join(":");
        const desiredEffect = desiredEffectForCapability(
          request.required_authorization.capability_id,
          bindings.desired_effect_by_capability,
        );
        const trustedProjectIds = request.trusted_project_ids
          ? [...request.trusted_project_ids]
          : undefined;
        if (trustedProjectIds !== undefined && (
          trustedProjectIds.length === 0 ||
          trustedProjectIds.some((projectId) => typeof projectId !== "string" || projectId.trim().length === 0) ||
          new Set(trustedProjectIds).size !== trustedProjectIds.length ||
          !trustedProjectIds.includes(request.required_authorization.project_id)
        )) {
          deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
        }
        const body = {
          tenant_id: request.workspace_connection.tenant_id,
          expected_tenant_revision: request.tenant_revision
            ?? hints.find((hint) => hint.connection_id === request.workspace_connection.connection_id)?.tenant_revision,
          connection_id: request.workspace_connection.connection_id,
          expected_connection_revision: request.workspace_connection.connection_revision,
          workspace_id: request.workspace_connection.workspace_id,
          app_id: request.workspace_connection.app_id,
          provider_identity: {
            provider: request.provider_identity?.provider ?? "slack",
            authenticated_subject_id: request.provider_identity?.authenticated_subject_id
              ?? request.slack.requester_id,
            workspace_id: request.provider_identity?.workspace_id
              ?? request.workspace_connection.workspace_id,
            app_id: request.provider_identity?.app_id ?? request.workspace_connection.app_id,
            ...(request.provider_identity?.enterprise_id || request.slack.enterprise_id
              ? { enterprise_id: request.provider_identity?.enterprise_id ?? request.slack.enterprise_id }
              : {}),
          },
          requested_action: {
            capability_id: request.required_authorization.capability_id,
            resource_ref: `project:${request.required_authorization.project_id}`,
            project_hint: request.required_authorization.project_id,
            ...(trustedProjectIds ? { project_ids: trustedProjectIds } : {}),
            desired_effect: desiredEffect,
          },
          slack: request.slack,
          correlation_id: request.correlation_id ?? await createDeterministicSharedId("cor_", seed),
          operation_id: request.operation_id ?? await createDeterministicSharedId("op_", seed),
        };
        if (!body.expected_tenant_revision) deny("worker_ingress", "WORKSPACE_CONNECTION_UNAVAILABLE");
        const context = canonicalContext(await postJson(bindings, "/tenant-context:resolve", body, "worker_ingress"));
        assertCanonicalCompanyAuthority(context, request, desiredEffect);
        contexts.set(context.workspace_connection.connection_id, structuredClone(context));
        return context;
      },
    },
    company_authority: {
      resolve: resolveCompanyAuthority,
    },
    workspace_connections: {
      async register_slack_installation(): Promise<WorkspaceConnectionSnapshot> {
        deny("workspace_connection", "FALLBACK_FORBIDDEN", { owner: "brainbase_control_plane" });
      },
      async revise_workspace_connection(): Promise<WorkspaceConnectionSnapshot> {
        deny("workspace_connection", "FALLBACK_FORBIDDEN", { owner: "brainbase_control_plane" });
      },
      resolve_workspace_connection: resolve,
    },
    credential_broker: {
      async acquire_lease(request: CredentialLeaseRequest, tenantContext?: TenantContextEnvelope): Promise<CredentialLease> {
        if (!tenantContext) deny("credential_lease", "TENANT_CONTEXT_REQUIRED");
        const response = record(await postJson(bindings, "/credential-leases", {
          tenant_context: tenantContext,
          message_type: request.message_type,
          protocol_version: request.protocol_version,
          binding: request.binding,
          requested_ttl_seconds: request.requested_ttl_seconds,
        }, "credential_lease", tenantContext), "credential_lease") as unknown as CredentialLease;
        try {
          validateCanonicalCredentialLease(request, response, { now: now() });
        } catch (error) {
          if (error instanceof CanonicalContractError) deny("credential_lease", error.code, error.details);
          throw error;
        }
        return structuredClone(response);
      },
    },
    quota: {
      async read_authoritative_decision(input): Promise<QuotaDecision> {
        assertTenantQuotaRequest(input);
        const response = record(await postJson(bindings, "/quota:decide", {
          tenant_context: input.tenant_context,
          metric: TENANT_QUOTA_METRIC,
          requested_quantity: TENANT_QUOTA_REQUESTED_QUANTITY,
        }, "quota", input.tenant_context), "quota") as unknown as QuotaDecision;
        try {
          validateCanonicalQuotaDecision(response);
        } catch (error) {
          if (error instanceof CanonicalContractError) deny("quota", error.code, error.details);
          throw error;
        }
        if (response.unit !== input.metric) deny("quota", "CROSS_TENANT_CANDIDATE");
        return structuredClone(response);
      },
    },
    accounting: {
      async write(input): Promise<{ result_ref: string }> {
        for (const usage of input.usage_events) {
          validateCanonicalUsageEvent(usage);
          await postJson(bindings, "/usage-events", usageBody(input.tenant_context, usage),
            "brainbase_proxy", input.tenant_context);
        }
        validateCanonicalOperationReceipt(input.receipt);
        const response = record(await postJson(bindings, "/operation-receipts:finalize",
          receiptBody(input.tenant_context, input.receipt), "brainbase_proxy", input.tenant_context),
        "brainbase_proxy");
        const receiptId = typeof response.receipt_id === "string" ? response.receipt_id : input.receipt.receipt_id;
        return { result_ref: receiptId };
      },
    },
  };
}
