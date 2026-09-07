import { TaskApiClient, type TaskListPage } from "@openryoko/task-runtime-core";
import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import { parseRuntimePlacements, type RuntimePlacement } from "./runtime-config.js";
import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import { createTaskWriteProxyHandler, type TaskWriteProxyEnv } from "./task-write-proxy.js";

export const RUNTIME_GATEWAY_PROXY_HOST = "gateway.internal";
export const RUNTIME_GATEWAY_PATH = "/api/runtime/gateway";

export interface RuntimeGatewayProxyEnv extends TaskWriteProxyEnv {
  RUNTIME_PLACEMENTS_JSON?: string;
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL?: string;
  BRAINBASE_PERSONAL_KNOWLEDGE_API_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  RUNTIME_EMPLOYEES_JSON?: string;
  RUNTIME_SESSION_REGISTRY?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
}

type GatewayBody = { tool: string; arguments: Record<string, unknown>; request_id: string; call_index?: number };
export type PersonalKnowledgeCapability = "personal_read" | "personal_write";
export type PersonalKnowledgeEffect = "read" | "write";

export interface RuntimeGatewayPersonalKnowledgeAuthorityRequest {
  capability: PersonalKnowledgeCapability;
  effect: PersonalKnowledgeEffect;
  requestId: string;
}

export interface RuntimeGatewayPersonalKnowledgeDependencies {
  tenantContext: TenantContextEnvelope;
  resolveAuthority(input: RuntimeGatewayPersonalKnowledgeAuthorityRequest): Promise<unknown>;
}

export interface RuntimeGatewayProxyDependencies {
  deliverSlackMessage?(input: {
    requestId: string;
    callIndex: number;
    channel: string;
    threadTs?: string;
    text: string;
  }): Promise<{ channel: string; ts?: string }>;
  /**
   * Resolves a fresh, operation-specific signed response for the Brainbase
   * Personal KG API. The callback owns Slack subject -> canonical person
   * binding and must never accept owner/org/authority values from model args.
   */
  personalKnowledge?: RuntimeGatewayPersonalKnowledgeDependencies;
}
const responseError = (error: string, status: number) => Response.json({ error }, { status });

const PERSONAL_KNOWLEDGE_TOOLS = ["search_personal_kg", "register_personal_kg"] as const;
type PersonalKnowledgeTool = (typeof PERSONAL_KNOWLEDGE_TOOLS)[number];

function hasOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(args).every((key) => accepted.has(key));
}

function personalKnowledgeSearchInput(args: Record<string, unknown>): { query: string; limit: number } | undefined {
  if (!hasOnlyKeys(args, ["query", "limit"]) || typeof args.query !== "string") return undefined;
  const query = args.query.trim();
  if (!query || query.length > 4000) return undefined;
  const limit = args.limit === undefined ? 10 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) return undefined;
  return { query, limit };
}

const PERSONAL_KNOWLEDGE_EVENT_FIELDS = [
  "body", "body_hash", "event_id", "source", "source_pointer", "parent_episode_id",
  "permission_snapshot", "sensitivity", "occurred_at", "captured_at",
] as const;

