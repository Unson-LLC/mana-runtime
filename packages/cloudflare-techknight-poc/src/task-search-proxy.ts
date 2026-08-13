import { parseRuntimeProjectCodes } from "./runtime-config.js";

export const TASK_SEARCH_PROXY_HOST = "task-search.internal";
export const TASK_SEARCH_PATH = "/api/companion/tasks/search";

const MAX_RESPONSE_BYTES = 262_144;
const ALLOWED_QUERY_KEYS = new Set([
  "query",
  "status",
  "priority",
  "assignee_person_id",
  "cursor",
  "limit",
]);
const STATUS_VALUES = new Set(["pending", "in_progress", "waiting", "completed"]);
const PRIORITY_VALUES = new Set(["low", "medium", "high", "urgent"]);

export interface TaskSearchProxyEnv {
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  RUNTIME_PROJECT_CODES?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function singleParam(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new Error("duplicate_parameter");
  return values[0];
}

function boundedText(
  params: URLSearchParams,
  key: string,
  options: { required?: boolean; min?: number; max: number },
): string | undefined {
  const value = singleParam(params, key);
  if (value === undefined) {
    if (options.required) throw new Error("missing_parameter");
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length < (options.min ?? 0) ||
    normalized.length > options.max ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error("invalid_parameter");
  }
  return normalized;
}

function parseLimit(params: URLSearchParams): string {
  const value = singleParam(params, "limit");
  if (value === undefined) return "20";
  if (!/^(?:[1-9]|1\d|20)$/.test(value)) throw new Error("invalid_limit");
  return value;
}

function resolveUpstreamOrigin(value: string | undefined): string {
  if (!value) throw new Error("task_search_not_configured");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("task_search_not_configured");
  }
  return url.origin;
}

function validateRequest(request: Request): URLSearchParams {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== TASK_SEARCH_PROXY_HOST ||
    url.port ||
    url.pathname !== TASK_SEARCH_PATH
  ) {
    throw new Error("not_found");
  }
  if (request.method !== "GET") throw new Error("method_not_allowed");
  if (request.body !== null) throw new Error("request_body_not_allowed");
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new Error("unknown_parameter");
  }

  const query = boundedText(url.searchParams, "query", { required: true, min: 1, max: 200 });
  const status = boundedText(url.searchParams, "status", { max: 32 });
  const priority = boundedText(url.searchParams, "priority", { max: 16 });
  const assignee = boundedText(url.searchParams, "assignee_person_id", { max: 128 });
  const cursor = boundedText(url.searchParams, "cursor", { max: 1024 });
  const limit = parseLimit(url.searchParams);
  if (status && !STATUS_VALUES.has(status)) throw new Error("invalid_status");
  if (priority && !PRIORITY_VALUES.has(priority)) throw new Error("invalid_priority");

  const result = new URLSearchParams({ query: query!, limit });
  if (status) result.set("status", status);
  if (priority) result.set("priority", priority);
  if (assignee) result.set("assignee_person_id", assignee);
  if (cursor) result.set("cursor", cursor);
  return result;
}

function optionalBoundedString(
  value: unknown,
  max: number,
  options: { nullable?: boolean } = {},
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid_upstream_response");
  }
  return value;
}

function sanitizePage(payload: unknown, allowedProjects: ReadonlySet<string>): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("invalid_upstream_response");
  }
  const page = payload as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.has_more !== "boolean") {
    throw new Error("invalid_upstream_response");
  }
  if (page.items.length > 20) throw new Error("invalid_upstream_response");
  const nextCursor = optionalBoundedString(page.next_cursor, 1024, { nullable: true });
  const readStatus = optionalBoundedString(page.read_status, 32);
  const items = page.items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("invalid_upstream_response");
    }
    const task = item as Record<string, unknown>;
    if (!Array.isArray(task.project_codes)) throw new Error("task_search_scope_violation");
    const projects = task.project_codes.filter(
      (code): code is string => typeof code === "string" && allowedProjects.has(code),
    );
    if (projects.length === 0) throw new Error("task_search_scope_violation");

    const id = optionalBoundedString(task.id, 200);
    const title = optionalBoundedString(task.title, 500);
    const status = optionalBoundedString(task.status, 32);
    const priority = optionalBoundedString(task.priority, 16);
    if (!id || !title || !status || !priority) throw new Error("invalid_upstream_response");
    const assigneePersonId = optionalBoundedString(task.assignee_person_id, 128, { nullable: true });
    const assigneeDisplayName = optionalBoundedString(task.assignee_display_name, 200, { nullable: true });
    const dueAt = optionalBoundedString(task.due_at, 64, { nullable: true });
    return {
      id,
      title,
      status,
      priority,
      project_codes: projects,
      ...(assigneePersonId !== undefined ? { assignee_person_id: assigneePersonId } : {}),
      ...(assigneeDisplayName !== undefined ? { assignee_display_name: assigneeDisplayName } : {}),
      ...(dueAt !== undefined ? { due_at: dueAt } : {}),
    };
  });
  return {
    untrusted_data: true,
    items,
    total_count: page.total_count === null ? null : undefined,
    count_status: page.count_status === "not_requested" ? "not_requested" : undefined,
    has_more: page.has_more,
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    ...(readStatus !== undefined ? { read_status: readStatus } : {}),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("invalid_upstream_response");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("task_search_response_too_large");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("task_search_response_too_large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("invalid_upstream_response");
  }
}

export function createTaskSearchProxyHandler(fetchImpl: FetchLike = fetch) {
  return async (request: Request, env: TaskSearchProxyEnv): Promise<Response> => {
    if (env.RUNTIME_TASK_SEARCH_ENABLED !== "true") {
      return jsonError("task_search_disabled", 503);
    }

    let params: URLSearchParams;
    try {
      params = validateRequest(request);
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      if (code === "not_found") return jsonError(code, 404);
      if (code === "method_not_allowed") return jsonError(code, 405);
      return jsonError("task_search_invalid_request", 400);
    }

    let projectCodes: string[];
    let upstreamOrigin: string;
    try {
      projectCodes = parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES);
      if (projectCodes.length === 0 || !env.BRAINBASE_TASK_API_TOKEN) {
        throw new Error("task_search_not_configured");
      }
      upstreamOrigin = resolveUpstreamOrigin(env.BRAINBASE_TASK_API_BASE_URL);
    } catch {
      return jsonError("task_search_not_configured", 503);
    }
    for (const projectCode of projectCodes) params.append("project_code", projectCode);

    let upstreamResponse: Response;
    try {
      const upstreamUrl = new URL(TASK_SEARCH_PATH, `${upstreamOrigin}/`);
      upstreamUrl.search = params.toString();
      upstreamResponse = await fetchImpl(upstreamUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${env.BRAINBASE_TASK_API_TOKEN}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return jsonError("task_search_upstream_unavailable", 502);
    }
    if (!upstreamResponse.ok || upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      return jsonError("task_search_upstream_failed", 502);
    }

    try {
      const payload = await readBoundedJson(upstreamResponse);
      return Response.json(sanitizePage(payload, new Set(projectCodes)));
    } catch (error) {
      const code = error instanceof Error && [
        "task_search_response_too_large",
        "task_search_scope_violation",
      ].includes(error.message)
        ? error.message
        : "task_search_upstream_invalid_response";
      return jsonError(code, 502);
    }
  };
}

export const handleTaskSearchProxyRequest = createTaskSearchProxyHandler();
