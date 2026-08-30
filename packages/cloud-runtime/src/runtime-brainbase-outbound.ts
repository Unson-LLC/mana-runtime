import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";
import {
  BRAINBASE_JUDGMENT_HOOK_PROXY_PATH,
  BRAINBASE_MCP_PROXY_HOST,
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
  const url = new URL(request.url);
  if (
    url.hostname !== BRAINBASE_MCP_PROXY_HOST
    || url.pathname !== BRAINBASE_JUDGMENT_HOOK_PROXY_PATH
    || request.method !== "POST"
  ) {
    return Response.json(
      { error: { code: "BRAINBASE_OPERATION_FORBIDDEN", retryable: false } },
      { status: 403 },
    );
  }
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
