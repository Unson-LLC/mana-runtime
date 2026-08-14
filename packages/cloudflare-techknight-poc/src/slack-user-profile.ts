export interface SlackUserProfile {
  userId: string;
  name: string;
  displayName?: string;
  realName?: string;
  handle?: string;
  timezone?: string;
}

export type SlackUserProfileResolution =
  | { status: "resolved"; profile: SlackUserProfile }
  | { status: "unavailable"; reason: "slack_api_error" }
  | { status: "rejected"; reason: "deleted_user" | "bot_user" };

export class SlackUserProfileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SlackUserProfileError";
  }
}

export function requesterProfileOrFallback(
  userId: string,
  resolution: SlackUserProfileResolution,
): SlackUserProfile {
  if (resolution.status === "rejected") {
    throw new SlackUserProfileError("requester_profile_rejected");
  }
  return resolution.status === "resolved" ? resolution.profile : { userId, name: userId };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveSlackUserProfile(input: {
  userId: string;
  botToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackUserProfileResolution> {
  if (!input.botToken || !/^[A-Z0-9_]{3,64}$/.test(input.userId)) {
    return { status: "unavailable", reason: "slack_api_error" };
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `https://slack.com/api/users.info?user=${encodeURIComponent(input.userId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${input.botToken}` }, signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return { status: "unavailable", reason: "slack_api_error" };
  }
  if (!response.ok) return { status: "unavailable", reason: "slack_api_error" };
  let payload: unknown;
  try { payload = await response.json(); } catch { return { status: "unavailable", reason: "slack_api_error" }; }
  if (typeof payload !== "object" || payload === null || (payload as { ok?: unknown }).ok !== true) {
    return { status: "unavailable", reason: "slack_api_error" };
  }
  const user = (payload as { user?: unknown }).user;
  if (typeof user !== "object" || user === null || text((user as { id?: unknown }).id) !== input.userId) {
    return { status: "unavailable", reason: "slack_api_error" };
  }
  if ((user as { deleted?: unknown }).deleted === true) return { status: "rejected", reason: "deleted_user" };
  if ((user as { is_bot?: unknown }).is_bot === true) return { status: "rejected", reason: "bot_user" };
  const raw = user as Record<string, unknown>;
  const profile = typeof raw.profile === "object" && raw.profile !== null ? raw.profile as Record<string, unknown> : {};
  const displayName = text(profile.display_name);
  const realName = text(raw.real_name) ?? text(profile.real_name);
  const handle = text(raw.name);
  const name = displayName ?? realName ?? handle ?? input.userId;
  return { status: "resolved", profile: {
    userId: input.userId, name,
    ...(displayName ? { displayName } : {}),
    ...(realName ? { realName } : {}),
    ...(handle ? { handle } : {}),
    ...(text(raw.tz) ? { timezone: text(raw.tz) } : {}),
  } };
}
