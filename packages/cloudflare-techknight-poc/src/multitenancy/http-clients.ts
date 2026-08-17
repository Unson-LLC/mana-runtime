import type {
  CredentialLease,
  CredentialLeaseRequest,
  DeploymentProfileName,
  QuotaDecision,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import type { OperationReceipt, UsageEvent } from "./accounting.js";
import type { CredentialBrokerClient } from "./credentials.js";
import type { TenantAuthorityClient, TenantContextIssueRequest } from "./runtime-boundaries.js";
import type { WorkspaceConnectionLookup } from "./workspace-connection.js";
import {
  CanonicalContractError,
  validateCanonicalCredentialLease,
  validateCanonicalOperationReceipt,
  validateCanonicalQuotaDecision,
  validateCanonicalUsageEvent,
} from "./canonical-consumer.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export interface TenantRuntimeHttpBindings {
  deployment_profile: DeploymentProfileName;
  tenant_authority_url: string;
  credential_broker_url: string;
  quota_url: string;
  accounting_url: string;
  api_token: string;
  timeout_ms: number;
}

export interface TenantQuotaHttpClient {
  read_authoritative_decision(input: {
    tenant_id: string;
    contract_revision: string;
    unit: string;
  }): Promise<QuotaDecision>;
}

export interface TenantAccountingHttpClient {
  write(input: {
    partition_key: string;
    usage_events: readonly UsageEvent[];
    receipt: OperationReceipt;
  }): Promise<{ result_ref: string }>;
}

export interface TenantRuntimeHttpClients {
  authority: TenantAuthorityClient;
  credential_broker: CredentialBrokerClient;
  quota: TenantQuotaHttpClient;
  accounting: TenantAccountingHttpClient;
}

interface HttpDependencies {
  fetch: typeof fetch;
  now(): string;
}

function nonEmpty(value: string, code = "CONFIGURATION_INVALID"): string {
  if (!value.trim()) deny("runtime_configuration", code);
  return value;
}

function endpoint(value: string): string {
  const parsed = new URL(nonEmpty(value));
  if (parsed.protocol !== "https:") deny("runtime_configuration", "CONFIGURATION_INVALID");
  return parsed.toString();
}

