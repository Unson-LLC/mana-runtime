import { emitSecurityEvent } from "../shared/security-events.js";

interface DeliveryTarget {
  connector: string;
  channel: string;
}

function parseArray<T>(raw: string | undefined): T[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

/** Missing policy preserves legacy behavior; present-but-invalid policy fails closed. */
export function isGatewayToolAllowed(name: string, raw = process.env.JINN_ALLOWED_GATEWAY_TOOLS): boolean {
  const allowed = parseArray<string>(raw);
  const result = allowed === undefined || allowed.includes(name);
  if (!result) emitSecurityEvent({ event: "capability", reason: "gateway_tool_denied", capability: "gateway_tool", target: name });
  return result;
}

export function allowedGatewayTools<T extends { name: string }>(tools: T[], raw = process.env.JINN_ALLOWED_GATEWAY_TOOLS): T[] {
  return tools.filter((tool) => isGatewayToolAllowed(tool.name, raw));
}

export function isDeliveryTargetAllowed(
  connector: string,
  channel: string,
  raw = process.env.JINN_ALLOWED_DELIVERY_TARGETS,
): boolean {
  const allowed = parseArray<DeliveryTarget>(raw);
  const result = allowed === undefined || allowed.some((target) =>
    target?.connector === connector && target?.channel === channel,
  );
  if (!result) emitSecurityEvent({ event: "capability", reason: "delivery_denied", connector, channelId: channel, capability: "delivery", target: `${connector}:${channel}` });
  return result;
}

export function buildCreateChildSessionRequest(
  args: Record<string, unknown>,
  currentSessionId?: string,
): { path: string; body: { prompt: unknown; employee: unknown } } {
  if (!currentSessionId) throw new Error("create_child_session requires a current parent session");
  const requestedParent = args.parentSessionId as string | undefined;
  if (requestedParent && requestedParent !== currentSessionId) {
    throw new Error("create_child_session cannot override the current parent session");
  }
  if (args.engine !== undefined || args.model !== undefined || args.effortLevel !== undefined) {
    throw new Error("create_child_session cannot override engine, model, or effort");
  }
  const parentSessionId = currentSessionId;
  return {
    path: `/api/sessions/${encodeURIComponent(parentSessionId)}/children`,
    body: {
      prompt: args.prompt,
      employee: args.employee,
    },
  };
}
