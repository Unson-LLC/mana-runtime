export interface MeetingMinutesSlackTokens {
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
}

export interface MeetingMinutesSlackWorkspaceBinding {
  workspace_id: string;
}

export function resolveMeetingMinutesDestinationSlackToken(
  env: MeetingMinutesSlackTokens,
  organizationId: string,
): string {
  if (organizationId === "unson") return env.SLACK_BOT_TOKEN_UNSON ?? "";
  if (organizationId === "tech-knight") return env.SLACK_BOT_TOKEN_TECHKNIGHT ?? "";
  return env.SLACK_BOT_TOKEN ?? "";
}

/**
 * Cross-workspace meeting-minutes delivery is an outbound effect owned by the
 * source operation. Use the destination's explicitly configured bot token for
 * that effect; same-workspace delivery stays on the canonical credential
 * broker path.
 */
export function resolveCrossWorkspaceMeetingMinutesSlackToken(
  env: MeetingMinutesSlackTokens,
  organizationId: string,
  sourceWorkspaceId: string,
  destination: MeetingMinutesSlackWorkspaceBinding,
): string | undefined {
  if (destination.workspace_id === sourceWorkspaceId) return undefined;
  const token = resolveMeetingMinutesDestinationSlackToken(env, organizationId).trim();
  return token || undefined;
}
