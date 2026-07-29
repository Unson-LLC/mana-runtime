import type { Engine, EngineResult, EngineRunOpts, IncomingMessage, PlacementDeliveryTarget, PlacementProfile } from "./types.js";

export interface PlacementResolution {
  status: "legacy" | "matched" | "denied";
  placement?: PlacementProfile;
  reason?: "unmatched" | "ambiguous" | "unauthorized_user" | "invalid_config";
}

export interface PlacementEngineBoundary {
  strictMcpConfig: boolean;
  enableChrome: false | undefined;
}

/** Keep every initial/retry caller on the same fail-closed engine boundary. */
export function placementEngineBoundary(placement: PlacementProfile | undefined): PlacementEngineBoundary {
  return {
    strictMcpConfig: Boolean(placement),
    enableChrome: placement ? false : undefined,
  };
}

/** Single execution choke point so initial and retry call sites cannot drift. */
export async function runPlacementBoundEngine(
  engine: Engine,
  placement: PlacementProfile | undefined,
  opts: EngineRunOpts,
): Promise<EngineResult> {
  if (placement && engine.name !== "claude" && engine.name !== "mock") {
    throw new Error(
      `Placement-scoped execution rejects engine without Placement boundary support: ${engine.name}`,
    );
  }
  return engine.run({ ...opts, ...placementEngineBoundary(placement) });
}

/** Check support before callers announce or persist an engine transition. */
export function supportsPlacementEngine(
  engine: Pick<Engine, "name">,
  placement: PlacementProfile | undefined,
): boolean {
  return !placement || engine.name === "claude" || engine.name === "mock";
}

const PLACEMENT_DENIED_CLAUDE_FLAGS = new Set([
  "--chrome",
  "--mcp-config",
  "--strict-mcp-config",
]);

/** Preserve ordinary employee flags, but visibly reject Placement-owned surfaces. */
export function placementSafeCliFlags(
  cliFlags: string[] | undefined,
  strictMcpConfig: boolean | undefined,
): string[] | undefined {
  if (!strictMcpConfig || !cliFlags?.length) return cliFlags;
  const denied = cliFlags.filter((flag) =>
    [...PLACEMENT_DENIED_CLAUDE_FLAGS].some((deniedFlag) =>
      flag === deniedFlag || flag.startsWith(`${deniedFlag}=`),
    ),
  );
  if (denied.length > 0) {
    throw new Error(`Placement-scoped Claude run rejects employee cliFlags: ${[...new Set(denied)].join(", ")}`);
  }
  return cliFlags;
}

const SECRET_VALUE = /^(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|xox[baprs]-\S+|gh[opusr]_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["token", "secret", "password", "credential", "authorization", "apikey", "privatekey"]
    .some((term) => normalized.includes(term));
}

function containsSecret(value: unknown, key?: string, seen = new WeakSet<object>()): boolean {
  if (key && isSecretKey(key)) return true;
  if (typeof value === "string") return SECRET_VALUE.test(value.trim());
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, undefined, seen));
  return Object.entries(value).some(([nestedKey, nestedValue]) => containsSecret(nestedValue, nestedKey, seen));
}

/** Defense-in-depth projection for prompts. Secret-like fields are never rendered. */
export function safePlacementDataScopes(dataScopes: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!dataScopes) return {};
  const redact = (value: unknown, key?: string, seen = new WeakSet<object>()): unknown => {
    if ((key && isSecretKey(key)) || (typeof value === "string" && SECRET_VALUE.test(value.trim()))) {
      return "[REDACTED]";
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[REDACTED]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redact(nestedValue, nestedKey, seen),
    ]));
  };
  return redact(dataScopes) as Record<string, unknown>;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve before session creation. Configured placements are fail-closed. */
export function resolvePlacement(
  placements: PlacementProfile[] | undefined,
  msg: Pick<IncomingMessage, "connector" | "channel" | "user" | "transportMeta">,
): PlacementResolution {
  if (!placements || placements.length === 0) return { status: "legacy" };

  const workspaceId = clean((msg.transportMeta as Record<string, unknown> | undefined)?.team);
  const channelMatches = placements.filter((placement) =>
    placement.connector === msg.connector
    && placement.channelId === msg.channel
    && placement.workspaceId === workspaceId,
  );
  if (channelMatches.length === 0) return { status: "denied", reason: "unmatched" };
  if (channelMatches.length > 1) return { status: "denied", reason: "ambiguous" };

  const placement = channelMatches[0];
  if (containsSecret(placement)) {
    return { status: "denied", reason: "invalid_config" };
  }
  if (!placement.audience.allowedUsers.includes(msg.user)) {
    return { status: "denied", reason: "unauthorized_user" };
  }
  return { status: "matched", placement };
}

export function placementDeliveryTargets(placement: PlacementProfile): PlacementDeliveryTarget[] {
  return placement.capabilities?.allowedDelivery?.length
    ? placement.capabilities.allowedDelivery
    : [{ connector: placement.connector, channel: placement.channelId }];
}

export function isPlacementEmployeeAllowed(placement: PlacementProfile, employeeName: string): boolean {
  return [placement.agent?.employee, placement.agent?.escalationEmployee]
    .some((name) => name === employeeName);
}