function personalKnowledgeEventInput(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!hasOnlyKeys(args, PERSONAL_KNOWLEDGE_EVENT_FIELDS) || typeof args.body !== "string"
    || !args.body.trim()
    || typeof args.body_hash !== "string" || !args.body_hash.trim()) return undefined;
  for (const key of PERSONAL_KNOWLEDGE_EVENT_FIELDS) {
    const value = args[key];
    if (value === undefined || key === "body" || key === "body_hash") continue;
    if (["source", "source_pointer", "permission_snapshot"].includes(key)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    } else if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function personalKnowledgeContextAllowed(
  tenantContext: TenantContextEnvelope,
  actor: { provider: string; id: string; workspace: string; personId?: string },
  placement: RuntimePlacement,
  expectedWorkspace: string,
  requestId: string,
): boolean {
  return actor.provider === "slack"
    && actor.workspace === expectedWorkspace
    && tenantContext.workspace_connection.provider === "slack"
    && tenantContext.workspace_connection.status === "active"
    && tenantContext.workspace_connection.workspace_id === expectedWorkspace
    && tenantContext.actor.principal_type === "person"
    && typeof tenantContext.actor.principal_id === "string"
    && tenantContext.actor.principal_id.trim().length > 0
    && tenantContext.actor.authenticated_subject_id === actor.id
    && tenantContext.slack.requester_id === actor.id
    && tenantContext.slack.event_id === requestId
    && /^D[A-Z0-9]+$/.test(tenantContext.slack.channel_id)
    && tenantContext.slack.channel_id === placement.channelId
    && (actor.personId === undefined || actor.personId === tenantContext.actor.principal_id);
}

function personalKnowledgeResult(value: unknown, tool: PersonalKnowledgeTool): unknown {
  if (tool === "search_personal_kg") {
    if (!Array.isArray(value) || value.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const eventId = (item as Record<string, unknown>).event_id;
      return typeof eventId !== "string" || !eventId.trim();
    })) {
      throw new Error("gateway_upstream_invalid_response");
    }
    return {
      untrusted_data: true,
      items: value,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("gateway_upstream_invalid_response");
  const event = value as Record<string, unknown>;
  if (typeof event.event_id !== "string" || !event.event_id.trim()
    || typeof event.owner_person_id !== "string" || !event.owner_person_id.trim()
    || typeof event.organization_id !== "string" || !event.organization_id.trim()
    || typeof event.body_hash !== "string" || !event.body_hash.trim()) {
    throw new Error("gateway_upstream_invalid_response");
  }
  return { untrusted_data: true, event };
}

function personalKnowledgeRequest(
  tool: PersonalKnowledgeTool,
  args: Record<string, unknown>,
): { capability: PersonalKnowledgeCapability; effect: PersonalKnowledgeEffect; payload: Record<string, unknown> } | undefined {
  if (tool === "search_personal_kg") {
    const payload = personalKnowledgeSearchInput(args);
    return payload ? { capability: "personal_read", effect: "read", payload } : undefined;
  }
  const payload = personalKnowledgeEventInput(args);
  return payload ? { capability: "personal_write", effect: "write", payload } : undefined;
}

function decodePlacementId(token: string): string {
  const encoded = token.split(".")[0];
  if (!encoded) throw new Error("gateway_denied");
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4))) as { placementId?: unknown };
  if (typeof claims.placementId !== "string") throw new Error("gateway_denied");
  return claims.placementId;
}

function cleanTask(task: Record<string, unknown>) {
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, version: task.version,
    project_codes: task.project_codes, assignee_person_id: task.assignee_person_id ?? null,
    assignee_display_name: task.assignee_display_name ?? null, due_at: task.due_at ?? null };
}

type TaskScope = { mode: "current_channel"; project_codes: string[] }
  | { mode: "authorized_channels"; channel_ids: string[]; channel_names: string[]; project_codes: string[];
    channels: Array<{ channel_id: string; channel_name: string | null; project_codes: string[] }> };

function normalizeTaskPage(page: TaskListPage, allowedProjects: readonly string[], requestedLimit: number, scope: TaskScope) {
  if (!page || !Array.isArray(page.items)) throw new Error("gateway_upstream_invalid_response");
  if (page.items.length > requestedLimit) throw new Error("gateway_upstream_invalid_response");
  if (page.items.some((task) => !task.project_codes?.length || task.project_codes.some((project) => !allowedProjects.includes(project)))) throw new Error("gateway_scope_violation");
  const countStatus = page.count_status ?? "not_requested";
  if (!["exact", "lower_bound", "not_requested", "unavailable"].includes(countStatus)) throw new Error("gateway_upstream_invalid_response");
  const requiresCount = countStatus === "exact" || countStatus === "lower_bound";
  if (requiresCount !== (Number.isInteger(page.total_count) && Number(page.total_count) >= 0)) throw new Error("gateway_upstream_invalid_response");
  const nextCursor = page.next_cursor ?? null;
  const hasMore = Boolean(page.has_more || nextCursor);
  const readStatus = hasMore ? "partial" : page.read_status === "partial" || page.read_status === "complete" ? page.read_status : "complete";
  return { untrusted_data: true,
    items: page.items.map((task) => cleanTask(task as unknown as Record<string, unknown>)), next_cursor: nextCursor,
    has_more: hasMore, total_count: requiresCount ? page.total_count : null, count_status: countStatus, read_status: readStatus,
    scope };
}

function taskQuery(args: Record<string, unknown>, projectCodes: readonly string[]) {
  const limit = args.limit === undefined ? 20 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return null;
  return { project_code: [...projectCodes], limit,
    ...(typeof args.status === "string" ? { status: args.status } : {}), ...(typeof args.priority === "string" ? { priority: args.priority } : {}),
    ...(typeof args.assignee_person_id === "string" ? { assignee_person_id: args.assignee_person_id } : {}), ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) };
}

