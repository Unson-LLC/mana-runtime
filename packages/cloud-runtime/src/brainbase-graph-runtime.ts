import type { SlackQueueEvent } from "./types.js";

export type GraphRequesterResolution =
  | { status: "resolved"; personId: string; personName?: string }
  | { status: "not_found" | "ambiguous" | "unavailable" };

export type GraphPersonNameResolution =
  | { status: "resolved"; personId: string }
  | { status: "unknown" | "ambiguous" | "unavailable" };

export type GraphContextHydration =
  | { status: "available"; content: string; revision?: string }
  | { status: "empty"; content: ""; revision?: string }
  | { status: "unavailable"; content: ""; reason: string };

export interface BrainbaseGraphRuntimeOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface GraphPersonOption { id: string; name: string; aliases: string[] }

interface GraphPersonRecord {
  id: string;
  name: string;
  aliases: string[];
  status?: string;
  entityType?: string;
  canonicalEntityId?: string;
}

function parseGraphPersonRecord(item: unknown): GraphPersonRecord | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as {
    id?: unknown;
    entity_type?: unknown;
    status?: unknown;
    canonical_entity_id?: unknown;
    payload?: {
      name?: unknown;
      aliases?: unknown;
      status?: unknown;
      canonical_entity_id?: unknown;
    };
  };
  if (typeof record.id !== "string" || typeof record.payload?.name !== "string") return undefined;
  const aliases = Array.isArray(record.payload.aliases)
    ? record.payload.aliases.filter((alias): alias is string => typeof alias === "string") : [];
  const status = typeof record.payload.status === "string" ? record.payload.status
    : typeof record.status === "string" ? record.status : undefined;
  const canonicalEntityId = typeof record.payload.canonical_entity_id === "string"
    ? record.payload.canonical_entity_id.trim() || undefined
    : typeof record.canonical_entity_id === "string" ? record.canonical_entity_id.trim() || undefined : undefined;
  return {
    id: record.id,
    name: record.payload.name,
    aliases,
    ...(status ? { status } : {}),
    ...(typeof record.entity_type === "string" ? { entityType: record.entity_type } : {}),
    ...(canonicalEntityId ? { canonicalEntityId } : {}),
  };
}

function canonicalGraphPersonId(record: GraphPersonRecord): string | undefined {
  const isMerged = record.status === "merged" || record.entityType === "person_alias";
  if (isMerged) return record.canonicalEntityId;
  return record.id;
}

export async function listGraphPeople(projectCode: string | undefined, options: BrainbaseGraphRuntimeOptions): Promise<GraphPersonOption[] | undefined> {
  if (!configured(options)) return undefined;
  const url = new URL("/api/info/graph/entities", options.baseUrl);
  url.searchParams.set("type", "person"); url.searchParams.set("limit", "500");
  url.searchParams.set("includeMerged", "true");
  if (projectCode?.trim()) url.searchParams.set("project", projectCode.trim());
  const response = await graphGet(url, options);
  if (!response?.ok) return undefined;
  let body: unknown; try { body = await response.json(); } catch { return undefined; }
  const records = body && typeof body === "object" && Array.isArray((body as { records?: unknown }).records)
    ? (body as { records: unknown[] }).records : undefined;
  if (!records || records.length >= 500) return undefined;
  const people = new Map<string, { person: GraphPersonOption; merged: boolean }>();
  for (const item of records) {
    const record = parseGraphPersonRecord(item);
    if (!record) continue;
    const id = canonicalGraphPersonId(record);
    if (!id) continue;
    const merged = record.status === "merged" || record.entityType === "person_alias";
    const person = { id, name: record.name, aliases: record.aliases };
    const existing = people.get(id);
    if (!existing || (existing.merged && !merged)) people.set(id, { person, merged });
  }
  return [...people.values()].map(({ person }) => person);
}

function configured(options: BrainbaseGraphRuntimeOptions): options is BrainbaseGraphRuntimeOptions & { baseUrl: string } {
  return Boolean(options.baseUrl?.trim() && (options.token?.trim() || options.fetch));
}

