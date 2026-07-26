import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { JinnConfig, McpServerStdioConfig } from "../../shared/types.js";

describe("resolveMcpServers", () => {
  it("passes current conversation context to the gateway MCP server", () => {
    const config = {
      gateway: { enabled: true },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      sessionId: "session-1",
      connector: "slack",
      channel: "C123",
      thread: "1700000000.000100",
    });

    const gateway = resolved.mcpServers.gateway as McpServerStdioConfig;
    expect(gateway.env).toMatchObject({
      JINN_CURRENT_CONNECTOR: "slack",
      JINN_CURRENT_CHANNEL: "C123",
      JINN_CURRENT_THREAD: "1700000000.000100",
    });
  });

  it("applies placement MCP selection and gateway policy environment", () => {
    const config = {
      gateway: { enabled: true },
      browser: { enabled: false },
      fetch: { enabled: true },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      sessionId: "session-1",
      connector: "slack",
      channel: "C123",
      allowedGatewayTools: ["list_sessions"],
      allowedDeliveryTargets: [{ connector: "slack", channel: "C123" }],
    }, ["gateway"]);

    expect(Object.keys(resolved.mcpServers)).toEqual(["gateway"]);
    const gateway = resolved.mcpServers.gateway as McpServerStdioConfig;
    expect(gateway.env).toMatchObject({
      JINN_CURRENT_SESSION_ID: "session-1",
      JINN_SESSION_DELEGATION_TOKEN: expect.any(String),
      JINN_ALLOWED_GATEWAY_TOOLS: '["list_sessions"]',
      JINN_ALLOWED_DELIVERY_TARGETS: '[{"connector":"slack","channel":"C123"}]',
    });
  });

  it("denies all MCP servers when a placement omits MCP capability", () => {
    const config = { gateway: { enabled: true } } satisfies JinnConfig["mcp"];
    expect(resolveMcpServers(config, undefined, undefined, false).mcpServers).toEqual({});
  });
});
