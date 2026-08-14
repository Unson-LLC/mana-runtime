import type { SlackQueueEvent } from "./types.js";

export type GraphRequesterResolution =
  | { status: "resolved"; personId: string; personName?: string }
  | { status: "not_found" | "ambiguous" | "unavailable" };

export type GraphContextHydration =
  | { status: "available"; content: string; revision?: string }
  | { status: "empty"; content: ""; revision?: string }
  | { status: "unavailable"; content: ""; reason: string };

export interface BrainbaseGraphRuntimeOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

function configured(options: BrainbaseGraphRuntimeOptions): options is BrainbaseGraphRuntimeOptions & { baseUrl: string; token: string } {
  return Boolean(options.baseUrl?.trim() && options.token?.trim());
}

async function graphGet(url: URL, options: BrainbaseGraphRuntimeOptions): Promise<Response | undefined> {
  if (!configured(options)) return undefined;
  try {
    return await (options.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return undefined;
  }
}

export async function resolveGraphRequester(
  workspaceId: string,
  slackUserId: string,
  options: BrainbaseGraphRuntimeOptions,
): Promise<GraphRequesterResolution> {
  if (!configured(options)) return { status: "unavailable" };
  const url = new URL("/api/info/person/by-slack", options.baseUrl);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("slackUserId", slackUserId);
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
