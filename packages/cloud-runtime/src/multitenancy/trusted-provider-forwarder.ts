import type {
  CredentialLease,
  CredentialLeaseBinding,
  TenantContextEnvelope,
} from "./contracts.js";
import { deny } from "./errors.js";

/**
 * Consumer-side port for the Brainbase-owned trusted provider forwarder.
 *
 * mana-runtime sends only a signed tenant context, an opaque single-use lease,
 * and an allowlisted provider operation. Raw provider credential material is
 * materialized and attached to the provider request only inside Brainbase.
 */
export interface TrustedProviderForwardInput {
  lease: CredentialLease;
  expected_binding: CredentialLeaseBinding;
  request: Request;
  now: string;
}

export interface TrustedProviderForwarder {
  forward(input: TrustedProviderForwardInput): Promise<Response>;
}

export interface BrainbaseTrustedProviderForwarderEnv {
  BRAINBASE_TENANT_RUNTIME_ENABLED?: string;
  BRAINBASE_TENANT_RUNTIME_HOST?: string;
  BRAINBASE_TENANT_RUNTIME_PORT?: string;
  BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  NOCODB_URL?: string;
}

export interface BrainbaseTrustedProviderForwarderOptions {
  env: BrainbaseTrustedProviderForwarderEnv;
  tenant_context: TenantContextEnvelope;
}

const PROVIDER_AUTH_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "xc-token",
  "cookie",
] as const;

const TASK_MUTATION_OPERATIONS = new Set([
  "brainbase.tasks.create",
  "brainbase.tasks.update",
  "brainbase.tasks.transition",
  "brainbase.tasks.delete",
]);

type WireScalar = string | string[];
type WireRequest = {
  path_params?: Record<string, string>;
  query?: Record<string, WireScalar>;
  body?: Record<string, unknown> | string;
  target_url?: string;
  idempotency_key?: string;
};

type MappedProviderRequest = {
  provider_operation: string;
  request: WireRequest;
};

type ProviderResponse = {
  provider: string;
  operation_id: string;
  provider_operation: string;
  status: number;
  response_encoding: "json" | "utf8" | "base64";
  content_type: string | null;
  body: unknown;
};

export function sanitizeTrustedProviderRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of PROVIDER_AUTH_HEADERS) headers.delete(header);
  const credentialHeaders: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("x-mana-credential-")) credentialHeaders.push(name);
  });
  for (const name of credentialHeaders) headers.delete(name);
  headers.delete("content-length");
  return new Request(request, { headers, redirect: "manual" });
}

function requiredText(value: string | undefined): string {
  if (!value?.trim()) throw new Error("runtime_configuration_invalid");
  return value.trim();
}

function configuredBase(value: string | undefined): URL | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    throw new Error("runtime_configuration_invalid");
  }
}

function relativePath(url: URL, base: URL | undefined): string | undefined {
  if (!base || url.origin !== base.origin) return undefined;
  const prefix = base.pathname.replace(/\/$/u, "");
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return undefined;
  return url.pathname.slice(prefix.length) || "/";
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    deny("credential_lease", "SCHEMA_INVALID");
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decoded);
}

function wireQuery(url: URL): Record<string, WireScalar> | undefined {
  const result: Record<string, WireScalar> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    result[name] = values.length === 1 ? values[0] : values;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function wireBody(request: Request): Promise<Record<string, unknown> | string | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return undefined;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json" || contentType?.endsWith("+json")) {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      deny("credential_lease", "SCHEMA_INVALID");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) deny("credential_lease", "SCHEMA_INVALID");
    return body as Record<string, unknown>;
  }
  return bytesToBase64(new Uint8Array(await request.clone().arrayBuffer()));
}

function withQuery(url: URL, request: WireRequest): WireRequest {
  const query = wireQuery(url);
  return query ? { ...request, query } : request;
}

function idempotencyKey(request: Request, operation: string): string | undefined {
  if (!TASK_MUTATION_OPERATIONS.has(operation)) return undefined;
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) {
    deny("credential_lease", "SCHEMA_INVALID");
  }
  return value;
}

