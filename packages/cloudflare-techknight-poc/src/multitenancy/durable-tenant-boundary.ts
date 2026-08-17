import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";

const BOUNDARY_HOST = "tenant-boundary-context.internal";
const CONTEXT_KEY = "tenant-boundary-context-v1";
const HANDLE_PATTERN = /^tb_[A-Za-z0-9_-]{32,128}$/;
const BOUNDARY_CREDENTIAL_MARKER_PREFIX = "mana-tenant-boundary-v1:";

export const TENANT_BOUNDARY_HANDLE_HEADER = "x-mana-tenant-boundary-handle";

export function tenantBoundaryCredentialMarker(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new TenantBoundaryError("credential_lease", "TENANT_CONTEXT_INVALID");
  }
  return `${BOUNDARY_CREDENTIAL_MARKER_PREFIX}${handle}`;
}

export function tenantBoundaryHandleFromCredentialAuthorization(value: string | null): string | undefined {
  if (!value?.startsWith(`Bearer ${BOUNDARY_CREDENTIAL_MARKER_PREFIX}`)) return undefined;
  const handle = value.slice(`Bearer ${BOUNDARY_CREDENTIAL_MARKER_PREFIX}`.length);
  return HANDLE_PATTERN.test(handle) ? handle : undefined;
}

interface BoundaryStub {
  fetch(request: Request): Promise<Response>;
}

export interface TenantBoundaryContextNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BoundaryStub;
}

export interface TenantBoundaryContextStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

export interface AuthorizedTenantBoundaryContext {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
}

interface BoundaryContext extends AuthorizedTenantBoundaryContext {
  expires_at: string;
}

interface BoundaryValidationInput {
  boundary: BoundaryName;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  now: string;
}

export type TenantBoundaryContextValidator = (input: BoundaryValidationInput) => Promise<void>;

function boundaryStub(namespace: TenantBoundaryContextNamespace, handle: string): BoundaryStub {
  if (!HANDLE_PATTERN.test(handle)) throw new TenantBoundaryError("mcp_gateway", "TENANT_CONTEXT_INVALID");
  return namespace.get(namespace.idFromName(`boundary:${handle}`));
}

function newHandle(): string {
  return `tb_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function boundaryFailure(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { error?: string; boundary?: string } | null;
  throw new TenantBoundaryError(body?.boundary ?? "mcp_gateway", body?.error ?? "UPSTREAM_UNAVAILABLE");
}

export function createDurableTenantBoundaryRegistry(namespace: TenantBoundaryContextNamespace) {
  return {
    async register(input: {
      tenant_context: TenantContextEnvelope;
      expected_scope: ExpectedTenantScope;
      now: string;
    }): Promise<string> {
      const handle = newHandle();
      const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant_context: input.tenant_context,
          expected_scope: input.expected_scope,
          expires_at: input.tenant_context.expires_at,
          now: input.now,
        }),
      }));
      if (!response.ok) return boundaryFailure(response);
      return handle;
    },
    async dispose(handle: string): Promise<void> {
      const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/dispose`, {
        method: "POST",
      }));
      if (!response.ok && response.status !== 404) await boundaryFailure(response);
    },
  };
}

export async function authorizeDurableTenantBoundaryRequest(
  namespace: TenantBoundaryContextNamespace,
  request: Request,
  boundary: "mcp_gateway" | "brainbase_proxy",
  now: string,
): Promise<Response | undefined> {
  const handle = request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER) ?? "";
  if (!HANDLE_PATTERN.test(handle)) {
    return Response.json({ boundary, error: "TENANT_CONTEXT_MISSING" }, { status: 503 });
  }
  try {
    const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boundary, now }),
    }));
    return response.ok ? undefined : response;
  } catch {
    return Response.json({ boundary, error: "WORKSPACE_CONNECTION_UNAVAILABLE" }, { status: 503 });
  }
}

