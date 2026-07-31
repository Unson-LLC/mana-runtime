import fs from "node:fs";
import path from "node:path";
import type { Engine, EngineResult, EngineRunOpts, IncomingMessage, McpGlobalConfig, PlacementDeliveryTarget, PlacementMcpMode, PlacementProfile } from "./types.js";
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
  // The operator's personal KG is a sensitivity default (gap G7), not a
  // granularity vocabulary — it stays pinned in code regardless of what any
  // catalog or placement declares. (The former freee write-tool entries moved
  // to the catalog's `tools.writeTools` declaration + a placement-side
  // `mode: "read-only"` grant — gap G2+G6.)
  "mcp__brainbase__search_personal_kg",
];

/** A normalized, validated `capabilities.mcp` grant. */
export interface ResolvedPlacementMcpGrant {
  name: string;
  mode: PlacementMcpMode;
}

/**
 * Outcome of resolving a placement's `capabilities.mcp` against the MCP
 * catalog. `granted` entries are usable; `rejected` names failed closed —
 * a read-only grant for a server whose catalog entry declares no tool
 * classification (or a malformed entry) grants nothing at all rather than
 * silently degrading to full access (ADR-0001 deny by default).
 */
export interface PlacementMcpResolution {
  granted: ResolvedPlacementMcpGrant[];
  rejected: string[];
}

/** Catalog-declared write tools for a server; undefined = no classification. */
function catalogWriteTools(catalog: McpGlobalConfig | undefined, server: string): string[] | undefined {
  return catalog?.custom?.[server]?.tools?.writeTools;
}

/**
 * Resolve `capabilities.mcp` entries (string or `{name, mode}`) against the
 * catalog's tool classification (gap G2+G6). Plain strings and `mode: "full"`
 * grants pass through unchanged (backward compatible). `mode: "read-only"`
 * requires the catalog to declare `tools.writeTools` for that server — the
 * asset declares its own nature, same pattern as skill frontmatter — otherwise
 * the grant is rejected fail-closed. Unknown modes and malformed entries are
 * rejected the same way, never widened to full access.
 */
export function resolvePlacementMcp(
  placement: Pick<PlacementProfile, "capabilities">,
  catalog?: McpGlobalConfig,
): PlacementMcpResolution {
  const mcp = placement.capabilities?.mcp;
  const entries = Array.isArray(mcp) ? mcp : [];
  const granted: ResolvedPlacementMcpGrant[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      granted.push({ name: entry, mode: "full" });
      continue;
    }
    const name = typeof entry?.name === "string" ? entry.name : undefined;
    if (!name) continue;
    const mode = entry.mode ?? "full";
    if (mode === "full") {
      granted.push({ name, mode });
    } else if (mode === "read-only" && catalogWriteTools(catalog, name) !== undefined) {
      granted.push({ name, mode });
    } else {
      rejected.push(name);
    }
  }
  return { granted, rejected };
}

/**
 * Server names usable by this placement, in the `false | string[]` shape the
 * MCP resolver consumes. Rejected (fail-closed) grants are excluded, so a
 * server that cannot honor its requested read-only mode is never spawned.
 */
export function placementMcpServerNames(
  placement: Pick<PlacementProfile, "capabilities">,
  catalog?: McpGlobalConfig,
): false | string[] {
  if (!Array.isArray(placement.capabilities?.mcp)) return false;
  return resolvePlacementMcp(placement, catalog).granted.map((grant) => grant.name);
}

/**
 * Tool allow rules derived from the placement's capabilities — the single
 * source of tool permission for placement sessions (gap G1; ADR-0004: no
 * second permission registry). Granted `capabilities.mcp` servers become
 * whole-server allows (`mcp__<server>__*` — Claude Code allow rules accept a
 * tool-name glob after a literal server prefix); `capabilities.gatewayTools`
 * become individual `mcp__gateway__<tool>` allows so the gateway server is
 * never wholesale-allowed beyond its granted tool list. `mcp: false`/absent
 * derives nothing (deny by default), and fail-closed rejected grants derive
 * nothing either. PLACEMENT_MCP_TOOL_DENY entries and read-only write-tool
 * denies stay in --disallowedTools and win over any allow derived here.
 */
export function placementAllowedTools(
  placement: Pick<PlacementProfile, "capabilities">,
  catalog?: McpGlobalConfig,
): string[] {
  const { granted } = resolvePlacementMcp(placement, catalog);
  return [
    ...granted.filter((grant) => grant.name !== "gateway").map((grant) => `mcp__${grant.name}__*`),
    ...(placement.capabilities?.gatewayTools ?? []).map((tool) => `mcp__gateway__${tool}`),
  ];
}

/**
 * Deny rules derived from read-only grants (gap G2): the catalog's declared
 * writeTools become `mcp__<server>__<tool>` entries for --disallowedTools.
 * Deny always beats allow in every Claude Code permission mode (including
 * bypassPermissions), so a read-only server's whole-server allow can never
 * reach its write surface.
 */
export function placementReadOnlyDenyRules(
  placement: Pick<PlacementProfile, "capabilities">,
  catalog?: McpGlobalConfig,
): string[] {
  return resolvePlacementMcp(placement, catalog).granted
    .filter((grant) => grant.mode === "read-only")
    .flatMap((grant) =>
      (catalogWriteTools(catalog, grant.name) ?? []).map((tool) => `mcp__${grant.name}__${tool}`),
    );
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
  catalog?: McpGlobalConfig,
): boolean {
  const allowedMcp = resolvePlacementMcp(placement, catalog).granted.map((grant) => grant.name);
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
  mcpCatalog?: McpGlobalConfig,
): PlacementEngineBoundary {
  return {
    strictMcpConfig: Boolean(placement),
    enableChrome: placement ? false : undefined,
    allowedTools: placement ? placementAllowedTools(placement, mcpCatalog) : undefined,
    disallowedTools: placement
      ? [
        ...placementWriteDenyRules(),
        ...placementMemoryReadDenyRules(
          placement.id,
          (configuredPlacements ?? []).map((p) => p.id),
        ),
        ...PLACEMENT_MCP_TOOL_DENY,
        ...placementReadOnlyDenyRules(placement, mcpCatalog),
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
  mcpCatalog?: McpGlobalConfig,
): Promise<EngineResult> {
  if (placement && engine.name !== "claude" && engine.name !== "mock") {
    throw new Error(
      `Placement-scoped execution rejects engine without Placement boundary support: ${engine.name}`,
    );
  }
  return engine.run({ ...opts, ...placementEngineBoundary(placement, configuredPlacements, mcpCatalog) });
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
