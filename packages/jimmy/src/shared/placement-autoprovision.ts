import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";
import { recordConfigChange } from "./config-history.js";
import { logger } from "./logger.js";
import type { JinnConfig, PlacementDefaultsConfig, PlacementProfile } from "./types.js";

/**
 * Invite-driven placement auto-provisioning.
 *
 * Trust model: whoever can invite the bot to a Slack channel has already made
 * the authorization call, and channel membership is Slack's own access
 * control (ADR-0004: no second permission system). On the bot's own
 * member_joined_channel event we persist a standard, deliberately narrow
 * profile for that channel; everything else about the placement lifecycle
 * (promotion, budget raises, cross-channel delivery) stays a manual config
 * edit.
 *
 * Every write goes through the config-history snapshot machinery and lands
 * via write-to-temp + rename, so a failure at any point leaves config.yaml
 * exactly as it was (fail-closed: the channel simply stays fully denied).
 */

export const AUTO_PROVISION_SOURCE = "auto-provision";

export interface AutoProvisionChannelInput {
  connector: string;
  workspaceId: string;
  channelId: string;
  /** Slack user ID of the inviter, when the event carried one. */
  inviterUserId?: string | null;
}

export type AutoProvisionResult =
  | { outcome: "created"; placement: PlacementProfile }
  | { outcome: "exists"; placementId: string }
  | { outcome: "not-placement-mode" }
  | { outcome: "auto-provision-disabled" }
  | { outcome: "error"; message: string };

export type PlacementDisableResult =
  | { outcome: "disabled"; placementId: string }
  | { outcome: "already-disabled"; placementId: string }
  | { outcome: "not-found" }
  | { outcome: "error"; message: string };

/**
 * The standard profile (user-approved, 2026-07-31). config.yaml
 * `placementDefaults` replaces individual fields wholesale; the channel/owner
 * identity fields always come from the invite event.
 */
const STANDARD_AGENT: NonNullable<PlacementProfile["agent"]> = {
  defaultModel: "sonnet",
  escalationEmployee: "critical-reviewer",
};
const STANDARD_CAPABILITIES: NonNullable<PlacementProfile["capabilities"]> = {
  mcp: ["brainbase", "gateway"],
  // allowedDelivery is intentionally omitted: placementDeliveryTargets falls
  // back to the placement's own channel, so an auto-provisioned agent can
  // never deliver anywhere else.
  gatewayTools: ["send_message", "create_task", "list_tasks", "update_task", "transition_task"],
};
const STANDARD_DATA_SCOPES: Record<string, unknown> = { graph: "read-only" };
const STANDARD_MONTHLY_BUDGET_USD = 10;

export function buildAutoProvisionedPlacement(
  input: AutoProvisionChannelInput,
  defaults?: PlacementDefaultsConfig,
): PlacementProfile {
  const inviter = input.inviterUserId?.trim() || undefined;
  return {
    id: `auto-${input.channelId}`,
    connector: input.connector,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    ...(inviter ? { owner: inviter } : {}),
    purpose: `auto-provisioned (invited by ${inviter ?? "unknown"})`,
    audience: { type: "channel-members" },
    agent: defaults?.agent ?? STANDARD_AGENT,
    capabilities: defaults?.capabilities ?? STANDARD_CAPABILITIES,
    dataScopes: defaults?.dataScopes ?? STANDARD_DATA_SCOPES,
    monthlyBudgetUsd: defaults?.monthlyBudgetUsd ?? STANDARD_MONTHLY_BUDGET_USD,
  };
}

function loadConfigFile(configPath: string): JinnConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`config at ${configPath} did not parse to an object`);
  }
  return parsed as JinnConfig;
}

/**
 * Snapshot-then-atomically-replace. The temp file lives in the same directory
 * so the final rename is atomic on the same filesystem; a crash between the
 * two steps leaves the original config untouched.
 */
