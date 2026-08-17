import {
  TaskApiClient,
  fetchBoundedTaskBoard,
  type BoundedTaskBoard,
  type CanonicalTask,
} from "@openryoko/task-runtime-core";
import { parseRuntimeProjectCodes } from "./runtime-config.js";

const DISPLAY_LIMIT = 20;
const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const AMBIGUOUS_SLACK_ERRORS = new Set(["fatal_error", "internal_error", "request_timeout", "service_unavailable"]);

export interface TaskBoardRepairEvent {
  eventType: "task_board_repair";
  tenantId: string;
  workspaceId: string;
  channelId: string;
  targetId: string;
  manaCanvasId: string | null;
  bindingRevision: number;
  reason: "task_write" | "scheduled" | "manual";
  requestedAt: string;
}

export interface TaskBoardEnv {
  RUNTIME_TASK_BOARD_ENABLED?: string;
  RUNTIME_PROJECT_CODES?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
  TASK_BOARD_TARGETS_JSON?: string;
  SLACK_ALLOWED_CHANNEL_ID?: string;
  TASK_BOARD_CANVAS_ID?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
  TENANT_ID?: string;
}

function clean(value: string): string {
  return value.replace(/[<>]/g, "").replace(/[\r\n|]/g, " ").trim().slice(0, 160);
}

function taskLine(task: CanonicalTask): string {
  const assignee = task.assignee_display_name?.trim() || "未割当";
  const due = task.due_at ? `｜期限 ${clean(task.due_at.slice(0, 10))}` : "";
  return `- ${clean(task.title)}｜${clean(assignee)}｜${clean(task.priority)}${due}`;
}

export function renderBoundedTaskBoard(board: BoundedTaskBoard, projects: readonly string[], nowIso: string): string {
  const groups = [
    ["進行中", "in_progress"],
    ["保留", "waiting"],
    ["未着手", "pending"],
    ["完了", "completed"],
  ] as const;
  const count = board.hasMore
    ? `表示 ${board.observedLowerBound}件以上（続きあり、先頭${board.items.length}件を表示）`
    : `全 ${board.items.length}件`;
  const sections = groups.flatMap(([label, status]) => {
    const items = board.items.filter((task) => task.status === status);
    return [`## ${label}（表示${items.length}件）`, ...(items.length ? items.map(taskLine) : ["- なし"]), ""];
  });
  return [
    "# タスクボード",
    `Brainbase正本｜対象project: ${projects.map(clean).join(", ")}｜${count}`,
    `最終更新: ${clean(nowIso)}`,
    "",
    ...sections,
    board.hasMore ? "必要なタスクはSlackで条件を指定して検索してください。全件走査はしていません。" : "",
    "",
  ].join("\n");
}

async function slackApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const code = typeof payload?.error === "string" ? payload.error : "slack_api_failed";
    throw new Error(`task_board_${code.replace(/[^a-z0-9_-]/gi, "_")}`);
  }
  return payload;
}

export class TaskBoardCanvasProvisioningError extends Error {
  constructor(message: string, readonly definitive: boolean) {
    super(message);
    this.name = "TaskBoardCanvasProvisioningError";
  }
}

export async function createManagedTaskBoardCanvas(
  channelId: string,
  token: string,
  options: { fetch?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl("https://slack.com/api/canvases.create", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel_id: channelId,
        title: "Mana タスクボード",
        document_content: {
          type: "markdown",
          markdown: "# タスクボード\n\nManaがBrainbaseの正本タスクを同期します。",
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TaskBoardCanvasProvisioningError("task_board_canvas_create_uncertain", false);
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const canvasId = typeof payload?.canvas_id === "string" ? payload.canvas_id : "";
  if (response.ok && payload?.ok === true && SLACK_ID.test(canvasId)) return canvasId;
  const code = typeof payload?.error === "string"
    ? payload.error.replace(/[^a-z0-9_-]/gi, "_")
    : "slack_api_failed";
  const definitive = response.status < 500
    && payload?.ok === false
    && !AMBIGUOUS_SLACK_ERRORS.has(code);
  throw new TaskBoardCanvasProvisioningError(`task_board_${code}`, definitive);
}

async function slackApiGet(
  method: string,
  token: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const code = typeof payload?.error === "string" ? payload.error : "slack_api_failed";
    throw new Error(`task_board_${code.replace(/[^a-z0-9_-]/gi, "_")}`);
  }
  return payload;
}

function canvasIdsFromInfo(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const channel = payload.channel as Record<string, unknown> | undefined;
  const properties = channel?.properties as Record<string, unknown> | undefined;
  for (const key of ["tabs", "tabz"] as const) {
    const tabs = properties?.[key];
    if (!Array.isArray(tabs)) continue;
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object" || (tab as Record<string, unknown>).type !== "canvas") continue;
      const data = (tab as Record<string, unknown>).data;
      const id = data && typeof data === "object" ? (data as Record<string, unknown>).file_id : null;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  const canvas = properties?.canvas as Record<string, unknown> | undefined;
  const id = canvas?.file_id ?? canvas?.id;
  if (typeof id === "string" && id) ids.add(id);
  return ids;
}

async function publishCanvas(
  channelId: string,
  canvasId: string,
  token: string,
  markdown: string,
  fetchImpl: typeof fetch,
): Promise<"updated"> {
  const info = await slackApiGet("conversations.info", token, { channel: channelId }, fetchImpl);
  if (!canvasIdsFromInfo(info).has(canvasId)) throw new Error("task_board_canvas_binding_mismatch");
  await slackApi("canvases.edit", token, {
    canvas_id: canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
  }, fetchImpl);
  return "updated";
}

export async function refreshTaskBoard(
  env: TaskBoardEnv,
  options: { fetch?: typeof fetch; now?: () => string } = {},
): Promise<{ outcome: "disabled" | "updated"; displayed?: number; hasMore?: boolean }> {
  if (env.RUNTIME_TASK_BOARD_ENABLED !== "true") return { outcome: "disabled" };
  const projects = parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES);
  if (!projects.length || !env.BRAINBASE_TASK_API_BASE_URL || !env.BRAINBASE_TASK_API_TOKEN || !env.SLACK_BOT_TOKEN ||
    !env.SLACK_ALLOWED_CHANNEL_ID || !env.TASK_BOARD_CANVAS_ID) {
    throw new Error("task_board_not_configured");
  }
  const fetchImpl = options.fetch ?? fetch;
  const client = new TaskApiClient({
    baseUrl: env.BRAINBASE_TASK_API_BASE_URL,
    token: env.BRAINBASE_TASK_API_TOKEN,
    fetchImpl,
  });
  const board = await fetchBoundedTaskBoard(client, projects, DISPLAY_LIMIT);
  const now = options.now?.() ?? new Date().toISOString();
  const outcome = await publishCanvas(
    env.SLACK_ALLOWED_CHANNEL_ID,
    env.TASK_BOARD_CANVAS_ID,
    env.SLACK_BOT_TOKEN,
    renderBoundedTaskBoard(board, projects, now),
    fetchImpl,
  );
  console.log(JSON.stringify({ event: "task_board_refreshed", outcome, displayed: board.items.length, hasMore: board.hasMore }));
  return { outcome, displayed: board.items.length, hasMore: board.hasMore };
}

export function isTaskBoardRepairEvent(value: unknown): value is TaskBoardRepairEvent {
  return Boolean(value && typeof value === "object" && (value as { eventType?: unknown }).eventType === "task_board_repair");
}
