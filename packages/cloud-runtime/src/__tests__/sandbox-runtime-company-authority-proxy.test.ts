import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  credentialFetchForResolvedContext: vi.fn(),
  createTaskSearchProxyHandler: vi.fn(),
  createTaskWriteProxyHandler: vi.fn(),
  handleBrainbaseMcpProxyRequest: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  getSandbox: vi.fn(),
}));

vi.mock("../multitenancy/durable-tenant-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/durable-tenant-boundary.js")>();
  return { ...actual, resolveDurableTenantBoundaryContext: proxyMocks.resolve };
});

vi.mock("../multitenancy/tenant-provider-outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/tenant-provider-outbound.js")>();
  return {
    ...actual,
    tenantCredentialFetchForResolvedContext: proxyMocks.credentialFetchForResolvedContext,
  };
});

vi.mock("../task-search-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-search-proxy.js")>();
  return { ...actual, createTaskSearchProxyHandler: proxyMocks.createTaskSearchProxyHandler };
});

vi.mock("../task-write-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-write-proxy.js")>();
  return { ...actual, createTaskWriteProxyHandler: proxyMocks.createTaskWriteProxyHandler };
});

vi.mock("../brainbase-mcp-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brainbase-mcp-proxy.js")>();
  return { ...actual, handleBrainbaseMcpProxyRequest: proxyMocks.handleBrainbaseMcpProxyRequest };
});

import {
  TechKnightSandbox,
} from "../sandbox-runtime.js";
import { BRAINBASE_MCP_PROXY_HOST } from "../brainbase-mcp-proxy.js";
import { TASK_SEARCH_PROXY_HOST } from "../task-search-proxy.js";
import { TASK_WRITE_PROXY_HOST } from "../task-write-proxy.js";
import {
  TENANT_BOUNDARY_HANDLE_HEADER,
  type AuthorizedTenantBoundaryContext,
  type TenantBoundaryContextNamespace,
} from "../multitenancy/durable-tenant-boundary.js";
import type { SandboxRuntimeEnv } from "../sandbox-runtime.js";

const resolvedWithCompanyAuthority = {
  tenant_context: {
    workspace_connection: { workspace_id: "T-workspace" },
  },
  expected_scope: {},
  company_authority_envelope: { decision: "auto" },
} as unknown as AuthorizedTenantBoundaryContext;

const resolvedWithoutCompanyAuthority = {
  tenant_context: {
    workspace_connection: { workspace_id: "T-workspace" },
  },
  expected_scope: {},
} as unknown as AuthorizedTenantBoundaryContext;

function request(host: string): Request {
  return new Request(`https://${host}/proxy`, {
    method: "POST",
    headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: "tb_test" },
    body: "{}",
  });
}

function env(): SandboxRuntimeEnv {
  return { TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace } as SandboxRuntimeEnv;
}

const outboundContext = {
  containerId: "container-test",
  className: "TechKnightSandbox",
};

describe("Company Authority sandbox proxy guard", () => {
  beforeEach(() => {
    proxyMocks.resolve.mockReset();
    proxyMocks.credentialFetchForResolvedContext.mockReset();
    proxyMocks.createTaskSearchProxyHandler.mockReset();
    proxyMocks.createTaskWriteProxyHandler.mockReset();
    proxyMocks.handleBrainbaseMcpProxyRequest.mockReset();

    proxyMocks.credentialFetchForResolvedContext.mockReturnValue(vi.fn());
    proxyMocks.createTaskSearchProxyHandler.mockReturnValue(
      vi.fn(async () => Response.json({ handled: "task-search" })),
    );
    proxyMocks.createTaskWriteProxyHandler.mockReturnValue(
      vi.fn(async () => Response.json({ handled: "task-write" })),
    );
    proxyMocks.handleBrainbaseMcpProxyRequest.mockResolvedValue(
      Response.json({ handled: "brainbase-mcp" }),
    );
  });

  it("rejects Company Authority requests before credential or generic handler creation", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_SEARCH_PROXY_HOST];
    const response = await route(request(TASK_SEARCH_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "COMPANY_AUTHORITY_OPERATION_FORBIDDEN" });
    expect(proxyMocks.credentialFetchForResolvedContext).not.toHaveBeenCalled();
    expect(proxyMocks.createTaskSearchProxyHandler).not.toHaveBeenCalled();
  });

  it("keeps the exact Brainbase MCP host available for an accepted Company Authority context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST];
    const response = await route(request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "brainbase-mcp" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.handleBrainbaseMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      expect.any(Function),
      {
        allowedTools: [
          "brainbase_resolve_turn",
          "brainbase_judgment_state_record",
          "brainbase_knowledge_resolve",
        ],
      },
    );
  });

  it("keeps requester-scoped task writes available for an accepted Company Authority context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_WRITE_PROXY_HOST];
    const response = await route(request(TASK_WRITE_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "task-write" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.createTaskWriteProxyHandler).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing generic proxy path without a Company Authority envelope", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithoutCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_SEARCH_PROXY_HOST];
    const response = await route(request(TASK_SEARCH_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "task-search" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.createTaskSearchProxyHandler).toHaveBeenCalledTimes(1);
  });

  it("leaves the Brainbase policy unset for the existing T0 context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithoutCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST];
    const response = await route(request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(proxyMocks.handleBrainbaseMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });
});
