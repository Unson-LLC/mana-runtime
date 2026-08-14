export interface RuntimeMcpStdioServerConfig {
  command: "node";
  args: [string];
  env?: Record<string, string>;
}
export interface RuntimeMcpHttpServerConfig { type: "http"; url: string }
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
}): RuntimeMcpConfig {
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
      };
      continue;
    }
    const path = SERVER_PATHS[name as keyof typeof SERVER_PATHS];
    if (!path) throw new RuntimeMcpConfigError("runtime_mcp_not_supported");
    mcpServers[name] = {
      command: "node",
      args: [path],
      ...(name === "gateway" ? {
        env: { MANA_ALLOWED_GATEWAY_TOOLS: JSON.stringify([...capabilities.gatewayTools]) },
      } : {}),
    };
  }
  return { mcpServers };
}
