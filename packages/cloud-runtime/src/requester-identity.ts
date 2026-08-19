import type { SlackQueueEvent } from "./types.js";

export type RequesterIdentityBindings = Record<
  string,
  Record<string, string | readonly string[]>
>;

export interface RequesterIdentity {
  slackUserId: string;
  personId: string;
}

export class RequesterIdentityError extends Error {
  constructor(readonly code: "requester_identity_not_found" | "requester_identity_ambiguous") {
    super(code);
    this.name = "RequesterIdentityError";
  }
}

export function parseRequesterIdentityBindings(raw: string | undefined): RequesterIdentityBindings {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const bindings: RequesterIdentityBindings = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const separator = key.indexOf(":");
      if (separator < 1 || typeof value !== "string" || !value.trim()) continue;
      const workspaceId = key.slice(0, separator);
      const userId = key.slice(separator + 1);
      if (!workspaceId || !userId) continue;
      (bindings[workspaceId] ??= {})[userId] = value.trim();
    }
    return bindings;
  } catch {
    return {};
  }
}

export function requestsOwnTasks(text: string): boolean {
  return /(?:私|自分|俺)(?:の)?(?:担当)?タスク/.test(text);
}

export function resolveRequesterIdentity(
  event: Pick<SlackQueueEvent, "workspaceId" | "userId">,
  bindings: RequesterIdentityBindings | undefined,
): RequesterIdentity {
  if (!event.userId) throw new RequesterIdentityError("requester_identity_not_found");
  const candidate = bindings?.[event.workspaceId]?.[event.userId];
  if (typeof candidate === "string" && candidate.trim()) {
    return { slackUserId: event.userId, personId: candidate.trim() };
  }
  if (Array.isArray(candidate) && candidate.filter((value) => value.trim()).length > 1) {
    throw new RequesterIdentityError("requester_identity_ambiguous");
  }
  throw new RequesterIdentityError("requester_identity_not_found");
}
