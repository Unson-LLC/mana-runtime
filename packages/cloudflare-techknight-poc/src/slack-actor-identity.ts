import { MAX_PERSON_ID_CHARS, type ActorIdentity, type ActorIdentityResolver } from "./actor-identity.js";
import type { SlackQueueEvent } from "./types.js";

const MAX_MAP_JSON_CHARS = 200_000;
const MAX_MAP_ENTRIES = 5_000;
const MAX_MAP_KEY_CHARS = 160;

/**
 * BRAINBASE_SLACK_PERSON_MAP_JSON is the direct identity bridge carried over
 * from the legacy Jimmy resolver (workspaceId:userId -> canonical person_id).
 * Any shape/size violation must fail closed rather than silently drop entries,
 * since a truncated map could otherwise let an unmapped actor pass through.
 */
export class SlackActorIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SlackActorIdentityError";
  }
}

function parseSlackPersonMap(rawJson: string): Map<string, string> {
  if (rawJson.length > MAX_MAP_JSON_CHARS) throw new SlackActorIdentityError("person_map_too_large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new SlackActorIdentityError("person_map_invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SlackActorIdentityError("person_map_invalid_shape");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_MAP_ENTRIES) throw new SlackActorIdentityError("person_map_too_many_entries");

  const map = new Map<string, string>();
  for (const [key, value] of entries) {
    if (
      key.length === 0 || key.length > MAX_MAP_KEY_CHARS ||
      typeof value !== "string" || value.length === 0 || value.length > MAX_PERSON_ID_CHARS
    ) {
      throw new SlackActorIdentityError("person_map_entry_invalid");
    }
    map.set(key, value);
  }
  return map;
}

export function resolveCanonicalPersonId(
  rawPersonMapJson: string,
  workspaceId: string,
  userId: string,
): string | undefined {
  const map = parseSlackPersonMap(rawPersonMapJson);
  return map.get(`${workspaceId}:${userId}`);
}

export interface SlackActorIdentityResolverOptions {
  personMapJson: string;
}

/**
 * personId is the only trusted output. There is deliberately no Slack API
 * call here — a display name has no consumer (never reaches a prompt or a
 * log) and would only add latency, a users:read scope dependency, and an
 * extra failure surface for no benefit.
 */
export function createSlackActorIdentityResolver(
  options: SlackActorIdentityResolverOptions,
): ActorIdentityResolver {
  return async (event: SlackQueueEvent): Promise<ActorIdentity | undefined> => {
    if (!event.userId) return undefined;
    const personId = resolveCanonicalPersonId(options.personMapJson, event.workspaceId, event.userId);
    return personId ? { personId } : undefined;
  };
}

export interface SlackActorIdentityEnv {
  BRAINBASE_SLACK_PERSON_MAP_JSON?: string;
}

/**
 * Only wires a resolver when the person map secret is configured. Otherwise
 * identity resolution stays a no-op — a missing secret must fall back to
 * "no identity", never block a reply.
 */
export function resolveActorIdentityResolverFromEnv(
  env: SlackActorIdentityEnv,
): ActorIdentityResolver | undefined {
  if (!env.BRAINBASE_SLACK_PERSON_MAP_JSON) return undefined;
  return createSlackActorIdentityResolver({ personMapJson: env.BRAINBASE_SLACK_PERSON_MAP_JSON });
}
