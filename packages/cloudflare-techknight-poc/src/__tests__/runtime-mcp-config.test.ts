import { buildRuntimeMcpConfig } from "../runtime-mcp-config.js";

describe("placement-scoped runtime MCP config", () => {
  it("exposes only the MCP servers declared by the placement", () => {
    const config = buildRuntimeMcpConfig({
      mcp: ["brainbase", "nocodb", "gateway", "google-drive"],
      gatewayTools: ["list_tasks", "get_employee"],
    });

    expect(Object.keys(config.mcpServers)).toEqual(["brainbase", "nocodb", "gateway", "google-drive"]);
    expect(config.mcpServers.gateway).toEqual({
      command: "node",
      args: ["/opt/mana/gateway-mcp-server.mjs"],
      env: { MANA_ALLOWED_GATEWAY_TOOLS: JSON.stringify(["list_tasks", "get_employee"]) },
    });
    expect(config.mcpServers["google-drive"]).toEqual({
      type: "http",
      url: "https://google-drive-mcp.internal/mcp",
    });
  });

  it("does not expose undeclared servers or gateway tools", () => {
    const config = buildRuntimeMcpConfig({ mcp: ["brainbase"], gatewayTools: [] });
    expect(config.mcpServers).toEqual({
      brainbase: { type: "http", url: "https://brainbase-mcp.internal/mcp" },
    });
  });

  it("fails closed for an unknown MCP server", () => {
    expect(() => buildRuntimeMcpConfig({ mcp: ["shell"], gatewayTools: [] }))
      .toThrow(expect.objectContaining({ code: "runtime_mcp_not_supported" }));
  });

  it("fails closed when gateway tools are declared without gateway", () => {
    expect(() => buildRuntimeMcpConfig({ mcp: ["brainbase"], gatewayTools: ["list_tasks"] }))
      .toThrow(expect.objectContaining({ code: "runtime_gateway_not_enabled" }));
  });
});
