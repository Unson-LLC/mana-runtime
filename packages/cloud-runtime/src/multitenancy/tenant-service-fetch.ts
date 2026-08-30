import { applyAnthropicCredential, type AnthropicCredentialEnv } from "../anthropic-auth.js";
import { deny } from "./errors.js";

interface BrainbaseServiceEnv {
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_TOKEN?: string;
}

function configuredOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

export function createBrainbaseServiceFetch(env: BrainbaseServiceEnv, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const taskOrigin = configuredOrigin(env.BRAINBASE_TASK_API_BASE_URL);
    const graphOrigin = configuredOrigin(env.BRAINBASE_GRAPH_API_BASE_URL);
    const token = request.url.startsWith(`${graphOrigin ?? "invalid:"}/`)
      ? env.BRAINBASE_GRAPH_API_TOKEN
      : request.url.startsWith(`${taskOrigin ?? "invalid:"}/`)
        ? env.BRAINBASE_TASK_API_TOKEN
        : undefined;
    if (request.url.startsWith("http:") || !token) deny("brainbase_proxy", "CONFIGURATION_INVALID");
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(new Request(request, { headers, redirect: "manual" }));
  }) as typeof fetch;
}

export function createAnthropicServiceFetch(env: AnthropicCredentialEnv, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com" || url.pathname !== "/v1/messages") {
      deny("credential_lease", "PROVIDER_OPERATION_UNSUPPORTED");
    }
    const headers = applyAnthropicCredential(request.headers, env);
    if (!headers) deny("credential_lease", "CONFIGURATION_INVALID");
    headers.delete("x-mana-tenant-boundary-handle");
    return fetchImpl(new Request(request, { headers, redirect: "manual" }));
  }) as typeof fetch;
}
