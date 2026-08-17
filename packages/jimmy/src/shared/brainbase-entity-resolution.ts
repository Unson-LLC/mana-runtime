/**
 * Meeting-facing adapter for Brainbase's shared canonical entity resolver.
 *
 * The hosted Graph API is snapshotted into the OSS Graph v2 contract and is
 * then resolved by @unson/brainbase-mcp. This module deliberately contains no
 * alias scoring or ambiguity logic of its own: those rules belong to the
 * shared Brainbase resolver and its portable Receipt contract.
 */

import { createHash } from "node:crypto";
import {
  resolveText as resolveBrainbaseText,
  type ResolutionReceiptV1,
  type SourceStatus,
} from "@unson/brainbase-mcp/dist/entity-resolution.js";
import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalEntityKind,
  CoreRelation,
  GraphFileV2,
} from "@unson/brainbase-mcp/dist/types.js";
import type { GraphEntity } from "./brainbase-graph.js";
import { logger } from "./logger.js";

const ENTITY_TYPES = ["person", "org", "project", "decision"] as const;
const ONTOLOGY_VERSION = "hosted-graph-adapter.v1";

interface HostedGraphRecord {
  id?: unknown;
  entity_type?: unknown;
  project_id?: unknown;
  project_code?: unknown;
  member_of_project_ids?: unknown;
  payload?: Record<string, unknown>;
}

interface FetchResult {
  type: CanonicalEntityKind;
  ok: boolean;
  status?: number;
  revision?: string;
  records: HostedGraphRecord[];
}

export interface MeetingEntityResolution {
  receipt: ResolutionReceiptV1;
  /** Only entities actually resolved in this transcript. */
  properNouns: GraphEntity[];
  /** Project-scoped durable decisions from the same trusted snapshot. */
  decisions: string[];
}

export interface BrainbaseEntityResolver {
  resolve(
    text: string,
    options: { projectId: string; asOf: string },
  ): Promise<MeetingEntityResolution>;
}

export class BrainbaseEntityResolverClient implements BrainbaseEntityResolver {
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

  async resolve(
    text: string,
    options: { projectId: string; asOf: string },
  ): Promise<MeetingEntityResolution> {
    if (!this.baseUrl || !this.token) {
      return blockedResolution(text, options, "unavailable", ["not_configured"]);
    }

    const fetched = await Promise.all(
      ENTITY_TYPES.map((type) => this.fetchType(type, options.projectId)),
    );
    const succeeded = fetched.filter((result) => result.ok);
    const failed = fetched.filter((result) => !result.ok);
    if (succeeded.length === 0) {
      const statuses = [...new Set(failed.map((result) => result.status).filter(Boolean))];
      const issueCodes = statuses.length === 1
        ? [`http_${statuses[0]}`]
        : failed.map((result) => `${result.type}_http_${result.status ?? "request_failed"}`);
      return blockedResolution(text, options, "unavailable", issueCodes);
    }

    const sourceStatus: SourceStatus = failed.length === 0 ? "complete" : "partial";
    const issueCodes = failed.map(
      (result) => `${result.type}_http_${result.status ?? "request_failed"}`,
    );
    const snapshot = buildCanonicalSnapshot(fetched, options.projectId);
    if (!snapshot.graph.entities.some((entity) => entity.id === options.projectId && entity.type === "project")) {
      return blockedResolution(text, options, "invalid", [
        ...issueCodes,
        "project_scope_entity_missing",
      ]);
    }

    const resolved = resolveBrainbaseText({
      text,
      projectScope: { projectIds: [options.projectId], policy: "strict" },
      asOf: options.asOf,
      entityTypes: [...ENTITY_TYPES],
      source: {
        authority: "local_graph",
        status: sourceStatus,
        revision: snapshot.revision,
        issues: issueCodes.map((code) => ({ code, message: code })),
        graph: snapshot.graph,
      },
    });
    const entitiesById = new Map(snapshot.graph.entities.map((entity) => [entity.id, entity]));
    const properNouns = resolved.mentions
      .filter((mention) => mention.status === "resolved" && mention.selectedEntityId)
      .map((mention) => {
        const entity = entitiesById.get(mention.selectedEntityId!);
        if (!entity || !mention.surface || normalize(mention.surface) === normalize(entity.name)) return null;
        return { id: entity.id, name: entity.name, aliases: [mention.surface] } satisfies GraphEntity;
      })
      .filter((entity): entity is GraphEntity => entity !== null);

    return {
      receipt: resolved.receipt,
      properNouns: dedupeGraphEntities(properNouns),
      decisions: snapshot.graph.entities
        .filter((entity) => entity.type === "decision")
        .filter((entity) => snapshot.projectScopedEntityIds.has(entity.id))
        .map((entity) => entity.name)
        .slice(0, 10),
    };
  }

