import { describe, expect, it, vi } from "vitest";

import {
  authorizeDurableTenantBoundaryRequest,
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  TenantBoundaryContextHandler,
  TENANT_BOUNDARY_HANDLE_HEADER,
} from "../multitenancy/durable-tenant-boundary.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import { executeTenantContainerOperation } from "../multitenancy/tenant-container-operation.js";
import type { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "../multitenancy/contracts.js";

const NOW = "2026-08-17T04:00:00.000Z";
const CONTEXT = {
  expires_at: "2026-08-17T04:01:00.000Z",
  tenant: { tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
} as TenantContextEnvelope;
const SCOPE = {
  audience: "mana-runtime",
  workspace_id: "T_WORKSPACE_A",
  app_id: "A_APP_A",
  channel_id: "C_CHANNEL_A",
  thread_ts: "1710000000.000001",
  actor_principal_id: "person_a",
  project_id: "project_a",
  capability_id: "runtime.execute",
  deployment_id: "deployment_a",
} satisfies ExpectedTenantScope;

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); return Promise.resolve(); }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
}

class IsolatedBoundaryNamespace {
  readonly handlers = new Map<string, TenantBoundaryContextHandler>();
  readonly validate = vi.fn(async (_input: {
    boundary: BoundaryName;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    now: string;
    company_authority_envelope?: unknown;
  }) => undefined);

  idFromName(name: string): string { return name; }
  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return { fetch: (request) => {
      let handler = this.handlers.get(key);
      if (!handler) {
        handler = new TenantBoundaryContextHandler(new MemoryStorage(), this.validate);
        this.handlers.set(key, handler);
      }
      return handler.fetch(request);
    } };
  }
}

