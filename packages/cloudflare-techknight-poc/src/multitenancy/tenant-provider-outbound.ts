import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./durable-tenant-boundary.js";
import { createTenantRuntimeHttpClients, parseWorkspaceConnectionHints } from "./http-clients.js";
import { createTenantCredentialFetch } from "./tenant-credential-fetch.js";
import type { DeploymentProfileName } from "./contracts.js";
import {
  createBrainbaseTrustedProviderForwarderFromEnv,
  type TrustedProviderForwarder,
} from "./trusted-provider-forwarder.js";

export interface TenantProviderOutboundEnv {
  MANA_DEPLOYMENT_PROFILE?: string;
  BRAINBASE_TENANT_AUTHORITY_URL?: string;
  BRAINBASE_CREDENTIAL_BROKER_URL?: string;
  BRAINBASE_QUOTA_URL?: string;
  BRAINBASE_ACCOUNTING_URL?: string;
  BRAINBASE_RUNTIME_API_TOKEN?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_WORKSPACE_CONNECTIONS_JSON?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
  BRAINBASE_TENANT_RUNTIME_ENABLED?: string;
  BRAINBASE_TENANT_RUNTIME_HOST?: string;
  BRAINBASE_TENANT_RUNTIME_PORT?: string;
  BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  NOCODB_URL?: string;
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace;
}

function requiredBinding(value: string | undefined): string {
  if (!value?.trim()) throw new Error("runtime_configuration_invalid");
  return value;
}

function deploymentProfile(value: string | undefined): DeploymentProfileName {
  if (value !== "shared_cloud" && value !== "dedicated_cloud" && value !== "customer_managed_oss") {
    throw new Error("runtime_configuration_invalid");
  }
  return value;
}

export async function resolveTenantProviderVerificationKey(
  env: TenantProviderOutboundEnv,
  keyId: string,
): Promise<CryptoKey | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredBinding(env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON));
  } catch {
    return undefined;
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Array.isArray((parsed as { keys?: unknown }).keys)
    ? (parsed as { keys: JsonWebKey[] }).keys
    : [];
  const matches = keys.filter((key) => (key as JsonWebKey & { kid?: string }).kid === keyId
    && key.kty === "OKP" && key.crv === "Ed25519" && (key.use === undefined || key.use === "sig"));
  if (matches.length !== 1) return undefined;
  try {
    return await crypto.subtle.importKey("jwk", matches[0], { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return undefined;
  }
}

export function tenantRuntimeHttpClientsForEnv(
  env: TenantProviderOutboundEnv,
  tenantContext?: import("./contracts.js").TenantContextEnvelope,
) {
  return createTenantRuntimeHttpClients({
    deployment_profile: deploymentProfile(env.MANA_DEPLOYMENT_PROFILE),
    service: env.BRAINBASE_TENANT_RUNTIME_SERVICE,
    timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
    workspace_connections: env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON
      ? parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON)
      : [],
    ...(tenantContext ? { tenant_context: tenantContext } : {}),
  });
}

export function tenantCredentialFetchForResolvedContext(
  env: TenantProviderOutboundEnv,
  resolved: Exclude<Awaited<ReturnType<typeof resolveDurableTenantBoundaryContext>>, Response>,
  trustedForwarder?: TrustedProviderForwarder,
): typeof fetch {
  const clients = tenantRuntimeHttpClientsForEnv(env, resolved.tenant_context);
  const productionForwarder = trustedForwarder ?? createBrainbaseTrustedProviderForwarderFromEnv({
    env,
    tenant_context: resolved.tenant_context,
  });
  return createTenantCredentialFetch({
    envelope: resolved.tenant_context,
    expected_scope: resolved.expected_scope,
    broker: clients.credential_broker,
    trusted_forwarder: productionForwarder,
    read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
      resolved.tenant_context.workspace_connection.connection_id,
    ),
    resolve_verification_key: (keyId) => resolveTenantProviderVerificationKey(env, keyId),
    now: () => new Date().toISOString(),
  });
}

export async function authorizeTenantProviderOutbound(
  request: Request,
  env: TenantProviderOutboundEnv,
  trustedForwarder?: TrustedProviderForwarder,
): Promise<Response> {
  const handle = request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER)?.trim();
  if (!handle) return new Response("credential_lease_rejected", { status: 503 });
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    new Date().toISOString(),
  );
  if (resolved instanceof Response) return new Response("credential_lease_rejected", { status: 503 });
  try {
    const credentialFetch = tenantCredentialFetchForResolvedContext(env, resolved, trustedForwarder);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("xc-token");
    headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
    return await credentialFetch(new Request(request, { headers, redirect: "manual" }));
  } catch {
    return new Response("credential_lease_rejected", { status: 503 });
  }
}