function authorizedTaskScope(args: Record<string, unknown>, source: RuntimePlacement, placements: readonly RuntimePlacement[], actorId: string) {
  const suppliedIds = args.channel_ids;
  const suppliedNames = args.channel_names;
  if ((suppliedIds === undefined) === (suppliedNames === undefined)) return null;
  let channelIds: string[];
  if (suppliedIds !== undefined) {
    if (!Array.isArray(suppliedIds) || suppliedIds.length < 1 || suppliedIds.length > 10 ||
      suppliedIds.some((id) => typeof id !== "string" || !/^[A-Z0-9_]{2,32}$/.test(id)) ||
      new Set(suppliedIds).size !== suppliedIds.length) return null;
    channelIds = suppliedIds as string[];
  } else {
    if (!Array.isArray(suppliedNames) || suppliedNames.length < 1 || suppliedNames.length > 10 ||
      suppliedNames.some((name) => typeof name !== "string")) return null;
    const normalizedNames = (suppliedNames as string[]).map((name) => name.trim().replace(/^#/, "").toLowerCase());
    if (normalizedNames.some((name) => !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) ||
      new Set(normalizedNames).size !== normalizedNames.length) return null;
    const resolved = normalizedNames.map((name) => placements.filter((candidate) => candidate.channelName === name));
    if (resolved.some((matches) => matches.length !== 1)) return null;
    channelIds = resolved.map((matches) => matches[0].channelId);
  }
  const allowedChannels = source.taskInventoryChannelIds ?? [];
  if (channelIds.some((id) => !allowedChannels.includes(id))) return null;
  const channels = channelIds.map((channelId) => {
    const matches = placements.filter((candidate) => candidate.channelId === channelId);
    if (matches.length !== 1 || !matches[0].taskInventoryAllowedUserIds?.includes(actorId)) return null;
    return { channel_id: channelId, channel_name: matches[0].channelName ?? null, project_codes: [...matches[0].projectCodes] };
  });
  if (channels.some((channel) => channel === null)) return null;
  const resolvedChannels = channels as Array<{ channel_id: string; channel_name: string | null; project_codes: string[] }>;
  const projectCodes = [...new Set(resolvedChannels.flatMap((channel) => channel.project_codes))];
  return { projectCodes, scope: { mode: "authorized_channels" as const, channel_ids: channelIds,
    channel_names: resolvedChannels.flatMap((channel) => channel.channel_name ? [channel.channel_name] : []),
    project_codes: projectCodes, channels: resolvedChannels } };
}

function authorizedTaskChannels(source: RuntimePlacement, placements: readonly RuntimePlacement[], actorId: string) {
  const channels = (source.taskInventoryChannelIds ?? []).flatMap((channelId) => {
    const matches = placements.filter((candidate) => candidate.channelId === channelId);
    if (matches.length !== 1 || !matches[0].taskInventoryAllowedUserIds?.includes(actorId)) return [];
    return [{ channel_id: channelId, channel_name: matches[0].channelName ?? null, project_codes: [...matches[0].projectCodes] }];
  });
  return { channels, scope: { mode: "authorized_channels" as const } };
}

export function createRuntimeGatewayProxyHandler(
  fetchImpl?: typeof fetch,
  dependencies: RuntimeGatewayProxyDependencies = {},
) {
  const brokered = fetchImpl !== undefined;
  const providerFetch = fetchImpl ?? fetch;
  return async (request: Request, env: RuntimeGatewayProxyEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.protocol !== "https:" || url.hostname !== RUNTIME_GATEWAY_PROXY_HOST || url.pathname !== RUNTIME_GATEWAY_PATH) return responseError("not_found", 404);
    let body: GatewayBody;
    try {
      body = await request.json() as GatewayBody;
      if (!body || typeof body.tool !== "string" || typeof body.request_id !== "string" || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) throw new Error();
      const secret = env.TASK_WRITE_CAPABILITY_SECRET;
      const token = request.headers.get("x-mana-task-write-capability") ?? "";
      if (!secret || !env.SLACK_EXPECTED_TEAM_ID) throw new Error();
      const placementId = decodePlacementId(token);
      const claims = await verifyTaskWriteCapability(token, secret, { requestId: body.request_id, workspace: env.SLACK_EXPECTED_TEAM_ID, placementId });
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const placement = placements.find((item) => item.placementId === claims.placementId);
      if (!placement || !placement.audience?.allowedUserIds.includes(claims.actor.id) || !placement.capabilities?.gatewayTools.includes(body.tool)) return responseError("gateway_denied", 403);
      if (claims.projects.length !== placement.projectCodes.length || claims.projects.some((project) => !placement.projectCodes.includes(project))) return responseError("gateway_denied", 403);

      if ((PERSONAL_KNOWLEDGE_TOOLS as readonly string[]).includes(body.tool)) {
        const tool = body.tool as PersonalKnowledgeTool;
        const input = personalKnowledgeRequest(tool, body.arguments);
        if (!input) return responseError("invalid_arguments", 400);
        const personalKnowledge = dependencies.personalKnowledge;
        if (!personalKnowledge || !env.BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL
          || (!env.BRAINBASE_PERSONAL_KNOWLEDGE_API_TOKEN && !brokered)) {
          return responseError("gateway_not_configured", 503);
        }
        if (!personalKnowledgeContextAllowed(
          personalKnowledge.tenantContext,
          claims.actor,
          placement,
          env.SLACK_EXPECTED_TEAM_ID,
          body.request_id,
        )) return responseError("gateway_denied", 403);

        let companyAuthorityResponse: unknown;
        try {
          companyAuthorityResponse = await personalKnowledge.resolveAuthority({
            capability: input.capability,
            effect: input.effect,
            requestId: body.request_id,
          });
        } catch {
          return responseError("gateway_authority_denied", 403);
        }
        if (!companyAuthorityResponse || typeof companyAuthorityResponse !== "object" || Array.isArray(companyAuthorityResponse)) {
          return responseError("gateway_authority_denied", 403);
        }

        let endpoint: URL;
        try {
          const base = new URL(env.BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL);
          if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("invalid_endpoint");
          endpoint = new URL(tool === "search_personal_kg"
            ? "/api/personal-knowledge/search"
            : "/api/personal-knowledge/events", base);
        } catch {
          return responseError("gateway_not_configured", 503);
        }
        const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
        if (env.BRAINBASE_PERSONAL_KNOWLEDGE_API_TOKEN) headers.set("authorization", `Bearer ${env.BRAINBASE_PERSONAL_KNOWLEDGE_API_TOKEN}`);
        let upstream: Response;
        try {
          upstream = await providerFetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...input.payload, company_authority_response: companyAuthorityResponse }),
          });
        } catch {
          return responseError("gateway_upstream_failed", 502);
        }
        if (!upstream.ok) return responseError("gateway_upstream_failed", 502);
        let result: unknown;
        try {
          result = await upstream.json();
          result = personalKnowledgeResult(result, tool);
        } catch (cause) {
          return responseError(cause instanceof Error && cause.message === "gateway_upstream_invalid_response"
            ? "gateway_upstream_invalid_response" : "gateway_upstream_failed", 502);
        }
        return Response.json(result);
      }

      if (["create_task","update_task","transition_task"].includes(body.tool)) {
        const operation = body.tool.replace("_task", "");
        return createTaskWriteProxyHandler(fetchImpl)(new Request("https://task-write.internal/api/task-write", { method: "POST",
          headers: { "content-type": "application/json", "x-mana-task-write-capability": token },
          body: JSON.stringify({ ...body.arguments, request_id: body.request_id, project: placement.projectCodes[0], operation, call_index: body.call_index }) }),
        { ...env, RUNTIME_PROJECT_CODES: placement.projectCodes.join(","), RUNTIME_PLACEMENT_ID: placement.placementId,
          SLACK_ALLOWED_CHANNEL_ID: placement.channelId });
      }
      if (body.tool === "list_authorized_task_channels") {
        if (Object.keys(body.arguments).length !== 0) return responseError("invalid_arguments", 400);
        return Response.json(authorizedTaskChannels(placement, placements, claims.actor.id));
      }
      if (["list_tasks", "search_tasks", "list_tasks_across_channels", "search_tasks_across_channels"].includes(body.tool)) {
        if (!env.BRAINBASE_TASK_API_BASE_URL || (!env.BRAINBASE_TASK_API_TOKEN && !brokered)) return responseError("gateway_not_configured", 503);
        const isSearch = body.tool === "search_tasks" || body.tool === "search_tasks_across_channels";
        const isCrossChannel = body.tool === "list_tasks_across_channels" || body.tool === "search_tasks_across_channels";
        if (isSearch && env.RUNTIME_TASK_SEARCH_ENABLED !== "true") return responseError("gateway_tool_disabled", 503);
        const args = body.arguments;
        const authorized = isCrossChannel ? authorizedTaskScope(args, placement, placements, claims.actor.id) : null;
        if (isCrossChannel && !authorized) return responseError("gateway_denied", 403);
        const projectCodes = authorized?.projectCodes ?? placement.projectCodes;
        const scope: TaskScope = authorized?.scope ?? { mode: "current_channel", project_codes: [...placement.projectCodes] };
        const query = taskQuery(args, projectCodes);
        if (!query) return responseError("invalid_arguments", 400);
        if (isSearch && (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200)) return responseError("invalid_arguments", 400);
        const client = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL,
          token: env.BRAINBASE_TASK_API_TOKEN, fetchImpl: providerFetch });
        try {
          const page = isSearch ? await client.searchTasks({ ...query, query: (args.query as string).trim() }) : await client.listTasks(query);
          return Response.json(normalizeTaskPage(page, projectCodes, query.limit, scope));
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : "gateway_upstream_failed";
          return responseError(error === "gateway_scope_violation" || error === "gateway_upstream_invalid_response" ? error : "gateway_upstream_failed", 502);
        }
      }
      if (body.tool === "send_message") {
        const args = body.arguments;
        const delivery = placement.deliveryScopes ?? [];
        if (args.connector !== "slack" || typeof args.channel !== "string" || !delivery.some((scope) => scope.connector === "slack" && scope.channelId === args.channel) || typeof args.text !== "string" || !args.text.trim()) return responseError("gateway_delivery_denied", 403);
        if (!dependencies.deliverSlackMessage) return responseError("gateway_delivery_not_configured", 503);
        const delivered = await dependencies.deliverSlackMessage({
          requestId: body.request_id,
          callIndex: Number.isInteger(body.call_index) && Number(body.call_index) >= 0
            ? Number(body.call_index)
            : 0,
          channel: args.channel,
          ...(typeof args.thread === "string" ? { threadTs: args.thread } : {}),
          text: args.text.trim(),
        });
        return Response.json({ ok: true, channel: delivered.channel, ...(delivered.ts ? { ts: delivered.ts } : {}) });
      }
      if (body.tool === "list_sessions" || body.tool === "get_session") {
        if (!env.RUNTIME_SESSION_REGISTRY) return responseError("gateway_not_configured", 503);
        const stub = env.RUNTIME_SESSION_REGISTRY.get(env.RUNTIME_SESSION_REGISTRY.idFromName(placement.placementId));
        const args = body.arguments;
        const path = body.tool === "list_sessions"
          ? `/sessions${typeof args.status === "string" ? `?status=${encodeURIComponent(args.status)}` : ""}`
          : `/sessions/${encodeURIComponent(String(args.sessionId ?? ""))}`;
        if (body.tool === "get_session" && !args.sessionId) return responseError("invalid_arguments", 400);
        const result = await stub.fetch(`https://session-registry.internal${path}`);
        return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
      }
      if (body.tool === "list_employees" || body.tool === "get_employee") {
        let employees: Array<Record<string, unknown>>;
        try {
          const parsed = JSON.parse(env.RUNTIME_EMPLOYEES_JSON ?? "[]") as unknown;
          if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).name !== "string")) throw new Error();
          employees = parsed as Array<Record<string, unknown>>;
        } catch { return responseError("gateway_not_configured", 503); }
        if (body.tool === "list_employees") return Response.json({ employees: employees.map(({ persona: _persona, ...employee }) => employee) });
        const name = body.arguments.name;
        if (typeof name !== "string" || !name.trim()) return responseError("invalid_arguments", 400);
        const employee = employees.find((candidate) => candidate.name === name.trim());
        return employee ? Response.json(employee) : responseError("employee_not_found", 404);
      }
      return responseError("gateway_tool_not_implemented", 503);
    } catch (cause) {
      console.error(JSON.stringify({ event: "runtime_gateway_denied", reason: cause instanceof Error ? cause.message : "unknown" }));
      return responseError("gateway_denied", 403);
    }
  };
}

export const handleRuntimeGatewayProxyRequest = createRuntimeGatewayProxyHandler();
