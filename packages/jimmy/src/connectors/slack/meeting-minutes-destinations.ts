import type { MinutesDestination } from "./meeting-minutes-generator.js";

export interface LegacyMinutesShareDestination {
  shareId: string;
  projectId: string;
  name: string;
  connectorInstanceId: string;
  workspaceId: string;
  channelId: string;
}

export interface CanonicalMinutesDestination extends MinutesDestination {
  destinationId: string;
  connectorInstanceId: string;
  workspaceId?: string;
  authorityMode: "legacy-source" | "explicit";
}

export function normalizeMeetingMinutesDestinations(input: {
  sourceConnectorInstanceId: string;
  destinations?: MinutesDestination[];
  shareDestinations?: LegacyMinutesShareDestination[];
}): CanonicalMinutesDestination[] {
  const normalized: CanonicalMinutesDestination[] = [];
  for (const destination of input.destinations ?? []) {
    if (!destination?.projectId || !destination.name || !destination.channelId) continue;
    const connector = destination.connectorInstanceId?.trim();
    const workspace = destination.workspaceId?.trim();
    if (Boolean(connector) !== Boolean(workspace)) {
      throw new Error(`meeting-minutes destination authority is incomplete: ${destination.projectId}`);
    }
    normalized.push({
      ...destination,
      destinationId: destination.destinationId?.trim() || `legacy:${destination.projectId}:${destination.channelId}`,
      connectorInstanceId: connector || input.sourceConnectorInstanceId,
      ...(workspace ? { workspaceId: workspace } : {}),
      authorityMode: connector ? "explicit" : "legacy-source",
    });
  }
  for (const destination of input.shareDestinations ?? []) {
    if (!destination?.shareId || !destination.projectId || !destination.name || !destination.connectorInstanceId || !destination.workspaceId || !destination.channelId) continue;
    normalized.push({
      destinationId: destination.shareId,
      projectId: destination.projectId,
      name: destination.name,
      connectorInstanceId: destination.connectorInstanceId,
      workspaceId: destination.workspaceId,
      channelId: destination.channelId,
      authorityMode: "explicit",
    });
  }
  const ids = new Set<string>();
  for (const destination of normalized) {
    if (ids.has(destination.destinationId)) throw new Error(`duplicate meeting-minutes destinationId: ${destination.destinationId}`);
    ids.add(destination.destinationId);
  }
  return normalized;
}