async function mapProviderRequest(
  request: Request,
  env: BrainbaseTrustedProviderForwarderEnv,
): Promise<MappedProviderRequest> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const body = await wireBody(request);
  const addBody = (wire: WireRequest): WireRequest => body === undefined ? wire : { ...wire, body };

  if (url.hostname === "api.anthropic.com" && method === "POST" && url.pathname === "/v1/messages") {
    return { provider_operation: "anthropic.messages.create", request: addBody({}) };
  }
  if (url.hostname === "slack.com" && url.pathname.startsWith("/api/") && ["GET", "POST"].includes(method)) {
    const apiMethod = url.pathname.slice("/api/".length);
    if (!/^[A-Za-z0-9_.]+$/u.test(apiMethod)) deny("credential_lease", "PROVIDER_OPERATION_UNSUPPORTED");
    return { provider_operation: `slack.${apiMethod}.${method.toLowerCase()}`, request: addBody(withQuery(url, {})) };
  }
  if (url.hostname === "files.slack.com" && method === "GET") {
    return { provider_operation: "slack.files.download", request: { target_url: url.toString() } };
  }
  if (url.hostname === "hooks.slack.com" && method === "POST") {
    return { provider_operation: "slack.response_url.post", request: addBody({ target_url: url.toString() }) };
  }
  if (url.hostname === "github.com") {
    const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/u.exec(url.pathname);
    if (match && ((method === "GET" && match[3] === "info/refs") || (method === "POST" && match[3] === "git-upload-pack"))) {
      return {
        provider_operation: match[3] === "info/refs" ? "github.git.info_refs" : "github.git.upload_pack",
        request: addBody(withQuery(url, { path_params: { owner: decoded(match[1]), repo: decoded(match[2]) } })),
      };
    }
  }
  if (url.hostname === "api.github.com") {
    const match = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/u.exec(url.pathname);
    if (match && ["GET", "PUT", "DELETE"].includes(method)) {
      return {
        provider_operation: `github.contents.${method.toLowerCase()}`,
        request: addBody(withQuery(url, { path_params: { owner: decoded(match[1]), repo: decoded(match[2]), path: decoded(match[3]) } })),
      };
    }
  }

  const nocodbPath = relativePath(url, configuredBase(env.NOCODB_URL));
  if (nocodbPath) {
    const segments = pathSegments(nocodbPath);
    if (segments.slice(0, 5).join("/") === "api/v1/db/data/noco" && segments.length >= 7) {
      const [project, table, record] = segments.slice(5);
      const path_params = { project, table, ...(record ? { record } : {}) };
      const operation = record
        ? ({ GET: "get", PATCH: "update", DELETE: "delete" } as Record<string, string>)[method]
        : ({ GET: "list", POST: "create" } as Record<string, string>)[method];
      if (operation) return { provider_operation: `nocodb.records.${operation}`, request: addBody(withQuery(url, { path_params })) };
    }
    if (segments.slice(0, 4).join("/") === "api/v2/meta/bases" && segments[5] === "tables" && segments.length === 6 && method === "GET") {
      return { provider_operation: "nocodb.tables.list", request: { path_params: { project: segments[4] } } };
    }
    if (segments.slice(0, 3).join("/") === "api/v2/meta" && segments.length === 5) {
      if (segments[3] === "tables" && method === "GET") {
        return { provider_operation: "nocodb.tables.get", request: { path_params: { table: segments[4] } } };
      }
      if (segments[3] === "columns" && method === "PATCH") {
        return { provider_operation: "nocodb.columns.update", request: addBody({ path_params: { column: segments[4] } }) };
      }
    }
  }

  const personalPath = relativePath(url, configuredBase(env.BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL));
  if (personalPath && method === "POST" && !url.search && !url.hash) {
    const operation = personalPath === "/api/personal-knowledge/search" ? "search"
      : personalPath === "/api/personal-knowledge/events" ? "register" : undefined;
    if (operation) return { provider_operation: `brainbase.personal_knowledge.${operation}`, request: addBody({}) };
  }

  const taskPath = relativePath(url, configuredBase(env.BRAINBASE_TASK_API_BASE_URL));
  if (taskPath) {
    const segments = pathSegments(taskPath);
    if (segments.slice(0, 3).join("/") === "api/companion/tasks") {
      let operation: string | undefined;
      let path_params: Record<string, string> | undefined;
      if (segments.length === 3) operation = method === "GET" ? "brainbase.tasks.list" : method === "POST" ? "brainbase.tasks.create" : undefined;
      else if (segments.length === 4 && segments[3] === "search" && method === "GET") operation = "brainbase.tasks.search";
      else if (segments.length === 4) {
        operation = ({ GET: "brainbase.tasks.get", PATCH: "brainbase.tasks.update", DELETE: "brainbase.tasks.delete" } as Record<string, string>)[method];
        path_params = { task_id: segments[3] };
      } else if (segments.length === 5 && segments[4] === "transitions" && method === "POST") {
        operation = "brainbase.tasks.transition";
        path_params = { task_id: segments[3] };
      }
      if (operation) {
        const key = idempotencyKey(request, operation);
        return { provider_operation: operation, request: addBody(withQuery(url, { ...(path_params ? { path_params } : {}), ...(key ? { idempotency_key: key } : {}) })) };
      }
    }
  }

  const graphPath = relativePath(url, configuredBase(env.BRAINBASE_GRAPH_API_BASE_URL));
  if (graphPath) {
    if (graphPath === "/api/info/graph/entities" && method === "GET") {
      return { provider_operation: "brainbase.graph.entities.list", request: withQuery(url, {}) };
    }
    if (graphPath === "/api/info/person/by-slack" && method === "GET") {
      return { provider_operation: "brainbase.graph.person_by_slack.get", request: withQuery(url, {}) };
    }
    if (graphPath === "/api/info/context" && method === "GET") {
      return { provider_operation: "brainbase.graph.context.get", request: withQuery(url, {}) };
    }
  }

  const mcpPath = relativePath(url, configuredBase(env.BRAINBASE_MCP_BASE_URL));
  if (mcpPath === "/mcp" && method === "POST") {
    return { provider_operation: "brainbase.mcp.post", request: addBody({}) };
  }
  if (mcpPath === "/host/judgment/hook" && method === "POST") {
    return { provider_operation: "brainbase.judgment_hook.post", request: addBody({}) };
  }
  const drivePath = relativePath(url, configuredBase(env.GOOGLE_DRIVE_MCP_BASE_URL));
  if (drivePath === "/mcp" && method === "POST") {
    return { provider_operation: "google_drive.mcp.post", request: addBody({}) };
  }
  deny("credential_lease", "PROVIDER_OPERATION_UNSUPPORTED");
}

