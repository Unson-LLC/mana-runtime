import fs from "node:fs";
import path from "node:path";
import type { Engine, EngineResult, EngineRunOpts, IncomingMessage, PlacementDeliveryTarget, PlacementProfile } from "./types.js";
import { JINN_HOME } from "./paths.js";

export interface PlacementResolution {
  status: "legacy" | "matched" | "denied";
  placement?: PlacementProfile;
  reason?: "unmatched" | "ambiguous" | "unauthorized_user" | "invalid_config" | "disabled";
  /** Audit context for denials where the placement was identified (e.g. kill switch). */
  placementId?: string;
}

/** Agent-ledger kill switch: only explicit `enabled: false` disables; absent means enabled. */
export function isPlacementEnabled(placement: Pick<PlacementProfile, "enabled">): boolean {
  return placement.enabled !== false;
}

/**
 * Resolve a placement by id for session-bound authorization. Disabled placements
 * are reported distinctly so callers can fail closed with an auditable reason.
 */
export function findEnabledPlacement(
  placements: PlacementProfile[] | undefined,
  placementId: unknown,
): { placement?: PlacementProfile; disabled: boolean } {
  if (typeof placementId !== "string") return { disabled: false };
  const placement = placements?.find((candidate) => candidate.id === placementId);
  if (!placement) return { disabled: false };
  if (!isPlacementEnabled(placement)) return { disabled: true };
  return { placement, disabled: false };
}

export interface PlacementEngineBoundary {
  strictMcpConfig: boolean;
  enableChrome: false | undefined;
  disallowedTools: string[] | undefined;
  /** Capability-derived allow rules (placementAllowedTools). Always an array
   *  for a placement (empty = nothing beyond boundary defaults, never the
   *  global list); undefined for legacy sessions. */
  allowedTools: string[] | undefined;
  placementBashGuard: boolean;
}

// JINN_HOME files shared by EVERY placement. A single channel's untrusted input
// (prompt injection included) must never rewrite persona, skills, or memory —
// that would persist instructions across the placement authority boundary even
// after an authority rebind clears the transcript.
// The gateway.json/hook-relay/placement-guard/settings entries protect the
// enforcement machinery itself: a session that could rewrite the guard script or
// its hook wiring could disable the boundary for its own next tool call.
// Exported for the sync test against assets/placement-guard.mjs, which embeds
// the same lists (it runs standalone inside Claude's hook process).
export const PLACEMENT_PROTECTED_FILES = [
  "config.yaml",
  "CLAUDE.md",
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "gateway.json",
  "gateway.pid",
  "hook-relay.mjs",
  "placement-guard.mjs",
];
export const PLACEMENT_PROTECTED_DIRS = ["org", "cron", "skills", "memory", "knowledge", "docs", "tmp/settings"];
const PLACEMENT_WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * Permission deny rules for shared-state writes in a Placement session.
 * Passed as --disallowedTools; Claude Code enforces deny rules in every
 * permission mode (including bypassPermissions), so this is a hard boundary,
 * not a prompt instruction. The `//` prefix marks an absolute path pattern.
 * Shell-level writes via Bash are covered separately by the PreToolUse guard
 * hook (assets/placement-guard.mjs), wired when `placementBashGuard` is set;
 * residual gaps of that guard are documented in
 * docs/architecture/08_security_design.md §2.1.
 */
export function placementWriteDenyRules(home: string = JINN_HOME): string[] {
  const targets = [
    ...PLACEMENT_PROTECTED_FILES.map((f) => path.join(home, f)),
    ...PLACEMENT_PROTECTED_DIRS.map((d) => path.join(home, d, "**")),
  ];
  return PLACEMENT_WRITE_TOOLS.flatMap((tool) => targets.map((t) => `${tool}(/${t})`));
}

const PLACEMENT_READ_TOOLS = ["Read", "Glob", "Grep"];

/**
 * MCP tools denied in EVERY placement session, regardless of what
 * capabilities.mcp allows. The operator's personal knowledge graph must never
 * surface in any channel — allowing the brainbase server for Graph/wiki access
 * must not drag the personal KG along with it. Enforced through the same
 * --disallowedTools mechanism as placementWriteDenyRules (hard boundary in
 * every permission mode, including bypassPermissions).
 */
