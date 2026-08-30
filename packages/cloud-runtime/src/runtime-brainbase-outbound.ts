import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";
import {
  handleBrainbaseMcpProxyRequest,
  type BrainbaseMcpProxyEnv,
} from "./brainbase-mcp-proxy.js";

export interface RuntimeBrainbaseOutboundEnv extends BrainbaseMcpProxyEnv {
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace;
}

/**
 * Authorize the sandbox request against its durable tenant boundary, then use
 * the platform-owned Brainbase credential only inside the Worker proxy.
 */
export async function authorizeRuntimeBrainbaseOutbound(
  request: Request,
  env: RuntimeBrainbaseOutboundEnv,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    new Date().toISOString(),
  );
  if (resolved instanceof Response) {
    return Response.json(
      { error: { code: "TENANT_BOUNDARY_REJECTED", retryable: true } },
      { status: 503 },
    );
  }

  const headers = new Headers(request.headers);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  return handleBrainbaseMcpProxyRequest(
    new Request(request, { headers }),
    env,
    fetchImpl,
  );
}