function problemCode(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { code?: unknown }).code === "string") {
    return (value as { code: string }).code;
  }
  return "UPSTREAM_UNAVAILABLE";
}

function safeProblemDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const details = (value as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const scopeReason = (details as { scope_reason?: unknown }).scope_reason;
  return typeof scopeReason === "string" && scopeReason.length <= 120
    ? { scope_reason: scopeReason }
    : {};
}

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return secrets.some((secret) => secret.length >= 8 && value.includes(secret));
  if (Array.isArray(value)) return value.some((child) => containsSecret(child, secrets));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsSecret(child, secrets));
}

function exactProviderResponse(
  value: unknown,
  expectedOperationId: string,
  expectedProviderOperation: string,
): ProviderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
  const record = value as Record<string, unknown>;
  const fields = ["provider", "operation_id", "provider_operation", "status", "response_encoding", "content_type", "body"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))
    || typeof record.provider !== "string" || !record.provider
    || record.operation_id !== expectedOperationId
    || record.provider_operation !== expectedProviderOperation
    || !Number.isInteger(record.status) || Number(record.status) < 100 || Number(record.status) > 599
    || !["json", "utf8", "base64"].includes(String(record.response_encoding))
    || !(record.content_type === null || typeof record.content_type === "string")
    || (record.response_encoding === "json" && record.body !== null
      && (typeof record.body !== "object" || Array.isArray(record.body)))
    || (record.response_encoding !== "json" && record.body !== null && typeof record.body !== "string")) {
    deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
  }
  return record as ProviderResponse;
}

