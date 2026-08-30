import { applyAnthropicCredential, type AnthropicCredentialEnv } from "./anthropic-auth.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";

export interface RuntimeAnthropicOutboundEnv extends AnthropicCredentialEnv {
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace;
}

const SAFE_REQUEST_HEADERS = new Set([
  "accept", "content-type", "anthropic-version", "anthropic-beta", "user-agent",
]);

function rejection(code: string, status: number, retryable = false): Response {
  return Response.json({ error: { code, retryable } }, { status });
}

function safeAnthropicHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (SAFE_REQUEST_HEADERS.has(lower) || lower.startsWith("x-stainless-")) {
      headers.set(lower, value);
    }
  });
  return headers;
}

export async function authorizeRuntimeAnthropicOutbound(
  request: Request,
  env: RuntimeAnthropicOutboundEnv,
  providerFetch: typeof fetch = fetch,
): Promise<Response> {
  const target = new URL(request.url);
  if (target.origin !== "https://api.anthropic.com"
    || request.method !== "POST" || target.pathname !== "/v1/messages") {
    return rejection("ANTHROPIC_OPERATION_FORBIDDEN", 403);
  }
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    new Date().toISOString(),
  );
  if (resolved instanceof Response) return rejection("TENANT_BOUNDARY_REJECTED", 503, true);
  const headers = applyAnthropicCredential(safeAnthropicHeaders(request.headers), env);
  if (!headers) return rejection("ANTHROPIC_CREDENTIAL_UNAVAILABLE", 503, true);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  try {
    return await providerFetch(new Request(request, { headers, redirect: "manual" }));
  } catch {
    return rejection("ANTHROPIC_UPSTREAM_UNAVAILABLE", 502, true);
  }
}