export const PLACEMENT_MCP_TOOL_DENY = [
  "mcp__brainbase__search_personal_kg",
  // freee write surface stays denied in every placement — capability-derived
  // allows grant the whole freee server (read tools included), and read-only
  // granularity has no vocabulary yet (gap G2). Until `capabilities.mcp` can
  // express read-only, the write tools are pinned here so `freee` in a
  // placement's capabilities can never mutate books. Deny always beats allow.
  "mcp__freee__freee_api_post",
  "mcp__freee__freee_api_put",
  "mcp__freee__freee_api_delete",
  "mcp__freee__freee_api_patch",
  "mcp__freee__freee_file_upload",
];

/**
 * Tool allow rules derived from the placement's capabilities — the single
 * source of tool permission for placement sessions (gap G1; ADR-0004: no
 * second permission registry). `capabilities.mcp` server names become
 * whole-server allows (`mcp__<server>__*` — Claude Code allow rules accept a
 * tool-name glob after a literal server prefix); `capabilities.gatewayTools`
 * become individual `mcp__gateway__<tool>` allows so the gateway server is
 * never wholesale-allowed beyond its granted tool list. `mcp: false`/absent
 * derives nothing (deny by default). PLACEMENT_MCP_TOOL_DENY entries stay in
 * --disallowedTools and win over any allow derived here.
 */
export function placementAllowedTools(
  placement: Pick<PlacementProfile, "capabilities">,
): string[] {
  const mcp = placement.capabilities?.mcp;
  const servers = Array.isArray(mcp) ? mcp : [];
  return [
    ...servers.filter((name) => name !== "gateway").map((name) => `mcp__${name}__*`),
    ...(placement.capabilities?.gatewayTools ?? []).map((tool) => `mcp__gateway__${tool}`),
  ];
}

/**
 * Placement-local memory layer (docs/architecture/11_persona_skills_memory.md §3.1):
 * memory/placements/<placementId>/ is visible only to that placement's sessions.
 * Claude Code permissions cannot express "allow own, deny the rest", so the deny
 * list enumerates every other placement — the union of configured placement ids
 * and directories that exist on disk at session start. Residual gap (documented
 * in the spec): a placement directory created while a session is already running
 * is only denied from the next session on.
 */
export function placementMemoryReadDenyRules(
  placementId: string,
  configuredPlacementIds: string[],
  home: string = JINN_HOME,
): string[] {
  const placementsDir = path.join(home, "memory", "placements");
  const others = new Set(configuredPlacementIds);
  try {
    for (const entry of fs.readdirSync(placementsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) others.add(entry.name);
    }
  } catch {
    // memory/placements/ does not exist yet — configured ids still apply
  }
  others.delete(placementId);
  return PLACEMENT_READ_TOOLS.flatMap((tool) =>
    [...others].map((id) => `${tool}(/${path.join(placementsDir, id, "**")})`),
  );
}

export interface SkillCapabilityRequirements {
  requiredMcp: string[];
  requiredTools: string[];
  scope?: string;
}

/**
 * Skill visibility derives from placement capabilities and scope
 * (docs/architecture/11_persona_skills_memory.md §3.2). Skills never grant
 * capability — the placement's capabilities stay the source of truth; this
 * filter only hides skills the placement cannot execute or must not see.
 */
export function isSkillVisibleToPlacement(
  skill: SkillCapabilityRequirements,
  placement: Pick<PlacementProfile, "capabilities" | "projects">,
): boolean {
  const mcp = placement.capabilities?.mcp;
  const allowedMcp = Array.isArray(mcp) ? mcp : [];
  if (!skill.requiredMcp.every((name) => allowedMcp.includes(name))) return false;
  const allowedTools = placement.capabilities?.gatewayTools ?? [];
  if (!skill.requiredTools.every((name) => allowedTools.includes(name))) return false;
  if (skill.scope && !(placement.projects ?? []).includes(skill.scope)) return false;
  return true;
}