function providerResponse(result: ProviderResponse): Response {
  const headers = new Headers();
  if (result.content_type) headers.set("content-type", result.content_type);
  if ([204, 205, 304].includes(result.status)) return new Response(null, { status: result.status, headers });
  if (result.body === null) return new Response(null, { status: result.status, headers });
  if (result.response_encoding === "json") {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  }
  if (result.response_encoding === "utf8") return new Response(result.body as string, { status: result.status, headers });
  const bytes = base64ToBytes(result.body as string);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, { status: result.status, headers });
}

/**
 * Creates the consumer adapter for the single Brainbase runtime ingress
 * Service Binding. The ingress owns Access and service-JWT injection.
 * Provider credentials never cross this response boundary.
 */
export function createBrainbaseTrustedProviderForwarderFromEnv(
  options: BrainbaseTrustedProviderForwarderOptions,
): TrustedProviderForwarder {
  const endpoint = new URL("https://brainbase.internal/api/v1/runtime/provider-requests:forward");
  const timeoutMs = Number(options.env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("runtime_configuration_invalid");
  const serviceFetch = options.env.BRAINBASE_TENANT_RUNTIME_SERVICE
    ? options.env.BRAINBASE_TENANT_RUNTIME_SERVICE.fetch.bind(options.env.BRAINBASE_TENANT_RUNTIME_SERVICE)
    : undefined;
  if (!serviceFetch) throw new Error("runtime_configuration_invalid");
  return Object.freeze({
    async forward(input: TrustedProviderForwardInput): Promise<Response> {
      const mapped = await mapProviderRequest(sanitizeTrustedProviderRequest(input.request), options.env);
      let response: Response;
      try {
        response = await serviceFetch(endpoint, {
          method: "POST",
          headers: {
            "brainbase-protocol-version": "1.0",
            "brainbase-deployment-id": options.tenant_context.placement.deployment_id,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tenant_context: options.tenant_context,
            lease_id: input.lease.lease_id,
            lease_token: input.lease.lease_token,
            audience: input.expected_binding.audience,
            provider_operation: mapped.provider_operation,
            request: mapped.request,
          }),
          // Cloudflare Workers service bindings only accept "follow" or "manual".
          // Keep forwarding fail-closed by observing redirects without following them.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        deny("credential_lease", "UPSTREAM_UNAVAILABLE");
      }
      if (response.status >= 300 && response.status < 400) {
        deny("credential_lease", "UPSTREAM_UNAVAILABLE");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        deny("credential_lease", response.ok ? "UPSTREAM_INVALID_RESPONSE" : "UPSTREAM_UNAVAILABLE");
      }
      const validWrapper = (() => {
        try {
          return exactProviderResponse(payload, input.expected_binding.operation_id, mapped.provider_operation);
        } catch {
          return undefined;
        }
      })();
      if (!validWrapper) {
        if (!response.ok) deny("credential_lease", problemCode(payload), {
          provider_operation: mapped.provider_operation,
          status: response.status,
          ...safeProblemDetails(payload),
        });
        deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
      }
      if (validWrapper.status !== response.status
        || containsSecret(validWrapper, [input.lease.lease_token])) {
        deny("credential_lease", "UPSTREAM_INVALID_RESPONSE");
      }
      return providerResponse(validWrapper);
    },
  });
}

export const unavailableTrustedProviderForwarder: TrustedProviderForwarder = Object.freeze({
  async forward(): Promise<never> {
    deny("credential_lease", "CREDENTIAL_FORWARDING_UNAVAILABLE");
  },
});
