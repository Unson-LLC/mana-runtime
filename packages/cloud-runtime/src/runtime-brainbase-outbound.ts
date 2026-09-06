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

const JUDGMENT_PROJECT_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function authorityJudgmentProjectCode(
  resolved: Exclude<Awaited<ReturnType<typeof resolveDurableTenantBoundaryContext>>, Response>,
  env: RuntimeBrainbaseOutboundEnv,
): string | undefined {
  const authorized = resolved.tenant_context.authorization?.project_ids;
  const expected = resolved.expected_scope.project_ids ?? [resolved.expected_scope.project_id];
  if (authorized?.length !== 1 || expected.length !== 1 || authorized[0] !== expected[0]) return undefined;
  try {
    const bindings = JSON.parse(env.BRAINBASE_JUDGMENT_AUTHORITY_PROJECTS_JSON ?? "") as unknown;
    if (!bindings || Array.isArray(bindings) || typeof bindings !== "object") return undefined;
    const code = (bindings as Record<string, unknown>)[authorized[0]];
    return typeof code === "string" && JUDGMENT_PROJECT_CODE_PATTERN.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
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
  let proxyEnv = env;
  if (resolved.company_authority_envelope !== undefined) {
    const projectCode = authorityJudgmentProjectCode(resolved, env);
    if (!projectCode) {
      return Response.json({
        error: { code: "COMPANY_AUTHORITY_HOOK_SCOPE_UNAVAILABLE", retryable: false },
      }, { status: 503 });
    }
    proxyEnv = { ...env, BRAINBASE_JUDGMENT_PROJECT_CODE: projectCode };
  }

  const headers = new Headers(request.headers);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  return handleBrainbaseMcpProxyRequest(
    new Request(request, { headers }),
    proxyEnv,
    fetchImpl,
  );
}
