import { resolveSlackUserProfile } from "./slack-user-profile.js";

export async function appendSlackThreadParticipantProfiles(context: string | undefined, options: {
  botToken?: string; fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  if (!context) return context;
  const ids = [...new Set([...context.matchAll(/<@(U[A-Z0-9]{2,31})>/g)].map((match) => match[1]!))].slice(0, 20);
  if (!ids.length || (!options.botToken && !options.fetchImpl)) return context;
  const results = await Promise.all(ids.map((userId) => resolveSlackUserProfile({ userId, botToken: options.botToken, fetchImpl: options.fetchImpl })));
  const lines = results.flatMap((result, index) => result.status === "resolved" ? [
    `${ids[index]}: display_name=${result.profile.displayName ?? "unknown"}; real_name=${result.profile.realName ?? "unknown"}; handle=${result.profile.handle ?? "unknown"}; timezone=${result.profile.timezone ?? "unknown"}`,
  ] : []);
  return lines.length ? `${context.trim()}\n\n[Slack thread participant profiles]\n${lines.join("\n")}`.slice(0, 24_000) : context;
}
