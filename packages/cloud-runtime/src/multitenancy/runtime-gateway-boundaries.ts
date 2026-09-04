export type RuntimeGatewayBoundary = "mcp_gateway" | "brainbase_proxy" | "slack_delivery";

export async function runtimeGatewayBoundaries(
  request: Request,
): Promise<readonly RuntimeGatewayBoundary[]> {
  try {
    const body = await request.clone().json() as { tool?: unknown };
    return body.tool === "send_message"
      ? ["mcp_gateway", "brainbase_proxy", "slack_delivery"]
      : ["mcp_gateway", "brainbase_proxy"];
  } catch {
    return ["mcp_gateway", "brainbase_proxy"];
  }
}
