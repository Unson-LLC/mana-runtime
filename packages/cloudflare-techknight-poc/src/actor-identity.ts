import type { SlackQueueEvent } from "./types.js";

/**
 * Task-domain identity for the Slack actor issuing a turn. personId must come
 * from a trusted server-side resolver — never derived from user text or LLM
 * output (same invariant as project/placement/operation binding). displayName
 * is untrusted Slack-profile metadata carried alongside it for potential
 * non-prompt use; it must never gate personId or reach a model prompt.
 */
export interface ActorIdentity {
  personId: string;
  displayName?: string;
}

export type ActorIdentityResolver = (event: SlackQueueEvent) => Promise<ActorIdentity | undefined>;

export type ActorIdentityOutcome =
  | { outcome: "resolved"; identity: ActorIdentity }
  | { outcome: "unavailable"; reasonCode: string };

export const MAX_PERSON_ID_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 80;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * personId and displayName are validated independently: personId is the
 * trusted resolution result and alone decides resolved/unavailable.
 * displayName is untrusted Slack-profile metadata — a malformed value (too
 * long, control characters) is dropped, not treated as a resolution failure,
 * so untrusted profile data can never deny a resolved, trusted personId.
 */
export function sanitizeActorIdentity(identity: ActorIdentity | undefined): ActorIdentity | undefined {
  if (!identity) return undefined;
  const personId = identity.personId.trim();
  if (!personId || personId.length > MAX_PERSON_ID_CHARS || hasControlChars(personId)) {
    return undefined;
  }
  const displayName = identity.displayName?.trim();
  const validDisplayName = displayName && displayName.length <= MAX_DISPLAY_NAME_CHARS && !hasControlChars(displayName)
    ? displayName
    : undefined;
  return { personId, ...(validDisplayName ? { displayName: validDisplayName } : {}) };
}

/**
 * Attempts actor identity resolution for one turn. Identity is only relevant
 * to the task-search path, so this is a no-op unless task search is enabled.
 * Every branch fails safe to "unavailable" — an unresolved actor must never
 * block the reply, only skip the "my tasks" shortcut.
 */
export async function resolveTurnActorIdentity(
  event: SlackQueueEvent,
  options: { taskSearchEnabled?: boolean; resolveActorIdentity?: ActorIdentityResolver },
): Promise<ActorIdentityOutcome> {
  if (!options.taskSearchEnabled) return { outcome: "unavailable", reasonCode: "task_search_disabled" };
  if (!options.resolveActorIdentity) return { outcome: "unavailable", reasonCode: "identity_resolver_not_configured" };

  let raw: ActorIdentity | undefined;
  try {
    raw = await options.resolveActorIdentity(event);
  } catch {
    return { outcome: "unavailable", reasonCode: "identity_resolution_failed" };
  }
  const identity = sanitizeActorIdentity(raw);
  if (!identity) {
    return { outcome: "unavailable", reasonCode: raw ? "identity_invalid" : "identity_unresolved" };
  }
  return { outcome: "resolved", identity };
}
