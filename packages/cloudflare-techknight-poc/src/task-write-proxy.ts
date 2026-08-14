import { TaskApiClient, TaskApiError, type CanonicalTask, type CreateTaskInput, type TransitionTaskInput, type UpdateTaskInput } from "@openryoko/task-runtime-core";
import { authorizeTaskWriteIntent, evaluateTaskWritePolicy, verifyTaskWriteCapability, type TaskWriteIntent, type TaskWriteOperation, type TaskWritePolicy } from "@openryoko/write-broker";
import { parseRuntimeProjectCodes } from "./runtime-config.js";
import type { TaskBoardRepairEvent } from "./task-board.js";
import { claimTaskWriteBudgetSlot, type TaskWriteBudgetNamespace } from "./task-write-budget.js";
import { consumeTaskWriteApproval, createTaskWriteApproval, type TaskWriteApprovalNamespace } from "./task-write-approval.js";

export const TASK_WRITE_PROXY_HOST = "task-write.internal";
export const TASK_WRITE_PATH = "/api/task-write";

export interface TaskWriteProxyEnv {
  RUNTIME_TASK_WRITE_ENABLED?: string;
  RUNTIME_PROJECT_CODES?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  TASK_WRITE_POLICY_JSON?: string;
  TASK_WRITE_APPROVALS?: TaskWriteApprovalNamespace;
  SLACK_BOT_TOKEN?: string;
  RUNTIME_PLACEMENT_ID?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
  SLACK_ALLOWED_CHANNEL_ID?: string;
  TASK_WRITE_APPROVAL_CHANNEL_ID?: string;
  TENANT_ID?: string;
  TASK_BOARD_REPAIRS?: { send(message: TaskBoardRepairEvent): Promise<unknown> };
  TASK_WRITE_BUDGETS?: TaskWriteBudgetNamespace;
}

function parsePolicy(value: string | undefined): TaskWritePolicy {
  if (!value) throw new Error("task_write_policy_not_configured");
  try {
    const policy = JSON.parse(value) as TaskWritePolicy;
    if (!policy || typeof policy !== "object") throw new Error();
    return policy;
  } catch {
    throw new Error("task_write_policy_not_configured");
  }
}

async function postApprovalRequest(fetchImpl: typeof fetch, env: TaskWriteProxyEnv, input: {
  approvalId: string; payloadHash: string; requesterId: string; operation: string; project: string; expiresAt: number;
}): Promise<void> {
  const approvalChannelId = env.TASK_WRITE_APPROVAL_CHANNEL_ID ?? env.SLACK_ALLOWED_CHANNEL_ID;
  if (!env.SLACK_BOT_TOKEN || !approvalChannelId) throw new Error("task_write_approval_not_configured");
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", { method: "POST",
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: approvalChannelId,
      text: `書き込み承認が必要です: ${input.operation} (${input.project})`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*書き込み承認*\n依頼者: <@${input.requesterId}>\n操作: \`${input.operation}\`\nプロジェクト: \`${input.project}\`` } },
        { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "承認して実行" },
          action_id: "mana_task_write_approve", value: JSON.stringify({ approvalId: input.approvalId, payloadHash: input.payloadHash }) }] }] }),
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!response.ok || payload?.ok !== true) throw new Error("task_write_approval_notify_failed");
}

type WriteRequest = {
  request_id: string;
  project: string;
  operation: "create" | "update" | "transition";
  call_index: number;
  task_id?: string;
  expected_version?: number;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignee_person_id?: string | null;
  due_at?: string;
  to_status?: "pending" | "in_progress" | "waiting" | "completed";
  waiting_on?: string;
  review_at?: string;
};

function error(error: string, status: number): Response { return Response.json({ error }, { status }); }
function boundedUpstreamCode(code: string): string {
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "task_store_error";
}

