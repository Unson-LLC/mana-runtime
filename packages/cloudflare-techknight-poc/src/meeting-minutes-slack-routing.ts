export interface MeetingMinutesSlackTokens {
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
}

export function resolveMeetingMinutesDestinationSlackToken(
  env: MeetingMinutesSlackTokens,
  organizationId: string,
): string {
  if (organizationId === "unson") return env.SLACK_BOT_TOKEN_UNSON ?? "";
  if (organizationId === "tech-knight") return env.SLACK_BOT_TOKEN_TECHKNIGHT ?? "";
  return env.SLACK_BOT_TOKEN ?? "";
}
