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

export interface BrainbaseContextQuery {
  project?: string;
  workspace?: string;
  channelId?: string;
  sessionId?: string;
}

export type BrainbaseContextHydration =
  | {
      status: "available";
      content: string;
      revision?: string;
      observedAt: string;
    }
  | {
      status: "empty";
      content: "";
      revision?: string;
      observedAt: string;
    }
  | {
      status: "unavailable";
      content: "";
      reasonCode: string;
      observedAt: string;
    };

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

/**
 * Per-turn Brainbase Graph context hydration.
 *
 * Unlike entity lists, context is intentionally never cached: a new turn must
 * observe the current Graph revision. Failures are represented explicitly so
 * callers cannot mistake an unreachable Graph for a Graph with no context.
 */
export class BrainbaseContextClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

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

  async hydrate(query: BrainbaseContextQuery): Promise<BrainbaseContextHydration> {
    const observedAt = new Date().toISOString();
    if (!this.baseUrl || !this.token) {
      return { status: "unavailable", content: "", reasonCode: "not_configured", observedAt };
    }

    try {
      const url = new URL(`${this.baseUrl}/api/info/context`);
      url.searchParams.set(
        "project",
        query.project?.trim() || process.env.BRAINBASE_CONTEXT_PROJECT_CODE?.trim() || "brainbase",
      );
      url.searchParams.set("humanReadable", "true");
      url.searchParams.set("includeEdges", "true");
      url.searchParams.set("includePhilosophy", "true");
      url.searchParams.set("includeMemory", "true");
      url.searchParams.set("scope", "graph");
      if (query.workspace) url.searchParams.set("workspace", query.workspace);
      if (query.channelId) url.searchParams.set("channelId", query.channelId);
      if (query.sessionId) url.searchParams.set("sessionId", query.sessionId);

      const response = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) {
        logger.warn(`[brainbase-graph] context hydration failed: ${response.status}`);
        return {
          status: "unavailable",
          content: "",
          reasonCode: `http_${response.status}`,
          observedAt,
        };
      }

      const body = (await response.json()) as {
        report?: unknown;
        meta?: { timestamp?: unknown; revision?: unknown };
        philosophy_context?: { prompt_block?: unknown };
        scoped_memory?: unknown;
      };
      const revision = typeof body.meta?.revision === "string"
        ? body.meta.revision
        : typeof body.meta?.timestamp === "string"
          ? body.meta.timestamp
          : undefined;
      const blocks: string[] = [];
      if (typeof body.philosophy_context?.prompt_block === "string") {
        const philosophy = body.philosophy_context.prompt_block.trim();
        if (philosophy) blocks.push(philosophy);
      }
      if (body.report && typeof body.report === "object") {
        blocks.push(`Graph report:\n${JSON.stringify(body.report, null, 2)}`);
      } else if (typeof body.report === "string" && body.report.trim()) {
        blocks.push(body.report.trim());
      }
      if (body.scoped_memory && typeof body.scoped_memory === "object") {
        blocks.push(`Scoped promoted memory:\n${JSON.stringify(body.scoped_memory, null, 2)}`);
      }
      const content = blocks.join("\n\n").trim();
      if (!content) return { status: "empty", content: "", revision, observedAt };
      return { status: "available", content, revision, observedAt };
    } catch (error) {
      logger.warn(`[brainbase-graph] context hydration failed: ${error}`);
      return { status: "unavailable", content: "", reasonCode: "request_failed", observedAt };
    }
  }
}

/** Any Graph entity reduced to what the meeting flows need. */
export interface GraphEntity {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * Generic read-only entity client with a per-type 5-minute cache. All lookups
 * fail open (return []) — Graph being unreachable must never break a flow.
 */
export class GraphEntityClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { entities: GraphEntity[]; fetchedAt: number }>();

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
   * Lists entities of one type (name + aliases). Cached for 5 minutes per
   * type. Returns [] on any failure — callers must treat an empty list as
   * "Graph unavailable", not "no entities exist".
   */
  async listEntities(type: string, now: number = Date.now()): Promise<GraphEntity[]> {
    const cached = this.cache.get(type);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.entities;
    }
    if (!this.baseUrl || !this.token) return [];
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/api/info/graph/entities?type=${encodeURIComponent(type)}&limit=500`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) {
        logger.warn(`[brainbase-graph] ${type} list failed: ${res.status}`);
        return [];
      }
      const body = (await res.json()) as { records?: GraphEntityRecord[] };
      const entities: GraphEntity[] = [];
      for (const record of body.records ?? []) {
        const name = typeof record.payload?.name === "string" ? record.payload.name.trim() : "";
        if (!record.id || !name) continue;
        const aliases = Array.isArray(record.payload?.aliases)
          ? record.payload.aliases.filter((a): a is string => typeof a === "string")
          : [];
        entities.push({ id: record.id, name, aliases });
      }
      this.cache.set(type, { entities, fetchedAt: now });
      return entities;
    } catch (err) {
      logger.warn(`[brainbase-graph] ${type} list failed: ${err}`);
      return [];
    }
  }
}

export class GraphPeopleClient extends GraphEntityClient {
  /**
   * Lists person entities (name + aliases). Cached for 5 minutes. Returns []
   * on any failure — callers must treat an empty list as "Graph unavailable",
   * not "no people exist".
   */
  async listPeople(now: number = Date.now()): Promise<GraphPerson[]> {
    return this.listEntities("person", now);
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