function writeConfigAtomically(configPath: string, config: JinnConfig): void {
  recordConfigChange(configPath, AUTO_PROVISION_SOURCE);
  const tmpPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.auto-provision.tmp`,
  );
  fs.writeFileSync(tmpPath, yaml.dump(config, { lineWidth: -1 }), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

function findChannelPlacement(
  placements: PlacementProfile[],
  input: Pick<AutoProvisionChannelInput, "connector" | "workspaceId" | "channelId">,
): PlacementProfile | undefined {
  return placements.find((placement) =>
    placement.connector === input.connector
    && placement.workspaceId === input.workspaceId
    && placement.channelId === input.channelId,
  );
}

/**
 * Create the channel's placement on bot invite. No-op (never a write) when
 * the instance is not in placement mode, auto-provisioning is switched off,
 * or the channel already has a placement — including a disabled one, so a
 * re-invite cannot silently resurrect a killed placement.
 */
export function autoProvisionPlacement(
  input: AutoProvisionChannelInput,
  opts?: { configPath?: string },
): AutoProvisionResult {
  const configPath = opts?.configPath ?? CONFIG_PATH;
  try {
    const config = loadConfigFile(configPath);
    // Placement-mode gate: without a configured `placements:` key the
    // instance runs legacy (allow-all) routing. Auto-creating the FIRST
    // placement would flip every other channel to fail-closed denial — that
    // switch must stay an explicit operator decision.
    if (!("placements" in config)) return { outcome: "not-placement-mode" };
    if (config.placementDefaults?.autoProvision === false) {
      return { outcome: "auto-provision-disabled" };
    }
    const placements = Array.isArray(config.placements) ? config.placements : [];
    const existing = findChannelPlacement(placements, input);
    if (existing) return { outcome: "exists", placementId: existing.id };

    const placement = buildAutoProvisionedPlacement(input, config.placementDefaults);
    config.placements = [...placements, placement];
    writeConfigAtomically(configPath, config);
    logger.info(
      `auto-provisioned placement ${placement.id} for ${input.connector}:${input.channelId} (owner: ${placement.owner ?? "unknown"})`,
    );
    return { outcome: "created", placement };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`placement auto-provision failed for ${input.connector}:${input.channelId}: ${message}`);
    return { outcome: "error", message };
  }
}

/**
 * Kill-switch the channel's placement when the bot leaves. The entry is kept
 * (enabled: false) so the audit trail — owner, purpose, cost attribution —
 * survives; deletion stays a manual operation.
 */
export function disablePlacementOnLeave(
  input: Pick<AutoProvisionChannelInput, "connector" | "workspaceId" | "channelId">,
  opts?: { configPath?: string },
): PlacementDisableResult {
  const configPath = opts?.configPath ?? CONFIG_PATH;
  try {
    const config = loadConfigFile(configPath);
    const placements = Array.isArray(config.placements) ? config.placements : [];
    const existing = findChannelPlacement(placements, input);
    if (!existing) return { outcome: "not-found" };
    if (existing.enabled === false) return { outcome: "already-disabled", placementId: existing.id };

    existing.enabled = false;
    writeConfigAtomically(configPath, config);
    logger.info(`disabled placement ${existing.id} after bot left ${input.connector}:${input.channelId}`);
    return { outcome: "disabled", placementId: existing.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`placement disable-on-leave failed for ${input.connector}:${input.channelId}: ${message}`);
    return { outcome: "error", message };
  }
}

/** Posted to the channel exactly once, right after a successful provision. */
export function buildAutoProvisionGreeting(placement: PlacementProfile): string {
  const owner = placement.owner ? `<@${placement.owner}>` : "未設定（operatorへ連絡してください）";
  return [
    "このチャンネルに標準プロファイルで配属されました。チャンネルメンバーならメンションで利用できます。",
    `owner: ${owner}`,
    "できること:",
    "- 質問応答と調査（brainbase Graph/wikiは読み取りのみ）",
    "- タスクの作成・一覧・更新・状態遷移",
    "- このチャンネルへの返信・通知（他チャンネルへは配信しません）",
    "権限の昇格（他チャンネル配信・cron・予算増額など）は owner から operator へ依頼してください。",
  ].join("\n");
}
