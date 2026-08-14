import {
  TaskApiClient,
  fetchBoundedTaskBoard,
  type BoundedTaskBoard,
  type CanonicalTask,
} from "@openryoko/task-runtime-core";
import { parseRuntimeProjectCodes } from "./runtime-config.js";

const DISPLAY_LIMIT = 20;

export interface TaskBoardRepairEvent {
  eventType: "task_board_repair";
  tenantId: string;
  workspaceId: string;
  channelId: string;
  reason: "task_write" | "scheduled" | "manual";
  requestedAt: string;
}

export interface TaskBoardEnv {
  RUNTIME_TASK_BOARD_ENABLED?: string;
  RUNTIME_PROJECT_CODES?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_ALLOWED_CHANNEL_ID?: string;
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

function canvasIdFromInfo(payload: Record<string, unknown>): string | null {
  const channel = payload.channel as Record<string, unknown> | undefined;
  const properties = channel?.properties as Record<string, unknown> | undefined;
  for (const key of ["tabs", "tabz"] as const) {
    const tabs = properties?.[key];
    if (!Array.isArray(tabs)) continue;
    for (const tab of tabs) {
      if (!tab || typeof tab !== "object" || (tab as Record<string, unknown>).type !== "canvas") continue;
      const data = (tab as Record<string, unknown>).data;
      const id = data && typeof data === "object" ? (data as Record<string, unknown>).file_id : null;
      if (typeof id === "string" && id) return id;
    }
  }
  const canvas = properties?.canvas as Record<string, unknown> | undefined;
  const id = canvas?.file_id ?? canvas?.id;
  return typeof id === "string" && id ? id : null;
}

async function publishCanvas(
  channelId: string,
  token: string,
  markdown: string,
  fetchImpl: typeof fetch,
): Promise<"created" | "updated"> {
  const createOrAdopt = async (): Promise<"created" | "updated"> => {
    try {
      await slackApi("conversations.canvases.create", token, {
        channel_id: channelId,
        title: "タスクボード",
        document_content: { type: "markdown", markdown },
      }, fetchImpl);
      return "created";
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("channel_canvas_already_exists")) throw error;
      const latestInfo = await slackApiGet("conversations.info", token, { channel: channelId }, fetchImpl);
      const adoptedId = canvasIdFromInfo(latestInfo);
      if (!adoptedId) throw error;
      await slackApi("canvases.edit", token, {
        canvas_id: adoptedId,
        changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
      }, fetchImpl);
      return "updated";
    }
  };

  const info = await slackApiGet("conversations.info", token, { channel: channelId }, fetchImpl);
  const existingId = canvasIdFromInfo(info);
  if (existingId) {
    try {
      await slackApi("canvases.edit", token, {
        canvas_id: existingId,
        changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
      }, fetchImpl);
      return "updated";
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("canvas_not_found")) throw error;
      return createOrAdopt();
    }
  }
  return createOrAdopt();
}

export async function refreshTaskBoard(
  env: TaskBoardEnv,
  options: { fetch?: typeof fetch; now?: () => string } = {},
): Promise<{ outcome: "disabled" | "created" | "updated"; displayed?: number; hasMore?: boolean }> {
  if (env.RUNTIME_TASK_BOARD_ENABLED !== "true") return { outcome: "disabled" };
  const projects = parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES);
  if (!projects.length || !env.BRAINBASE_TASK_API_BASE_URL || !env.BRAINBASE_TASK_API_TOKEN || !env.SLACK_BOT_TOKEN || !env.SLACK_ALLOWED_CHANNEL_ID) {
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
