import { applyAnthropicCredential, type AnthropicCredentialEnv } from "./anthropic-auth.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";

export interface RuntimeAnthropicOutboundEnv extends AnthropicCredentialEnv {
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace;
}

export async function authorizeRuntimeAnthropicOutbound(
  request: Request,
  env: RuntimeAnthropicOutboundEnv,
  providerFetch: typeof fetch = fetch,
): Promise<Response> {
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    new Date().toISOString(),
  );
  if (resolved instanceof Response) return new Response("tenant_boundary_rejected", { status: 503 });
  const headers = applyAnthropicCredential(request.headers, env);
  if (!headers) return new Response("anthropic_credential_unavailable", { status: 503 });
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  return providerFetch(new Request(request, { headers, redirect: "manual" }));
}
