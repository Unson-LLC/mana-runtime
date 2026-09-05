import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import type { MeetingMinutesRecoveryAuthorization } from "./meeting-minutes-contracts.js";

export function hasStableMeetingMinutesRecoveryAuthority(
  fresh: TenantContextEnvelope,
  authorization: MeetingMinutesRecoveryAuthorization,
): boolean {
  const freshProjects = [...fresh.authorization.project_ids].sort();
  const authorizedProjects = [...authorization.projectIds].sort();
  const sameProjects = freshProjects.length === authorizedProjects.length &&
    freshProjects.every((projectId, index) => projectId === authorizedProjects[index]);

  return fresh.tenant.tenant_id === authorization.tenantId &&
    fresh.workspace_connection.workspace_id === authorization.workspaceId &&
    fresh.workspace_connection.app_id === authorization.appId &&
    fresh.actor.principal_id === authorization.actorPrincipalId &&
    fresh.actor.authenticated_subject_id === authorization.requesterId &&
    fresh.slack.channel_id === authorization.channelId &&
    fresh.slack.thread_ts === authorization.threadTs &&
    fresh.slack.requester_id === authorization.requesterId &&
    fresh.audience.includes(authorization.audience) &&
    fresh.authorization.capability_ids.includes(authorization.capabilityId) &&
    sameProjects &&
    fresh.placement.deployment_id === authorization.deploymentId &&
    fresh.placement.profile === authorization.profile;
}
