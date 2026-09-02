import { describe, expect, it } from "vitest";
import { runtimeGatewayBoundaries } from "../multitenancy/runtime-gateway-boundaries.js";

describe("runtime gateway Company Authority boundary selection", () => {
  it("adds Slack delivery only for the exact send_message operation", async () => {
    const request = (tool: unknown) => new Request("https://runtime-gateway.internal/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool }),
    });

    await expect(runtimeGatewayBoundaries(request("send_message"))).resolves.toEqual([
      "mcp_gateway", "brainbase_proxy", "slack_delivery",
    ]);
    await expect(runtimeGatewayBoundaries(request("search_tasks"))).resolves.toEqual([
      "mcp_gateway", "brainbase_proxy",
    ]);
    await expect(runtimeGatewayBoundaries(request("read_task"))).resolves.toEqual([
      "mcp_gateway", "brainbase_proxy",
    ]);
    await expect(runtimeGatewayBoundaries(request("send_message_extra"))).resolves.toEqual([
      "mcp_gateway", "brainbase_proxy",
    ]);
  });

  it("fails to the non-delivery boundary set for malformed JSON", async () => {
    const request = new Request("https://runtime-gateway.internal/tools", {
      method: "POST",
      body: "{",
    });
    await expect(runtimeGatewayBoundaries(request)).resolves.toEqual([
      "mcp_gateway", "brainbase_proxy",
    ]);
  });
});
