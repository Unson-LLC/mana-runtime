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
  // Brainbase can sign a destination authority together with other projects
  // already authorized for the same tenant. Keep that exact signed set while
  // requiring the configured destination authority to be present.
  if (authorization.project_ids.includes(authorityProjectId)) {
    return { project_id: authorityProjectId, project_ids: [...authorization.project_ids] };
  }
  return resolveCanonicalProjectScope(authorization, [destination.contextProjectCode], boundary);
}

export function resolveMeetingMinutesDestinationAuthorization(
  destination: MeetingMinutesDestination,
  authorityProjectIdsJson: string | undefined,
  audience: string,
  capabilityId: string,
  boundary: BoundaryName,
): {
  required_authorization: { audience: string; project_id: string; capability_id: string };
  trusted_project_ids: readonly string[];
} {
  if (!destination.contextProjectCode) {
    throw new TenantBoundaryError(boundary, "PROJECT_SCOPE_MISMATCH", "PROJECT_SCOPE_MISMATCH", {
      scope_reason: "destination_authority_project_id_missing",
    });
  }
  let configured: Record<string, unknown>;
  try {
    configured = authorityProjectIdsJson
      ? JSON.parse(authorityProjectIdsJson) as Record<string, unknown>
      : {};
  } catch {
    throw new TenantBoundaryError(boundary, "PROJECT_SCOPE_MISMATCH", "PROJECT_SCOPE_MISMATCH", {
      scope_reason: "destination_authority_project_ids_invalid",
    });
  }
  const projectId = configured[destination.contextProjectCode];
  if (typeof projectId !== "string" || !/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new TenantBoundaryError(boundary, "PROJECT_SCOPE_MISMATCH", "PROJECT_SCOPE_MISMATCH", {
      scope_reason: "destination_authority_project_id_missing",
    });
  }
  return {
    required_authorization: { audience, project_id: projectId, capability_id: capabilityId },
    trusted_project_ids: [projectId],
  };
}
