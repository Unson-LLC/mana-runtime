import { emitSecurityEvent } from "../shared/security-events.js";

interface DeliveryTarget {
  connector: string;
  channel: string;
}

/** Explicit allow-all marker the resolver sets for legacy (non-placement) sessions. */
export const POLICY_ALLOW_ALL = "*";

type PolicyDecision<T> = { kind: "allow-all" } | { kind: "allowlist"; allowed: T[] } | { kind: "deny-all" };

function parsePolicy<T>(raw: string | undefined): PolicyDecision<T> {
  // Missing policy fails closed: the resolver ALWAYS sets the env (placement →
  // JSON allowlist, legacy → "*"), so an absent variable means this gateway MCP
  // server was spawned outside the resolver and must not grant anything.
  if (raw === undefined) return { kind: "deny-all" };
  if (raw === POLICY_ALLOW_ALL) return { kind: "allow-all" };
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? { kind: "allowlist", allowed: value as T[] } : { kind: "deny-all" };
  } catch {
    return { kind: "deny-all" };
  }
}

export function isGatewayToolAllowed(name: string, raw = process.env.JINN_ALLOWED_GATEWAY_TOOLS): boolean {
  const policy = parsePolicy<string>(raw);
  const result = policy.kind === "allow-all" || (policy.kind === "allowlist" && policy.allowed.includes(name));
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
  const policy = parsePolicy<DeliveryTarget>(raw);
  const result = policy.kind === "allow-all" || (policy.kind === "allowlist" && policy.allowed.some((target) =>
    target?.connector === connector && target?.channel === channel,
  ));
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
