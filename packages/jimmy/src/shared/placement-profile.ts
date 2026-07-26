import type { IncomingMessage, PlacementDeliveryTarget, PlacementProfile } from "./types.js";

export interface PlacementResolution {
  status: "legacy" | "matched" | "denied";
  placement?: PlacementProfile;
  reason?: "unmatched" | "ambiguous" | "unauthorized_user";
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