function validateBindings(bindings: TenantRuntimeHttpBindings): TenantRuntimeHttpBindings {
  if (!(["shared_cloud", "dedicated_cloud", "customer_managed_oss"] as const)
    .includes(bindings.deployment_profile)) deny("runtime_configuration", "CONFIGURATION_INVALID");
  if (!Number.isInteger(bindings.timeout_ms) || bindings.timeout_ms < 1 || bindings.timeout_ms > 30_000) {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  return {
    ...bindings,
    tenant_authority_url: endpoint(bindings.tenant_authority_url),
    credential_broker_url: endpoint(bindings.credential_broker_url),
    quota_url: endpoint(bindings.quota_url),
    accounting_url: endpoint(bindings.accounting_url),
    api_token: nonEmpty(bindings.api_token),
  };
}

function responseRecord(value: unknown, boundary: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny(boundary, "UPSTREAM_UNAVAILABLE");
  return value as Record<string, unknown>;
}

function assertSnapshot(value: unknown): WorkspaceConnectionSnapshot {
  const snapshot = responseRecord(value, "workspace_connection") as unknown as WorkspaceConnectionSnapshot;
  const requiredStrings: (keyof WorkspaceConnectionSnapshot)[] = [
    "connection_id", "connection_revision", "tenant_id", "installation_id", "workspace_id", "app_id",
    "installer_id", "status", "deployment_id", "profile", "credential_mode", "contract_revision",
  ];
  if (requiredStrings.some((key) => typeof snapshot[key] !== "string" || String(snapshot[key]).length === 0)
    || !Array.isArray(snapshot.granted_scopes)
    || snapshot.granted_scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
    deny("workspace_connection", "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
  return structuredClone(snapshot);
}

function boundaryError(boundary: string, code: string, error: unknown): never {
  if (error instanceof TenantBoundaryError) throw error;
  throw new TenantBoundaryError(boundary, code);
}

async function postJson(
  bindings: TenantRuntimeHttpBindings,
  dependencies: HttpDependencies,
  url: string,
  body: unknown,
  boundary: string,
  unavailableCode = "UPSTREAM_UNAVAILABLE",
): Promise<unknown> {
  assertSecretArtifactFree(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), bindings.timeout_ms);
  try {
    const response = await dependencies.fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bindings.api_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new TenantBoundaryError(boundary, unavailableCode);
    return await response.json();
  } catch (error) {
    boundaryError(boundary, unavailableCode, error);
  } finally {
    clearTimeout(timeout);
  }
}

export function createTenantRuntimeHttpClients(
  inputBindings: TenantRuntimeHttpBindings,
  inputDependencies: Partial<HttpDependencies> = {},
): TenantRuntimeHttpClients {
  const bindings = validateBindings(inputBindings);
  const dependencies: HttpDependencies = {
    fetch: inputDependencies.fetch ?? fetch,
    now: inputDependencies.now ?? (() => new Date().toISOString()),
  };
  const authorityCall = async <T>(operation: string, input: unknown, unavailableCode: string): Promise<T> => {
    const response = responseRecord(await postJson(bindings, dependencies, bindings.tenant_authority_url,
      { operation, input }, "worker_ingress", unavailableCode), "worker_ingress");
    if (!("result" in response)) deny("worker_ingress", unavailableCode);
    return structuredClone(response.result) as T;
  };

  return {
    authority: {
      async resolve_workspace_connection(lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot> {
        return assertSnapshot(await authorityCall("resolve_workspace_connection", lookup,
          "WORKSPACE_CONNECTION_UNAVAILABLE"));
      },
      async read_workspace_connection(connectionId: string): Promise<WorkspaceConnectionSnapshot> {
        return assertSnapshot(await authorityCall("read_workspace_connection", { connection_id: connectionId },
          "WORKSPACE_CONNECTION_UNAVAILABLE"));
      },
      async issue_tenant_context(request: TenantContextIssueRequest): Promise<TenantContextEnvelope> {
        const result = await authorityCall<unknown>("issue_tenant_context", request, "UPSTREAM_UNAVAILABLE");
        return structuredClone(responseRecord(result, "worker_ingress")) as unknown as TenantContextEnvelope;
      },
    },
    credential_broker: {
      async acquire_lease(request: CredentialLeaseRequest): Promise<CredentialLease> {
        const response = responseRecord(await postJson(bindings, dependencies, bindings.credential_broker_url,
          request, "credential_lease"), "credential_lease");
        const result = ("result" in response ? response.result : response) as CredentialLease;
        try {
          validateCanonicalCredentialLease(request, result, { now: dependencies.now() });
        } catch (error) {
          if (error instanceof CanonicalContractError) deny("credential_lease", error.code, error.details);
          throw error;
        }
        return structuredClone(result);
      },
    },
    quota: {
      async read_authoritative_decision(input): Promise<QuotaDecision> {
        const response = responseRecord(await postJson(bindings, dependencies, bindings.quota_url,
          input, "quota"), "quota");
        const result = ("result" in response ? response.result : response) as QuotaDecision;
        try {
          validateCanonicalQuotaDecision(result);
        } catch (error) {
          if (error instanceof CanonicalContractError) deny("quota", error.code, error.details);
          throw error;
        }
        return structuredClone(result);
      },
    },
    accounting: {
      async write(input): Promise<{ result_ref: string }> {
        for (const usage of input.usage_events) validateCanonicalUsageEvent(usage);
        validateCanonicalOperationReceipt(input.receipt);
        const response = responseRecord(await postJson(bindings, dependencies, bindings.accounting_url,
          { partition_key: input.partition_key, usage_events: input.usage_events, receipt: input.receipt },
          "brainbase_proxy"), "brainbase_proxy");
        const result = ("result" in response ? response.result : response) as { result_ref?: unknown };
        if (!result || typeof result.result_ref !== "string" || !result.result_ref) {
          deny("brainbase_proxy", "UPSTREAM_UNAVAILABLE");
        }
        return { result_ref: result.result_ref };
      },
    },
  };
}
