/**
 * Read-only Brainbase Graph SSOT client — person entities only.
 *
 * Used by the meeting-task flow to (a) resolve an assignee name written in
 * meeting minutes to a canonical person id via names/aliases and (b) populate
 * the assignee select in the Slack edit modal. Graph is the source of truth
 * for people; minutes text is only a hint.
 *
 * Configuration (environment):
 *   BRAINBASE_GRAPH_API_BASE_URL  falls back to BRAINBASE_TASK_API_BASE_URL
 *   BRAINBASE_GRAPH_API_TOKEN     bearer token (bbsvc_ service token with
 *                                 project scope; the task-API token has no
 *                                 project scope and cannot read the Graph)
 *
 * All lookups fail open: an unreachable Graph means "no assignee resolution",
 * never a broken proposal flow.
 */

import { logger } from "./logger.js";

export interface GraphPerson {
  id: string;
  name: string;
  aliases: string[];
}

interface GraphEntityRecord {
  id: string;
  payload?: { name?: unknown; aliases?: unknown; status?: unknown };
}

export function isBrainbaseGraphConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    (env.BRAINBASE_GRAPH_API_BASE_URL || env.BRAINBASE_TASK_API_BASE_URL) &&
      env.BRAINBASE_GRAPH_API_TOKEN,
  );
}

const CACHE_TTL_MS = 300_000;

export class GraphPeopleClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { people: GraphPerson[]; fetchedAt: number } | null = null;

  constructor(options: { baseUrl?: string; token?: string; fetchImpl?: typeof fetch } = {}) {
    const baseUrl =
      options.baseUrl ??
      process.env.BRAINBASE_GRAPH_API_BASE_URL ??
      process.env.BRAINBASE_TASK_API_BASE_URL ??
      "";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = options.token ?? process.env.BRAINBASE_GRAPH_API_TOKEN ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Lists person entities (name + aliases). Cached for 5 minutes. Returns []
   * on any failure — callers must treat an empty list as "Graph unavailable",
   * not "no people exist".
   */
  async listPeople(now: number = Date.now()): Promise<GraphPerson[]> {
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.people;
    }
    if (!this.baseUrl || !this.token) return [];
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/api/info/graph/entities?type=person&limit=500`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) {
        logger.warn(`[brainbase-graph] person list failed: ${res.status}`);
        return [];
      }
      const body = (await res.json()) as { records?: GraphEntityRecord[] };
      const people: GraphPerson[] = [];
      for (const record of body.records ?? []) {
        const name = typeof record.payload?.name === "string" ? record.payload.name.trim() : "";
        if (!record.id || !name) continue;
        const aliases = Array.isArray(record.payload?.aliases)
          ? record.payload.aliases.filter((a): a is string => typeof a === "string")
          : [];
        people.push({ id: record.id, name, aliases });
      }
      this.cache = { people, fetchedAt: now };
      return people;
    } catch (err) {
      logger.warn(`[brainbase-graph] person list failed: ${err}`);
      return [];
    }
  }
}

/** Strips spaces (half/full width) so "佐藤 圭吾" matches "佐藤圭吾". */
function normalizeName(value: string): string {
  return value.replace(/[\s　]+/g, "").toLowerCase();
}

/**
 * Resolves a name as written in minutes to a Graph person via exact
 * name/alias match (whitespace-insensitive). Ambiguous or missing matches
 * return null — a wrong assignee on a canonical task is worse than none.
 */
export function resolvePersonByName(people: GraphPerson[], rawName: string): GraphPerson | null {
  const needle = normalizeName(rawName);
  if (!needle) return null;
  const matches = people.filter((person) =>
    [person.name, ...person.aliases].some((candidate) => normalizeName(candidate) === needle),
  );
  return matches.length === 1 ? matches[0] : null;
}
