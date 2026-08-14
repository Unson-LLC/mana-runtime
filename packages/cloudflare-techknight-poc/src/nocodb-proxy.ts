export const NOCODB_PROXY_HOST = "nocodb.internal";
export const NOCODB_PROXY_PATH = "/api/runtime/nocodb";

export interface NocodbProxyEnv {
  NOCODB_URL?: string;
  NOCODB_TOKEN?: string;
  NOCODB_PROJECT_MAPPING_JSON?: string;
}

const TOOLS = new Set([
  "nocodb_list_bases", "nocodb_list_tables",
  "nocodb_list_records", "nocodb_get_record", "nocodb_create_record", "nocodb_update_record",
  "nocodb_delete_record", "nocodb_get_table_meta", "nocodb_update_column",
]);

function clean(value: unknown, max = 160): string {
  if (typeof value !== "string") throw new Error("invalid_arguments");
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f/]/.test(result)) throw new Error("invalid_arguments");
  return result;
}

function projectMapping(raw?: string): Record<string, string> {
  if (!raw) throw new Error("nocodb_not_configured");
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("nocodb_not_configured");
  return value as Record<string, string>;
}

function dataPath(args: Record<string, unknown>, mapping: Record<string, string>, record = false): string {
  const baseId = clean(args.baseId);
  const projectId = mapping[baseId];
  if (!projectId) throw new Error("nocodb_base_not_allowed");
  const table = encodeURIComponent(clean(args.tableName));
  return `/api/v1/db/data/noco/${encodeURIComponent(projectId)}/${table}${record ? `/${encodeURIComponent(clean(args.recordId))}` : ""}`;
}

function mappedProjectId(args: Record<string, unknown>, mapping: Record<string, string>): string {
  const projectId = mapping[clean(args.baseId)];
  if (!projectId) throw new Error("nocodb_base_not_allowed");
  return projectId;
}

function targetFor(tool: string, args: Record<string, unknown>, mapping: Record<string, string>): { method: string; path: string; body?: unknown } {
  if (tool === "nocodb_list_tables") {
    return { method: "GET", path: `/api/v2/meta/bases/${encodeURIComponent(mappedProjectId(args, mapping))}/tables` };
  }
  if (tool === "nocodb_list_records") {
    const params = new URLSearchParams();
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("invalid_arguments");
    params.set("limit", String(limit)); params.set("offset", String(offset));
    for (const key of ["where", "sort"] as const) if (args[key] !== undefined) params.set(key, clean(args[key], 1000));
    if (args.fields !== undefined) {
      if (!Array.isArray(args.fields) || args.fields.some((field) => typeof field !== "string")) throw new Error("invalid_arguments");
      params.set("fields", args.fields.map((field) => clean(field)).join(","));
    }
    return { method: "GET", path: `${dataPath(args, mapping)}?${params}` };
  }
  if (tool === "nocodb_get_record") return { method: "GET", path: dataPath(args, mapping, true) };
  if (tool === "nocodb_create_record") return { method: "POST", path: dataPath(args, mapping), body: args.fields };
  if (tool === "nocodb_update_record") return { method: "PATCH", path: dataPath(args, mapping, true), body: args.fields };
  if (tool === "nocodb_delete_record") return { method: "DELETE", path: dataPath(args, mapping, true) };
  if (tool === "nocodb_get_table_meta") return { method: "GET", path: `/api/v2/meta/tables/${encodeURIComponent(clean(args.tableId))}` };
  return { method: "PATCH", path: `/api/v2/meta/columns/${encodeURIComponent(clean(args.columnId))}`, body: { colOptions: args.colOptions } };
}

export async function handleNocodbProxyRequest(request: Request, env: NocodbProxyEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== NOCODB_PROXY_HOST || url.pathname !== NOCODB_PROXY_PATH || request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
  if (!env.NOCODB_URL || !env.NOCODB_TOKEN) return Response.json({ error: "nocodb_not_configured" }, { status: 503 });
  try {
    const input = await request.json() as { tool?: unknown; arguments?: unknown };
    if (typeof input.tool !== "string" || !TOOLS.has(input.tool) || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new Error("invalid_arguments");
    const mapping = projectMapping(env.NOCODB_PROJECT_MAPPING_JSON);
    if (input.tool === "nocodb_list_bases") {
      return Response.json({ bases: Object.keys(mapping).sort().map((baseId) => ({ baseId })) });
    }
    const target = targetFor(input.tool, input.arguments as Record<string, unknown>, mapping);
    const upstream = await fetchImpl(`${env.NOCODB_URL.replace(/\/$/, "")}${target.path}`, {
      method: target.method,
      headers: { "xc-token": env.NOCODB_TOKEN, "content-type": "application/json" },
      ...(target.body !== undefined ? { body: JSON.stringify(target.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_arguments";
    return Response.json({ error: code }, { status: code === "nocodb_base_not_allowed" ? 403 : 400 });
  }
}
