import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";

const BOUNDARY_HOST = "tenant-boundary-context.internal";
const CONTEXT_KEY = "tenant-boundary-context-v1";
const HANDLE_PATTERN = /^tb_[A-Za-z0-9_-]{32,128}$/;

export const TENANT_BOUNDARY_HANDLE_HEADER = "x-mana-tenant-boundary-handle";

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
  /**
   * An optional accepted outer decision carried alongside the nested tenant
   * context. Keep this opaque here so the durable boundary does not depend on
   * the Company Authority adapter or persist its trust configuration.
   */
  company_authority_envelope?: unknown;
}

interface BoundaryContext extends AuthorizedTenantBoundaryContext {
  expires_at: string;
}

interface BoundaryValidationInput {
  boundary: BoundaryName;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  now: string;
  company_authority_envelope?: unknown;
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
      company_authority_envelope?: unknown;
      now: string;
    }): Promise<string> {
      const handle = newHandle();
      const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant_context: input.tenant_context,
          expected_scope: input.expected_scope,
          ...(input.company_authority_envelope !== undefined
            ? { company_authority_envelope: input.company_authority_envelope }
            : {}),
          expires_at: input.tenant_context.expires_at,
          now: input.now,
        }),
      }));
      if (!response.ok) return boundaryFailure(response);
      return handle;
    },
    async refresh(handle: string, input: {
      tenant_context: TenantContextEnvelope;
      now: string;
    }): Promise<void> {
      const response = await boundaryStub(namespace, handle).fetch(new Request(`https://${BOUNDARY_HOST}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_context: input.tenant_context, now: input.now }),
      }));
      if (!response.ok) await boundaryFailure(response);
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
  boundary: "mcp_gateway" | "brainbase_proxy" | "slack_delivery",
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
  boundaries: readonly ("mcp_gateway" | "brainbase_proxy" | "slack_delivery")[],
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
      ...(resolved.company_authority_envelope !== undefined
        ? { company_authority_envelope: structuredClone(resolved.company_authority_envelope) }
        : {}),
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
          ...(input.company_authority_envelope !== undefined
            ? { company_authority_envelope: structuredClone(input.company_authority_envelope) }
            : {}),
        };
        if (context.company_authority_envelope !== undefined) {
          await this.validate({
            boundary: "container_launch",
            tenant_context: context.tenant_context,
            expected_scope: context.expected_scope,
            now: input.now,
            company_authority_envelope: structuredClone(context.company_authority_envelope),
          });
        }
        await this.storage.put(CONTEXT_KEY, context);
        await this.storage.setAlarm?.(Date.parse(input.expires_at));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/refresh") {
        const input = await request.json() as { tenant_context?: TenantContextEnvelope; now?: unknown };
        if (!input.tenant_context || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))
          || !Number.isFinite(Date.parse(input.tenant_context.expires_at))
          || Date.parse(input.tenant_context.expires_at) <= Date.parse(input.now)) {
          throw new TenantBoundaryError("container_launch", "TENANT_CONTEXT_INVALID");
        }
        const current = await this.storage.get<BoundaryContext>(CONTEXT_KEY);
        if (!current) throw new TenantBoundaryError("container_launch", "TENANT_CONTEXT_MISSING");
        const fresh = input.tenant_context;
        if (fresh.tenant.tenant_id !== current.tenant_context.tenant.tenant_id
          || fresh.workspace_connection?.connection_id !== current.tenant_context.workspace_connection?.connection_id
          || fresh.workspace_connection?.workspace_id !== current.tenant_context.workspace_connection?.workspace_id
          || fresh.workspace_connection?.app_id !== current.tenant_context.workspace_connection?.app_id
          || fresh.actor?.principal_id !== current.tenant_context.actor?.principal_id) {
          throw new TenantBoundaryError("container_launch", "CROSS_TENANT_CANDIDATE");
        }
        await this.validate({
          boundary: "container_launch",
          tenant_context: fresh,
          expected_scope: current.expected_scope,
          now: input.now,
          ...(current.company_authority_envelope !== undefined
            ? { company_authority_envelope: structuredClone(current.company_authority_envelope) }
            : {}),
        });
        await this.storage.put(CONTEXT_KEY, {
          ...current,
          tenant_context: fresh,
          expires_at: fresh.expires_at,
        } satisfies BoundaryContext);
        await this.storage.setAlarm?.(Date.parse(fresh.expires_at));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/authorize" || url.pathname === "/resolve") {
        const input = await request.json() as { boundary?: unknown; boundaries?: unknown; now?: unknown };
        const boundaries = url.pathname === "/authorize"
          ? [input.boundary]
          : input.boundaries;
        if (!Array.isArray(boundaries) || boundaries.length === 0
          || boundaries.some((boundary) => boundary !== "mcp_gateway"
            && boundary !== "brainbase_proxy"
            && boundary !== "slack_delivery")
          || new Set(boundaries).size !== boundaries.length
          || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
          throw new TenantBoundaryError("mcp_gateway", "SCHEMA_INVALID");
        }
        const context = await this.storage.get<BoundaryContext>(CONTEXT_KEY);
        const primaryBoundary = boundaries[0] as "mcp_gateway" | "brainbase_proxy" | "slack_delivery";
        if (!context) throw new TenantBoundaryError(primaryBoundary, "TENANT_CONTEXT_MISSING");
        if (Date.parse(input.now) > Date.parse(context.expires_at)) {
          await this.storage.delete(CONTEXT_KEY);
          throw new TenantBoundaryError(primaryBoundary, "TENANT_CONTEXT_EXPIRED");
        }
        for (const boundary of boundaries as ("mcp_gateway" | "brainbase_proxy" | "slack_delivery")[]) {
          await this.validate({
            boundary,
            tenant_context: context.tenant_context,
            expected_scope: context.expected_scope,
            now: input.now,
            ...(context.company_authority_envelope !== undefined
              ? { company_authority_envelope: structuredClone(context.company_authority_envelope) }
              : {}),
          });
        }
        return url.pathname === "/resolve"
          ? Response.json({
            tenant_context: context.tenant_context,
            expected_scope: context.expected_scope,
            ...(context.company_authority_envelope !== undefined
              ? { company_authority_envelope: context.company_authority_envelope }
              : {}),
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
