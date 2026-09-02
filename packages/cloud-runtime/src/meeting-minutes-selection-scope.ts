import type { MeetingMinutesDestination, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import type { BoundaryName } from "./multitenancy/contracts.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";
import { resolveCanonicalProjectScope } from "./multitenancy/project-scope.js";

export function meetingMinutesSelectionDestination(
  selection: MeetingMinutesSelection,
  destinations: readonly MeetingMinutesDestination[],
): MeetingMinutesDestination {
  const destination = destinations.find((candidate) => candidate.id === selection.destinationId);
  if (!destination) {
    throw new TenantBoundaryError("queue_consumer", "PROJECT_SCOPE_MISMATCH", "PROJECT_SCOPE_MISMATCH", {
      scope_reason: "meeting_minutes_destination_missing",
    });
  }
  return destination;
}

export function resolveMeetingMinutesDestinationProjectScope(
  authorization: { readonly project_ids: readonly string[]; readonly data_scopes: readonly string[] },
  destination: MeetingMinutesDestination,
  authorityProjectId: string,
  boundary: BoundaryName,
): { project_id: string; project_ids: readonly string[] } {
  try {
    return resolveCanonicalProjectScope(authorization, [authorityProjectId], boundary);
  } catch (error) {
    if (!(error instanceof TenantBoundaryError) || error.code !== "PROJECT_SCOPE_MISMATCH") throw error;
  }
  return resolveCanonicalProjectScope(authorization, [destination.contextProjectCode], boundary);
}
