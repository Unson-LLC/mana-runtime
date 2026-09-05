import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import type { MeetingMinutesRecoveryAuthorization } from "./meeting-minutes-contracts.js";

export function meetingMinutesRecoveryAuthorityMismatches(
  fresh: TenantContextEnvelope,
  authorization: MeetingMinutesRecoveryAuthorization,
): string[] {
  const freshProjects = [...fresh.authorization.project_ids].sort();
  const authorizedProjects = [...authorization.projectIds].sort();
  const sameProjects = freshProjects.length === authorizedProjects.length &&
    freshProjects.every((projectId, index) => projectId === authorizedProjects[index]);

  return [
    fresh.tenant.tenant_id === authorization.tenantId ? undefined : "tenant",
    fresh.workspace_connection.workspace_id === authorization.workspaceId ? undefined : "workspace",
    fresh.workspace_connection.app_id === authorization.appId ? undefined : "app",
    fresh.actor.authenticated_subject_id === authorization.requesterId ? undefined : "authenticated_subject",
    fresh.slack.channel_id === authorization.channelId ? undefined : "channel",
    fresh.slack.thread_ts === authorization.threadTs ? undefined : "thread",
    fresh.slack.requester_id === authorization.requesterId ? undefined : "requester",
    fresh.audience.includes(authorization.audience) ? undefined : "audience",
    fresh.authorization.capability_ids.includes(authorization.capabilityId) ? undefined : "capability",
    sameProjects ? undefined : "projects",
    fresh.placement.deployment_id === authorization.deploymentId ? undefined : "deployment",
    fresh.placement.profile === authorization.profile ? undefined : "profile",
  ].filter((value): value is string => value !== undefined);
}

export function hasStableMeetingMinutesRecoveryAuthority(
  fresh: TenantContextEnvelope,
  authorization: MeetingMinutesRecoveryAuthorization,
): boolean {
  return meetingMinutesRecoveryAuthorityMismatches(fresh, authorization).length === 0;
}