/** Keep every initial/retry caller on the same fail-closed engine boundary.
 *  Pure derivation from the placement passed in per run — no boot-time state,
 *  so a config hot-reload takes effect at the next spawn (gap G4). */
export function placementEngineBoundary(
  placement: PlacementProfile | undefined,
  configuredPlacements?: PlacementProfile[],
): PlacementEngineBoundary {
  return {
    strictMcpConfig: Boolean(placement),
    enableChrome: placement ? false : undefined,
    allowedTools: placement ? placementAllowedTools(placement) : undefined,
    disallowedTools: placement
      ? [
        ...placementWriteDenyRules(),
        ...placementMemoryReadDenyRules(
          placement.id,
          (configuredPlacements ?? []).map((p) => p.id),
        ),
        ...PLACEMENT_MCP_TOOL_DENY,
      ]
      : undefined,
    placementBashGuard: Boolean(placement),
  };
}

/** Single execution choke point so initial and retry call sites cannot drift. */
export async function runPlacementBoundEngine(
  engine: Engine,
  placement: PlacementProfile | undefined,
  opts: EngineRunOpts,
  configuredPlacements?: PlacementProfile[],
): Promise<EngineResult> {
  if (placement && engine.name !== "claude" && engine.name !== "mock") {
    throw new Error(
      `Placement-scoped execution rejects engine without Placement boundary support: ${engine.name}`,
    );
  }
  return engine.run({ ...opts, ...placementEngineBoundary(placement, configuredPlacements) });
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

/**
 * Speaker membership verdict for "channel-members" audiences, resolved by the
 * connector (Slack conversations.members). Anything other than "member" —
 * including "unknown" (API failure) and an absent verdict (connector without
 * membership support) — denies.
 */
export type ChannelMembership = "member" | "non-member" | "unknown";

function matchChannelPlacements(
  placements: PlacementProfile[],
  msg: Pick<IncomingMessage, "connector" | "channel" | "transportMeta">,
): PlacementProfile[] {
  const workspaceId = clean((msg.transportMeta as Record<string, unknown> | undefined)?.team);
  return placements.filter((placement) =>
    placement.connector === msg.connector
    && placement.channelId === msg.channel
    && placement.workspaceId === workspaceId,
  );
}

/**
 * True when this channel's unique placement delegates its audience to
 * connector-side channel membership. Callers use this to decide whether a
 * membership lookup is needed before resolvePlacement — skipping the network
 * round-trip for static-audience placements.
 */
export function placementNeedsChannelMembership(
  placements: PlacementProfile[] | undefined,
  msg: Pick<IncomingMessage, "connector" | "channel" | "transportMeta">,
): boolean {
  if (!placements || placements.length === 0) return false;
  const matches = matchChannelPlacements(placements, msg);
  return matches.length === 1 && matches[0].audience.type === "channel-members";
}

/** Resolve before session creation. Configured placements are fail-closed. */
export function resolvePlacement(
  placements: PlacementProfile[] | undefined,
  msg: Pick<IncomingMessage, "connector" | "channel" | "user" | "transportMeta">,
  opts?: { channelMembership?: ChannelMembership },
): PlacementResolution {
  if (!placements || placements.length === 0) return { status: "legacy" };

  const channelMatches = matchChannelPlacements(placements, msg);
  if (channelMatches.length === 0) return { status: "denied", reason: "unmatched" };
  if (channelMatches.length > 1) return { status: "denied", reason: "ambiguous" };

  const placement = channelMatches[0];
  if (!isPlacementEnabled(placement)) {
    return { status: "denied", reason: "disabled", placementId: placement.id };
  }
  if (containsSecret(placement)) {
    return { status: "denied", reason: "invalid_config" };
  }
  if (placement.audience.type === "channel-members") {
    if (opts?.channelMembership !== "member") {
      return { status: "denied", reason: "unauthorized_user", placementId: placement.id };
    }
  } else if (!(placement.audience.allowedUsers ?? []).includes(msg.user)) {
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
