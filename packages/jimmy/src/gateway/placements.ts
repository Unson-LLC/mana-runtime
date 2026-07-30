import type { PlacementProfile } from '../shared/types.js';
import { placementDeliveryTargets, safePlacementDataScopes } from '../shared/placement-profile.js';
import { getCostsByPlacement, UNPLACED_COST_KEY, type PlacementCostRow } from './costs.js';

export interface PlacementLedgerEntry {
  id: string;
  connector: string;
  workspaceId: string;
  channelId: string;
  owner: string | null;
  purpose: string | null;
  enabled: boolean;
  audienceType: string;
  allowedUserCount: number;
  employee: string | null;
  defaultModel: string | null;
  /** False when agent.employee is unset — the placement escapes employee budgets. */
  budgetTracked: boolean;
  mcp: false | string[];
  gatewayTools: string[];
  deliveryTargets: string[];
  monthlyCost: number;
  monthlySessions: number;
  lastActivity: string | null;
}

export interface PlacementLedger {
  placements: PlacementLedgerEntry[];
  /** Spend from sessions that never bound to a placement — kept visible, never dropped. */
  unplaced: { monthlyCost: number; monthlySessions: number; lastActivity: string | null };
  /** Spend bound to placement ids that are no longer configured (decommission trail). */
  orphanCosts: PlacementCostRow[];
}

/**
 * Agent ledger projection: a fixed field allowlist (never the raw profile) with
 * value-level redaction on free-text fields, joined with monthly placement costs.
 */
export function buildPlacementLedger(placements: PlacementProfile[] | undefined): PlacementLedger {
  const costRows = getCostsByPlacement('month');
  const costsById = new Map(costRows.map((row) => [row.placementId, row]));
  const configured = placements ?? [];

  const entries = configured.map((placement) => {
    const cost = costsById.get(placement.id);
    const freeText = safePlacementDataScopes({ owner: placement.owner, purpose: placement.purpose });
    return {
      id: placement.id,
      connector: placement.connector,
      workspaceId: placement.workspaceId,
      channelId: placement.channelId,
      owner: typeof freeText.owner === 'string' ? freeText.owner : null,
      purpose: typeof freeText.purpose === 'string' ? freeText.purpose : null,
      enabled: placement.enabled !== false,
      audienceType: placement.audience.type,
      allowedUserCount: placement.audience.allowedUsers.length,
      employee: placement.agent?.employee ?? null,
      defaultModel: placement.agent?.defaultModel ?? null,
      budgetTracked: Boolean(placement.agent?.employee),
      mcp: placement.capabilities?.mcp ?? false,
      gatewayTools: placement.capabilities?.gatewayTools ?? [],
      deliveryTargets: placementDeliveryTargets(placement).map((target) => `${target.connector}:${target.channel}`),
      monthlyCost: cost?.cost ?? 0,
      monthlySessions: cost?.sessions ?? 0,
      lastActivity: cost?.lastActivity ?? null,
    } satisfies PlacementLedgerEntry;
  });

  const configuredIds = new Set(configured.map((placement) => placement.id));
  const unplacedRow = costsById.get(UNPLACED_COST_KEY);
  const orphanCosts = costRows.filter(
    (row) => row.placementId !== UNPLACED_COST_KEY && !configuredIds.has(row.placementId),
  );

  return {
    placements: entries,
    unplaced: {
      monthlyCost: unplacedRow?.cost ?? 0,
      monthlySessions: unplacedRow?.sessions ?? 0,
      lastActivity: unplacedRow?.lastActivity ?? null,
    },
    orphanCosts,
  };
}
