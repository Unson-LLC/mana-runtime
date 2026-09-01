import type { MeetingMinutesDestination, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";

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