  private async fetchType(type: CanonicalEntityKind, projectId: string): Promise<FetchResult> {
    try {
      const url = new URL(`${this.baseUrl}/api/info/graph/entities`);
      url.searchParams.set("type", type);
      url.searchParams.set("project", projectId);
      url.searchParams.set("limit", "500");
      const response = await this.fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) {
        logger.warn(`[brainbase-resolution] code=entity_fetch_failed type=${type} status=${response.status}`);
        return { type, ok: false, status: response.status, records: [] };
      }
      const body = (await response.json()) as { records?: unknown };
      return {
        type,
        ok: true,
        revision: response.headers?.get("etag") ?? undefined,
        records: Array.isArray(body.records) ? body.records as HostedGraphRecord[] : [],
      };
    } catch {
      logger.warn(`[brainbase-resolution] code=entity_fetch_failed type=${type} status=request_failed`);
      return { type, ok: false, records: [] };
    }
  }
}

function blockedResolution(
  text: string,
  options: { projectId: string; asOf: string },
  status: "unavailable" | "invalid",
  issueCodes: string[],
): MeetingEntityResolution {
  const { receipt } = resolveBrainbaseText({
    text,
    projectScope: { projectIds: [options.projectId], policy: "strict" },
    asOf: options.asOf,
    entityTypes: [...ENTITY_TYPES],
    source: {
      authority: "local_graph",
      status,
      issues: [...new Set(issueCodes)].sort().map((code) => ({ code, message: code })),
    },
  });
  return { receipt, properNouns: [], decisions: [] };
}

function buildCanonicalSnapshot(
  fetched: FetchResult[],
  requestedProjectId: string,
): { graph: GraphFileV2; revision: string; projectScopedEntityIds: Set<string> } {
  const entities: CanonicalEntity[] = [];
  const rawById = new Map<string, HostedGraphRecord>();
  for (const result of fetched.filter((item) => item.ok)) {
    for (const record of result.records) {
      const id = stringValue(record.id);
      const name = stringValue(record.payload?.name) || stringValue(record.payload?.title);
      if (!id || !name) continue;
      const aliases = stringArray(record.payload?.aliases);
      entities.push({ id, type: result.type, name, ...(aliases.length > 0 ? { aliases } : {}) });
      rawById.set(id, record);
    }
  }
  const dedupedEntities = [...new Map(entities.map((entity) => [entity.id, entity])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const entityIds = new Set(dedupedEntities.map((entity) => entity.id));
  const projectScopedEntityIds = new Set<string>();
  const edges: CanonicalEdge[] = [];

  for (const entity of dedupedEntities) {
    if (entity.type === "project") {
      if (entity.id === requestedProjectId) projectScopedEntityIds.add(entity.id);
      continue;
    }
    const record = rawById.get(entity.id);
    const projectIds = new Set([
      ...stringArray(record?.member_of_project_ids),
      ...stringArray(record?.payload?.member_of_project_ids),
      stringValue(record?.project_id),
      stringValue(record?.payload?.project_id),
    ].filter(Boolean));
    for (const projectId of projectIds) {
      if (!entityIds.has(projectId)) continue;
      const relation: CoreRelation = entity.type === "person"
        ? "participates_in"
        : entity.type === "decision"
          ? "governs"
          : "owned_by";
      const tuple = entity.type === "org"
        ? { fromId: projectId, relation, toId: entity.id }
        : { fromId: entity.id, relation, toId: projectId };
      edges.push({ id: canonicalEdgeId(tuple), ...tuple, provenance: { sourceKind: "import" } });
      if (projectId === requestedProjectId) projectScopedEntityIds.add(entity.id);
    }
  }

  const revision = sha256(stableJson(fetched.map((item) => ({
    type: item.type,
    ok: item.ok,
    status: item.status,
    revision: item.revision,
    records: item.records,
  }))));
  const graph: GraphFileV2 = {
    version: 2,
    ontology: {
      id: "brainbase-personal-os",
      version: ONTOLOGY_VERSION,
      releaseDigest: sha256(ONTOLOGY_VERSION),
    },
    entities: dedupedEntities,
    edges: [...new Map(edges.map((edge) => [edge.id, edge])).values()]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return { graph, revision, projectScopedEntityIds };
}

function canonicalEdgeId(edge: { fromId: string; relation: string; toId: string }): string {
  return `edge-${sha256(JSON.stringify([edge.fromId, edge.relation, edge.toId])).slice(0, 24)}`;
}

function dedupeGraphEntities(entities: GraphEntity[]): GraphEntity[] {
  const byId = new Map<string, GraphEntity>();
  for (const entity of entities) {
    const current = byId.get(entity.id);
    byId.set(entity.id, {
      ...entity,
      aliases: [...new Set([...(current?.aliases ?? []), ...entity.aliases])],
    });
  }
  return [...byId.values()];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").replace(/\s+/gu, " ").trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type { ResolutionReceiptV1 };
