import {
  resolveDurableTenantBoundaryContext,
  tenantBoundaryHandleFromCredentialAuthorization,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./durable-tenant-boundary.js";
import { createTenantRuntimeHttpClients } from "./http-clients.js";
import { createTenantCredentialFetch } from "./tenant-credential-fetch.js";
import type { DeploymentProfileName } from "./contracts.js";
import type { TrustedProviderForwarder } from "./trusted-provider-forwarder.js";

export interface TenantProviderOutboundEnv {
  MANA_DEPLOYMENT_PROFILE?: string;
  BRAINBASE_TENANT_AUTHORITY_URL?: string;
  BRAINBASE_CREDENTIAL_BROKER_URL?: string;
  BRAINBASE_QUOTA_URL?: string;
  BRAINBASE_ACCOUNTING_URL?: string;
  BRAINBASE_RUNTIME_API_TOKEN?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
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

export function tenantRuntimeHttpClientsForEnv(env: TenantProviderOutboundEnv) {
  return createTenantRuntimeHttpClients({
    deployment_profile: deploymentProfile(env.MANA_DEPLOYMENT_PROFILE),
    tenant_authority_url: requiredBinding(env.BRAINBASE_TENANT_AUTHORITY_URL),
    credential_broker_url: requiredBinding(env.BRAINBASE_CREDENTIAL_BROKER_URL),
    quota_url: requiredBinding(env.BRAINBASE_QUOTA_URL),
    accounting_url: requiredBinding(env.BRAINBASE_ACCOUNTING_URL),
    api_token: requiredBinding(env.BRAINBASE_RUNTIME_API_TOKEN),
    timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
  });
}

export function tenantCredentialFetchForResolvedContext(
  env: TenantProviderOutboundEnv,
  resolved: Exclude<Awaited<ReturnType<typeof resolveDurableTenantBoundaryContext>>, Response>,
  trustedForwarder?: TrustedProviderForwarder,
): typeof fetch {
  const clients = tenantRuntimeHttpClientsForEnv(env);
  return createTenantCredentialFetch({
    envelope: resolved.tenant_context,
    expected_scope: resolved.expected_scope,
    broker: clients.credential_broker,
    trusted_forwarder: trustedForwarder,
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
  const handle = tenantBoundaryHandleFromCredentialAuthorization(request.headers.get("authorization"));
  if (!handle) return new Response("credential_lease_rejected", { status: 503 });
  const boundaryHeaders = new Headers(request.headers);
  boundaryHeaders.set(TENANT_BOUNDARY_HANDLE_HEADER, handle);
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    new Request(request.url, { headers: boundaryHeaders }),
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
