export interface RuntimeMcpStdioServerConfig {
  command: "node";
  args: [string];
  env?: Record<string, string>;
}
export interface RuntimeMcpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}
export type RuntimeMcpServerConfig = RuntimeMcpStdioServerConfig | RuntimeMcpHttpServerConfig;

export interface RuntimeMcpConfig {
  mcpServers: Record<string, RuntimeMcpServerConfig>;
}

export class RuntimeMcpConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RuntimeMcpConfigError";
  }
}

const SERVER_PATHS = Object.freeze({
  nocodb: "/opt/mana/nocodb-mcp-server.mjs",
  gateway: "/opt/mana/gateway-mcp-server.mjs",
});

export function buildRuntimeMcpConfig(capabilities: {
  mcp: readonly string[];
  gatewayTools: readonly string[];
}, tenantBoundaryHandle: string): RuntimeMcpConfig {
  if (!tenantBoundaryHandle.trim()) {
    throw new RuntimeMcpConfigError("tenant_boundary_required");
  }
  if (capabilities.gatewayTools.length > 0 && !capabilities.mcp.includes("gateway")) {
    throw new RuntimeMcpConfigError("runtime_gateway_not_enabled");
  }
  const mcpServers: Record<string, RuntimeMcpServerConfig> = {};
  for (const name of capabilities.mcp) {
    if (name === "brainbase" || name === "google-drive") {
      mcpServers[name] = {
        type: "http",
        url: name === "brainbase"
          ? "https://brainbase-mcp.internal/mcp"
          : "https://google-drive-mcp.internal/mcp",
        headers: { "x-mana-tenant-boundary-handle": tenantBoundaryHandle },
      };
      continue;
    }
    const path = SERVER_PATHS[name as keyof typeof SERVER_PATHS];
    if (!path) throw new RuntimeMcpConfigError("runtime_mcp_not_supported");
    mcpServers[name] = {
      command: "node",
      args: [path],
      env: {
        ...(name === "gateway" ? {
          MANA_ALLOWED_GATEWAY_TOOLS: JSON.stringify([...capabilities.gatewayTools]),
        } : {}),
        MANA_TENANT_BOUNDARY_HANDLE: tenantBoundaryHandle,
      },
    };
  }
  return { mcpServers };
}
