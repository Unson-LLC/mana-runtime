import { buildRuntimeMcpConfig } from "../runtime-mcp-config.js";

describe("placement-scoped runtime MCP config", () => {
  it("exposes only the MCP servers declared by the placement", () => {
    const config = buildRuntimeMcpConfig({
      mcp: ["brainbase", "nocodb", "gateway", "google-drive"],
      gatewayTools: ["list_tasks", "get_employee"],
    }, "tb_opaque_operation_handle");

    expect(Object.keys(config.mcpServers)).toEqual(["brainbase", "nocodb", "gateway", "google-drive"]);
    expect(config.mcpServers.gateway).toEqual({
      command: "node",
      args: ["/opt/mana/gateway-mcp-server.mjs"],
      env: {
        MANA_ALLOWED_GATEWAY_TOOLS: JSON.stringify(["list_tasks", "get_employee"]),
        MANA_TENANT_BOUNDARY_HANDLE: "tb_opaque_operation_handle",
      },
    });
    expect(config.mcpServers["google-drive"]).toEqual({
      type: "http",
      url: "https://google-drive-mcp.internal/mcp",
      headers: { "x-mana-tenant-boundary-handle": "tb_opaque_operation_handle" },
    });
    expect(config.mcpServers.nocodb).toEqual({
      command: "node",
      args: ["/opt/mana/nocodb-mcp-server.mjs"],
      env: { MANA_TENANT_BOUNDARY_HANDLE: "tb_opaque_operation_handle" },
    });
  });

  it("does not expose undeclared servers or gateway tools", () => {
    const config = buildRuntimeMcpConfig(
      { mcp: ["brainbase"], gatewayTools: [] },
      "tb_opaque_operation_handle",
    );
    expect(config.mcpServers).toEqual({
      brainbase: {
        type: "http",
        url: "https://brainbase-mcp.internal/mcp",
        headers: { "x-mana-tenant-boundary-handle": "tb_opaque_operation_handle" },
      },
    });
  });

  it("fails closed when the tenant boundary is unavailable", () => {
    expect(() => buildRuntimeMcpConfig(
      { mcp: ["brainbase"], gatewayTools: [] },
      "",
    )).toThrow(expect.objectContaining({ code: "tenant_boundary_required" }));
  });

  it("fails closed for an unknown MCP server", () => {
    expect(() => buildRuntimeMcpConfig({ mcp: ["shell"], gatewayTools: [] }, "tb_handle"))
      .toThrow(expect.objectContaining({ code: "runtime_mcp_not_supported" }));
  });

  it("fails closed when gateway tools are declared without gateway", () => {
    expect(() => buildRuntimeMcpConfig(
      { mcp: ["brainbase"], gatewayTools: ["list_tasks"] },
      "tb_handle",
    ))
      .toThrow(expect.objectContaining({ code: "runtime_gateway_not_enabled" }));
  });
});