describe("durable tenant boundary integration", () => {
  it("carries only an opaque operation handle into the Container and revalidates MCP plus Brainbase boundaries", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });

    expect(handle).not.toContain(CONTEXT.tenant.tenant_id);
    const request = new Request("https://task-search.internal/api/companion/tasks/search?query=mana", {
      headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
    });
    await expect(authorizeDurableTenantBoundaryRequest(namespace, request, "mcp_gateway", NOW))
      .resolves.toBeUndefined();
    await expect(authorizeDurableTenantBoundaryRequest(namespace, request, "brainbase_proxy", NOW))
      .resolves.toBeUndefined();
    expect(namespace.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      boundary: "mcp_gateway", tenant_context: CONTEXT, expected_scope: SCOPE,
    }));
    expect(namespace.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      boundary: "brainbase_proxy", tenant_context: CONTEXT, expected_scope: SCOPE,
    }));
    expect(namespace.validate.mock.calls[0]?.[0]).not.toHaveProperty("company_authority_envelope");
    expect(namespace.validate.mock.calls[1]?.[0]).not.toHaveProperty("company_authority_envelope");

    await registry.dispose(handle);
    const disposed = await authorizeDurableTenantBoundaryRequest(namespace, request, "mcp_gateway", NOW);
    expect(disposed).toMatchObject({ status: 503 });
  });

  it("fails closed without a handle and preserves revision failure", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const missing = await authorizeDurableTenantBoundaryRequest(
      namespace,
      new Request("https://task-search.internal/api/companion/tasks/search?query=mana"),
      "mcp_gateway",
      NOW,
    );
    expect(missing).toMatchObject({ status: 503 });

    namespace.validate.mockRejectedValueOnce(new TenantBoundaryError(
      "mcp_gateway",
      "WORKSPACE_CONNECTION_STALE_REVISION",
    ));
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });
    const rejected = await authorizeDurableTenantBoundaryRequest(namespace, new Request(
      "https://task-search.internal/api/companion/tasks/search?query=mana",
      { headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle } },
    ), "mcp_gateway", NOW);
    expect(rejected).toMatchObject({ status: 503 });
    await expect(rejected?.json()).resolves.toEqual({
      boundary: "mcp_gateway",
      error: "WORKSPACE_CONNECTION_STALE_REVISION",
    });
  });

  it("returns the verified context to the Worker proxy without exposing it to the Container request", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });
    const request = new Request("https://gateway.internal/api/runtime/gateway", {
      headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
    });

    const resolved = await resolveDurableTenantBoundaryContext(
      namespace,
      request,
      ["mcp_gateway", "brainbase_proxy"],
      NOW,
    );

    expect(resolved).toEqual({ tenant_context: CONTEXT, expected_scope: SCOPE });
    expect(namespace.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({ boundary: "mcp_gateway" }));
    expect(namespace.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({ boundary: "brainbase_proxy" }));
    expect(request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER)).toBe(handle);
  });

  it("refreshes the same opaque handle with a newly verified context without widening its scope", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });
    const refreshed = {
      ...CONTEXT,
      expires_at: "2026-08-17T04:06:00.000Z",
    } as TenantContextEnvelope;

    await registry.refresh(handle, {
      tenant_context: refreshed,
      now: "2026-08-17T04:00:30.000Z",
    });

    const resolved = await resolveDurableTenantBoundaryContext(namespace, new Request(
      "https://gateway.internal/api/runtime/gateway",
      { headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle } },
    ), ["mcp_gateway"], "2026-08-17T04:02:00.000Z");
    expect(resolved).toEqual({ tenant_context: refreshed, expected_scope: SCOPE });
    expect(namespace.validate).toHaveBeenCalledWith(expect.objectContaining({
      boundary: "container_launch", tenant_context: refreshed, expected_scope: SCOPE,
    }));
  });

  it("rejects a refresh that changes the tenant identity and keeps the accepted context", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });

    await expect(registry.refresh(handle, {
      tenant_context: {
        ...CONTEXT,
        expires_at: "2026-08-17T04:06:00.000Z",
        tenant: { ...CONTEXT.tenant, tenant_id: "ten_other" },
      },
      now: "2026-08-17T04:00:30.000Z",
    })).rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });

    const resolved = await resolveDurableTenantBoundaryContext(namespace, new Request(
      "https://gateway.internal/api/runtime/gateway",
      { headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle } },
    ), ["mcp_gateway"], "2026-08-17T04:00:45.000Z");
    expect(resolved).toEqual({ tenant_context: CONTEXT, expected_scope: SCOPE });
  });

  it("refreshes a long-running Container operation before its accepted context expires", async () => {
    vi.useFakeTimers();
    try {
      const namespace = new IsolatedBoundaryNamespace();
      const issue = vi.fn(async () => ({
        ...CONTEXT,
        expires_at: "2026-08-17T04:06:00.000Z",
      } as TenantContextEnvelope));
      let finish: ((value: string) => void) | undefined;
      const operation = executeTenantContainerOperation({
        namespace,
        tenant_context: CONTEXT,
        expected_scope: SCOPE,
        verifier: { validate: vi.fn(async () => undefined) } as unknown as TenantRuntimeBoundaryVerifier,
        now: NOW,
        refresh: { issue, now: () => NOW, before_expiry_ms: 59_999 },
        execute: () => new Promise<string>((resolve) => { finish = resolve; }),
      });

      await vi.advanceTimersByTimeAsync(2);
      expect(issue).toHaveBeenCalledOnce();
      finish?.("completed");
      await expect(operation).resolves.toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores and revalidates an optional outer Company Authority envelope without putting it in headers", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const outerEnvelope = {
      schema_version: "1.0",
      correlation_id: "corr-company-authority-outer",
      company_authority_request: { correlation_id: "corr-company-authority-outer" },
      company_authority_response: { context: { authority: { decision: "auto" } } },
      payload: { event_id: "event-company-authority-outer" },
    };
    const handle = await registry.register({
      tenant_context: CONTEXT,
      expected_scope: SCOPE,
      company_authority_envelope: outerEnvelope,
      now: NOW,
    });
    const request = new Request("https://gateway.internal/api/runtime/gateway", {
      headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
    });

    const resolved = await resolveDurableTenantBoundaryContext(
      namespace,
      request,
      ["mcp_gateway", "brainbase_proxy", "slack_delivery"],
      NOW,
    );

    expect(resolved).toEqual({
      tenant_context: CONTEXT,
      expected_scope: SCOPE,
      company_authority_envelope: outerEnvelope,
    });
    expect(resolved).not.toBe(outerEnvelope);
    expect(namespace.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      boundary: "container_launch",
      company_authority_envelope: outerEnvelope,
    }));
    expect(namespace.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      boundary: "mcp_gateway",
      company_authority_envelope: outerEnvelope,
    }));
    expect(namespace.validate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      boundary: "brainbase_proxy",
      company_authority_envelope: outerEnvelope,
    }));
    expect(namespace.validate).toHaveBeenNthCalledWith(4, expect.objectContaining({
      boundary: "slack_delivery",
      company_authority_envelope: outerEnvelope,
    }));
    expect(request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER)).toBe(handle);
    const serializedHeaders: string[] = [];
    request.headers.forEach((value, name) => serializedHeaders.push(`${name}: ${value}`));
    expect(serializedHeaders.join("\n")).not.toContain("corr-company-authority-outer");
    expect(serializedHeaders.join("\n")).not.toContain("event-company-authority-outer");
  });
});
