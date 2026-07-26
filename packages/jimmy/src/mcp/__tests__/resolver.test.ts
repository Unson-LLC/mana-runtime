import { describe, expect, it, vi } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { JinnConfig, McpServerStdioConfig } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

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
    const config = { gateway: { enabled: true }, browser: { enabled: false } } satisfies JinnConfig["mcp"];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveMcpServers(config, undefined, {
      sessionId: "S1", connector: "slack", channel: "C1", placementId: "pilot", configRevision: "rev-1",
    }, false).mcpServers).toEqual({});
    const event = warn.mock.calls.map(([message]) => message).find((message) => message.startsWith("security_event "))!;
    expect(JSON.parse(event.slice("security_event ".length))).toMatchObject({
      event: "capability", reason: "mcp_denied", sessionId: "S1", connector: "slack", channelId: "C1",
      placementId: "pilot", configRevision: "rev-1", target: "gateway",
    });
    warn.mockRestore();
  });

  it("records globally available MCP servers excluded by a placement allowlist", () => {
    const config = { gateway: { enabled: true }, fetch: { enabled: true } } satisfies JinnConfig["mcp"];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(Object.keys(resolveMcpServers(config, undefined, { sessionId: "S2" }, ["gateway"]).mcpServers)).toEqual(["gateway"]);
    const events = warn.mock.calls.map(([message]) => message)
      .filter((message) => message.startsWith("security_event "))
      .map((message) => JSON.parse(message.slice("security_event ".length)));
    expect(events).toContainEqual(expect.objectContaining({ reason: "mcp_denied", sessionId: "S2", target: "fetch" }));
    warn.mockRestore();
  });
});