async function graphGet(url: URL, options: BrainbaseGraphRuntimeOptions): Promise<Response | undefined> {
  if (!configured(options)) return undefined;
  try {
    return await (options.fetch ?? fetch)(url, {
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return undefined;
  }
}

export async function resolveGraphRequester(
  workspaceId: string,
  slackUserId: string,
  projectCode: string,
  options: BrainbaseGraphRuntimeOptions,
): Promise<GraphRequesterResolution> {
  if (!configured(options)) return { status: "unavailable" };
  const url = new URL("/api/info/person/by-slack", options.baseUrl);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("slackUserId", slackUserId);
  url.searchParams.set("project", projectCode);
  const response = await graphGet(url, options);
  if (!response) return { status: "unavailable" };
  if (response.status === 404) return { status: "not_found" };
  if (response.status === 409) return { status: "ambiguous" };
  if (!response.ok) return { status: "unavailable" };
  let body: unknown;
  try { body = await response.json(); } catch { return { status: "unavailable" }; }
  if (typeof body !== "object" || body === null) return { status: "unavailable" };
  const record = body as { person?: { id?: unknown; name?: unknown }; id?: unknown; name?: unknown };
  const id = typeof record.person?.id === "string" ? record.person.id : typeof record.id === "string" ? record.id : undefined;
  const name = typeof record.person?.name === "string" ? record.person.name : typeof record.name === "string" ? record.name : undefined;
  if (!id?.trim()) return { status: "unavailable" };
  return { status: "resolved", personId: id.trim(), ...(name?.trim() ? { personName: name.trim() } : {}) };
}

function normalizedPersonName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s　]+/g, "")
    .replace(/(?:さん|さま|様|氏)$/u, "");
}

export async function resolveGraphPersonByName(
  name: string,
  projectCode: string | undefined,
  options: BrainbaseGraphRuntimeOptions,
): Promise<GraphPersonNameResolution> {
  if (!configured(options) || !name.trim()) return { status: "unavailable" };
  const url = new URL("/api/info/graph/entities", options.baseUrl);
  url.searchParams.set("type", "person");
  url.searchParams.set("limit", "500");
  url.searchParams.set("includeMerged", "true");
  if (projectCode?.trim()) url.searchParams.set("project", projectCode.trim());
  const response = await graphGet(url, options);
  if (!response?.ok) return { status: "unavailable" };
  let body: unknown;
  try { body = await response.json(); } catch { return { status: "unavailable" }; }
  const records = body && typeof body === "object" && Array.isArray((body as { records?: unknown }).records)
    ? (body as { records: unknown[] }).records : undefined;
  if (!records || records.length >= 500) return { status: "unavailable" };
  const target = normalizedPersonName(name);
  const matches = records.flatMap((item) => {
    const record = parseGraphPersonRecord(item);
    const id = record && canonicalGraphPersonId(record);
    return record && id && [record.name, ...record.aliases].some((candidate) => normalizedPersonName(candidate) === target)
      ? [id] : [];
  });
  const unique = [...new Set(matches)];
  if (unique.length === 0) return { status: "unknown" };
  if (unique.length > 1) return { status: "ambiguous" };
  return { status: "resolved", personId: unique[0]! };
}

export async function hydrateGraphContext(
  event: SlackQueueEvent,
  projectCode: string,
  options: BrainbaseGraphRuntimeOptions,
): Promise<GraphContextHydration> {
  if (!configured(options)) return { status: "unavailable", content: "", reason: "not_configured" };
  const url = new URL("/api/info/context", options.baseUrl);
  for (const [key, value] of Object.entries({ project: projectCode, workspace: event.workspaceId,
    channelId: event.channelId, sessionId: event.threadTs })) url.searchParams.set(key, value);
  url.searchParams.set("humanReadable", "true");
  url.searchParams.set("includeEdges", "true");
  url.searchParams.set("includePhilosophy", "true");
  url.searchParams.set("includeMemory", "true");
  url.searchParams.set("scope", "graph");
  const response = await graphGet(url, options);
  if (!response) return { status: "unavailable", content: "", reason: "request_failed" };
  if (!response.ok) return { status: "unavailable", content: "", reason: `http_${response.status}` };
  let body: unknown;
  try { body = await response.json(); } catch { return { status: "unavailable", content: "", reason: "invalid_json" }; }
  if (typeof body !== "object" || body === null) return { status: "unavailable", content: "", reason: "invalid_json" };
  const value = body as { report?: unknown; philosophy_context?: { prompt_block?: unknown }; scoped_memory?: unknown; meta?: { revision?: unknown; timestamp?: unknown } };
  const blocks: string[] = [];
  if (typeof value.philosophy_context?.prompt_block === "string" && value.philosophy_context.prompt_block.trim()) blocks.push(value.philosophy_context.prompt_block.trim());
  if (typeof value.report === "string" && value.report.trim()) blocks.push(value.report.trim());
  else if (value.report && typeof value.report === "object") blocks.push(`Graph report:\n${JSON.stringify(value.report)}`);
  if (value.scoped_memory && typeof value.scoped_memory === "object") blocks.push(`Scoped promoted memory:\n${JSON.stringify(value.scoped_memory)}`);
  const revision = typeof value.meta?.revision === "string" ? value.meta.revision : typeof value.meta?.timestamp === "string" ? value.meta.timestamp : undefined;
  const content = blocks.join("\n\n").slice(0, 30_000);
  return content ? { status: "available", content, ...(revision ? { revision } : {}) }
    : { status: "empty", content: "", ...(revision ? { revision } : {}) };
}