export async function resolveDurableTenantBoundaryContext(
  namespace: TenantBoundaryContextNamespace,
  request: Request,
  boundaries: readonly ("mcp_gateway" | "brainbase_proxy")[],
  now: string,
): Promise<AuthorizedTenantBoundaryContext | Response> {
  const handle = request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER) ?? "";
  if (!HANDLE_PATTERN.test(handle) || boundaries.length === 0) {
    return Response.json({ boundary: boundaries[0] ?? "mcp_gateway", error: "TENANT_CONTEXT_MISSING" },
      { status: 503 });
  }
  try {
    const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boundaries, now }),
    }));
    if (!response.ok) return response;
    const resolved = await response.json() as Partial<AuthorizedTenantBoundaryContext>;
    if (!resolved.tenant_context || !resolved.expected_scope) {
      return Response.json({ boundary: boundaries[0], error: "TENANT_CONTEXT_INVALID" }, { status: 503 });
    }
    return {
      tenant_context: structuredClone(resolved.tenant_context),
      expected_scope: structuredClone(resolved.expected_scope),
    };
  } catch {
    return Response.json({ boundary: boundaries[0], error: "WORKSPACE_CONNECTION_UNAVAILABLE" }, { status: 503 });
  }
}

export class TenantBoundaryContextHandler {
  constructor(
    private readonly storage: TenantBoundaryContextStorage,
    private readonly validate: TenantBoundaryContextValidator,
  ) {}

  async alarm(): Promise<void> {
    await this.storage.delete(CONTEXT_KEY);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== BOUNDARY_HOST || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/dispose") {
      await this.storage.delete(CONTEXT_KEY);
      return new Response(null, { status: 204 });
    }
    try {
      if (url.pathname === "/register") {
        const input = await request.json() as Partial<BoundaryContext> & { now?: unknown };
        if (!input.tenant_context || !input.expected_scope || typeof input.expires_at !== "string"
          || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))
          || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.parse(input.now)) {
          throw new TenantBoundaryError("container_launch", "TENANT_CONTEXT_INVALID");
        }
        const context: BoundaryContext = {
          tenant_context: input.tenant_context,
          expected_scope: input.expected_scope,
          expires_at: input.expires_at,
        };
        await this.storage.put(CONTEXT_KEY, context);
        await this.storage.setAlarm?.(Date.parse(input.expires_at));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/authorize" || url.pathname === "/resolve") {
        const input = await request.json() as { boundary?: unknown; boundaries?: unknown; now?: unknown };
        const boundaries = url.pathname === "/authorize"
          ? [input.boundary]
          : input.boundaries;
        if (!Array.isArray(boundaries) || boundaries.length === 0
          || boundaries.some((boundary) => boundary !== "mcp_gateway" && boundary !== "brainbase_proxy")
          || new Set(boundaries).size !== boundaries.length
          || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
          throw new TenantBoundaryError("mcp_gateway", "SCHEMA_INVALID");
        }
        const context = await this.storage.get<BoundaryContext>(CONTEXT_KEY);
        const primaryBoundary = boundaries[0] as "mcp_gateway" | "brainbase_proxy";
        if (!context) throw new TenantBoundaryError(primaryBoundary, "TENANT_CONTEXT_MISSING");
        if (Date.parse(input.now) > Date.parse(context.expires_at)) {
          await this.storage.delete(CONTEXT_KEY);
          throw new TenantBoundaryError(primaryBoundary, "TENANT_CONTEXT_EXPIRED");
        }
        for (const boundary of boundaries as ("mcp_gateway" | "brainbase_proxy")[]) {
          await this.validate({
            boundary,
            tenant_context: context.tenant_context,
            expected_scope: context.expected_scope,
            now: input.now,
          });
        }
        return url.pathname === "/resolve"
          ? Response.json({
            tenant_context: context.tenant_context,
            expected_scope: context.expected_scope,
          })
          : new Response(null, { status: 204 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const boundary = error instanceof TenantBoundaryError ? error.boundary : "mcp_gateway";
      const code = error instanceof TenantBoundaryError ? error.code : "WORKSPACE_CONNECTION_UNAVAILABLE";
      return Response.json({ boundary, error: code }, { status: 503 });
    }
  }
}