function logUpstreamFailure(cause: unknown, body: WriteRequest): void {
  const isTaskApiError = cause instanceof TaskApiError;
  console.error(JSON.stringify({
    event: "task_write_upstream_error",
    requestId: body.request_id,
    operation: `task.${body.operation}`,
    upstreamStatus: isTaskApiError ? cause.status : null,
    upstreamCode: isTaskApiError ? boundedUpstreamCode(cause.code) : "task_write_network_error",
  }));
}

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length < (required ? 1 : 0) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalid_${name}`);
  return value.trim();
}
function integer(value: unknown, name: string, min = 1): number {
  if (!Number.isInteger(value) || (value as number) < min) throw new Error(`invalid_${name}`);
  return value as number;
}

function parseBody(value: unknown): WriteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["request_id","project","operation","call_index","task_id","expected_version","title","description","priority","assignee_person_id","due_at","to_status","waiting_on","review_at"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("invalid_body");
  if (!["create", "update", "transition"].includes(String(body.operation))) throw new Error("invalid_operation");
  const result: WriteRequest = {
    request_id: text(body.request_id, "request_id", 128, true)!,
    project: text(body.project, "project", 128, true)!,
    operation: body.operation as WriteRequest["operation"],
    call_index: integer(body.call_index, "call_index"),
  };
  if (result.call_index > 3) throw new Error("write_budget_exceeded");
  for (const key of ["task_id", "title", "description", "due_at", "waiting_on", "review_at"] as const) {
    const parsed = text(body[key], key, key === "description" ? 4000 : 500);
    if (parsed !== undefined) (result as Record<string, unknown>)[key] = parsed;
  }
  if (body.assignee_person_id === null) result.assignee_person_id = null;
  else if (body.assignee_person_id !== undefined) result.assignee_person_id = text(body.assignee_person_id, "assignee_person_id", 128);
  if (body.expected_version !== undefined) result.expected_version = integer(body.expected_version, "expected_version", 1);
  if (body.priority !== undefined) {
    if (!["low","medium","high","urgent"].includes(String(body.priority))) throw new Error("invalid_priority");
    result.priority = body.priority as WriteRequest["priority"];
  }
  if (body.to_status !== undefined) {
    if (!["pending","in_progress","waiting","completed"].includes(String(body.to_status))) throw new Error("invalid_to_status");
    result.to_status = body.to_status as WriteRequest["to_status"];
  }
  if (result.operation === "create" && !result.title) throw new Error("invalid_title");
  if (result.operation !== "create" && (!result.task_id || result.expected_version === undefined)) throw new Error("invalid_target");
  if (result.operation === "transition" && !result.to_status) throw new Error("invalid_to_status");
  return result;
}

function cleanTask(task: CanonicalTask): unknown {
  return { untrusted_data: true, task: { id: task.id, title: task.title, status: task.status, priority: task.priority, version: task.version, project_codes: task.project_codes, assignee_person_id: task.assignee_person_id ?? null, assignee_display_name: task.assignee_display_name ?? null, due_at: task.due_at ?? null } };
}

function upstreamOrigin(value: string | undefined): string {
  if (!value) throw new Error("not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("not_configured");
  return url.origin;
}

export function createTaskWriteProxyHandler(fetchImpl: typeof fetch = fetch) {
  return async (request: Request, env: TaskWriteProxyEnv): Promise<Response> => {
    if (env.RUNTIME_TASK_WRITE_ENABLED !== "true") return error("task_write_disabled", 503);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== TASK_WRITE_PROXY_HOST || url.pathname !== TASK_WRITE_PATH) return error("not_found", 404);
    if (request.method !== "POST" || url.search || request.headers.get("content-type")?.split(";",1)[0] !== "application/json") return error("task_write_invalid_request", 400);
    let body: WriteRequest;
    try { body = parseBody(await request.json()); } catch (cause) { return error(cause instanceof Error ? cause.message : "task_write_invalid_request", 400); }
    try {
      const projects = parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES);
      const secret = env.TASK_WRITE_CAPABILITY_SECRET;
      const token = request.headers.get("x-mana-task-write-capability") ?? "";
      if (!secret || projects.length === 0 || !env.BRAINBASE_TASK_API_TOKEN || !env.SLACK_EXPECTED_TEAM_ID || !env.RUNTIME_PLACEMENT_ID) throw new Error("task_write_not_configured");
      const claims = await verifyTaskWriteCapability(token, secret, { requestId: body.request_id, workspace: env.SLACK_EXPECTED_TEAM_ID, placementId: env.RUNTIME_PLACEMENT_ID });
      const operation = `task.${body.operation}` as TaskWriteOperation;
      const intent: TaskWriteIntent = { requestId: body.request_id, actor: claims.actor, placementId: claims.placementId,
        project: body.project, operation, targetId: body.task_id, idempotencyKey: `slack:${body.request_id}:${body.call_index}` };
      authorizeTaskWriteIntent(claims, intent);
      const decision = evaluateTaskWritePolicy(parsePolicy(env.TASK_WRITE_POLICY_JSON), intent);
      const fingerprint = await requestFingerprint(body);
      let approvedBy: string | undefined;
      if (decision.effect === "deny") {
        console.warn(JSON.stringify({ event: "task_write_policy_denied", requestId: body.request_id, actor: claims.actor.id,
          project: body.project, operation, policyVersion: decision.policyVersion, reason: decision.reason }));
        return error("task_write_policy_denied", 403);
      }
      if (decision.effect === "approval") {
        const approvalId = request.headers.get("x-mana-task-write-approval-id");
        const approverId = request.headers.get("x-mana-task-write-approver-id");
        if (approvalId && approverId && env.TASK_WRITE_APPROVALS) {
          const approved = await consumeTaskWriteApproval(env.TASK_WRITE_APPROVALS, { approvalId, approverId, payloadHash: fingerprint });
          if (approved.payloadHash !== fingerprint || approved.capability !== token || JSON.stringify(approved.body) !== JSON.stringify(body)
            || approved.requesterId !== claims.actor.id || approved.policyVersion !== decision.policyVersion) throw new Error("task_write_approval_payload_mismatch");
          console.log(JSON.stringify({ event: "task_write_approval_consumed", approvalId, requester: claims.actor.id,
            approver: approverId, policyVersion: decision.policyVersion, payloadHash: fingerprint }));
          approvedBy = approverId;
        } else {
          if (!env.TASK_WRITE_APPROVALS) throw new Error("task_write_approval_not_configured");
          const newApprovalId = crypto.randomUUID();
          const expiresAt = Math.min(claims.expiresAt, Date.now() + decision.ttlSeconds * 1000);
          await createTaskWriteApproval(env.TASK_WRITE_APPROVALS, { approvalId: newApprovalId, payloadHash: fingerprint,
            body, capability: token, requesterId: claims.actor.id, approvers: decision.approvers,
            policyVersion: decision.policyVersion, expiresAt });
          await postApprovalRequest(fetchImpl, env, { approvalId: newApprovalId, payloadHash: fingerprint,
            requesterId: claims.actor.id, operation, project: body.project, expiresAt });
          console.log(JSON.stringify({ event: "task_write_approval_required", approvalId: newApprovalId, requestId: body.request_id,
            actor: claims.actor.id, project: body.project, operation, policyVersion: decision.policyVersion, payloadHash: fingerprint }));
          return Response.json({ status: "approval_required", approval_id: newApprovalId,
            policy_version: decision.policyVersion, expires_at: new Date(expiresAt).toISOString() }, { status: 202 });
        }
      }
      if (!projects.includes(body.project) || body.call_index > Math.min(3, claims.budget) || !env.TASK_WRITE_BUDGETS) throw new Error("task_write_denied");
      await claimTaskWriteBudgetSlot(env.TASK_WRITE_BUDGETS, {
        requestId: claims.requestId,
        nonce: claims.nonce,
        placementId: claims.placementId,
        callIndex: body.call_index,
        budget: Math.min(3, claims.budget),
        expiresAt: claims.expiresAt,
        fingerprint,
      });
      let beforeVersion: number | undefined;
      const client = new TaskApiClient({
        baseUrl: upstreamOrigin(env.BRAINBASE_TASK_API_BASE_URL),
        token: env.BRAINBASE_TASK_API_TOKEN,
        fetchImpl,
      });
      let result: CanonicalTask;
      if (body.operation === "create") {
        const input: CreateTaskInput = {
          title: body.title!,
          project_codes: [body.project],
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.due_at !== undefined ? { due_at: body.due_at } : {}),
          ...(body.assignee_person_id !== undefined && body.assignee_person_id !== null
            ? { assignee_person_id: body.assignee_person_id }
            : {}),
        };
        result = await client.createTask(input, `slack:${body.request_id}:${body.call_index}`);
      } else {
        const before = await client.getTask(body.task_id!);
        beforeVersion = before.version;
        const beforeProjects = before.project_codes ?? [];
        if (!beforeProjects.includes(body.project) || beforeProjects.some((project) => !projects.includes(project))) throw new Error("task_write_scope_violation");
        if (body.operation === "update") {
          const input: UpdateTaskInput = {
            expected_version: body.expected_version!,
            project_codes: beforeProjects,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.priority !== undefined ? { priority: body.priority } : {}),
            ...(body.due_at !== undefined ? { due_at: body.due_at } : {}),
            ...(body.assignee_person_id !== undefined ? { assignee_person_id: body.assignee_person_id } : {}),
          };
          result = await client.updateTask(body.task_id!, input, `slack:${body.request_id}:${body.call_index}`);
        } else {
          const input: TransitionTaskInput = { expected_version: body.expected_version!, to_status: body.to_status! };
          if (body.waiting_on) input.waiting_on = body.waiting_on;
          if (body.review_at) input.review_at = body.review_at;
          result = await client.transitionTask(body.task_id!, input, `slack:${body.request_id}:${body.call_index}`);
        }
      }
      console.log(JSON.stringify({ event: "task_write_receipt", requestId: body.request_id, operation,
        requester: claims.actor.id, approver: approvedBy ?? null, project: body.project, taskId: result.id,
        policyVersion: decision.policyVersion, payloadHash: fingerprint, beforeVersion: beforeVersion ?? null,
        afterVersion: result.version, result: "executed" }));
      if (env.TASK_BOARD_REPAIRS && env.TENANT_ID && env.SLACK_EXPECTED_TEAM_ID && env.SLACK_ALLOWED_CHANNEL_ID) {
        await env.TASK_BOARD_REPAIRS.send({
          eventType: "task_board_repair",
          tenantId: env.TENANT_ID,
          workspaceId: env.SLACK_EXPECTED_TEAM_ID,
          channelId: env.SLACK_ALLOWED_CHANNEL_ID,
          reason: "task_write",
          requestedAt: new Date().toISOString(),
        }).catch(() => console.warn(JSON.stringify({ event: "task_board_repair_enqueue_failed", requestId: body.request_id })));
      }
      return Response.json(cleanTask(result));
    } catch (cause) {
      if (cause instanceof TaskApiError) {
        if (cause.status === 409) return error("task_write_conflict", 409);
        logUpstreamFailure(cause, body);
        return error("task_write_upstream_failed", 502);
      }
      const code = cause instanceof Error ? cause.message : "task_write_failed";
      if (["invalid_write_capability","expired_write_capability","write_capability_scope_mismatch","write_intent_denied","task_write_denied","task_write_scope_violation","task_write_budget_slot_reused","task_write_budget_exceeded"].includes(code)) return error(code, 403);
      if (code === "task_write_not_configured" || code === "task_write_policy_not_configured" || code === "task_write_approval_not_configured" || code === "invalid_write_policy" || code === "not_configured") return error("task_write_not_configured", 503);
      if (code.startsWith("task_write_approval_") || code === "task_write_approver_forbidden") return error(code, 403);
      logUpstreamFailure(cause, body);
      return error("task_write_upstream_failed", 502);
    }
  };
}

export const handleTaskWriteProxyRequest = createTaskWriteProxyHandler();

async function requestFingerprint(body: WriteRequest): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
