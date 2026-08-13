import {
  postSlackReply,
  ReplyPipelineError,
  updateSlackReply,
  withSlackThreadStatus,
  type ReplySandbox,
} from "./reply-pipeline.js";
import type { RuntimeBinding } from "./runtime-config.js";
import type { SlackQueueEvent } from "./types.js";
import {
  isReplyCompleted,
  persistReplyCompletion,
  type WorkspaceFs,
} from "./workspace-store.js";
import {
  buildRuntimeClaudeCommand,
  runtimeClaudePromptPath,
  type ClaudeRuntimeConfig,
} from "./claude-runtime-config.js";
import {
  applyTrustedProjectScope,
  TaskApiClient,
  TaskApiError,
} from "@openryoko/task-runtime-core";

const MAX_TASKS = 20;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4_000;
const ALLOWED_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

interface TaskCandidate {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  due_at?: string;
}

interface RegisteredTask extends TaskCandidate {
  index: number;
  taskId: string;
}

interface FailedTask {
  index: number;
  code: string;
}

interface TaskRunState {
  eventId: string;
  candidates: TaskCandidate[];
  registered: RegisteredTask[];
  failures: FailedTask[];
  notificationTs?: string;
}

export interface MeetingTaskPipelineOptions {
  binding: RuntimeBinding;
  brainbaseApiBaseUrl?: string;
  brainbaseTaskToken?: string;
  slackBotToken?: string;
  oauthConfigured: boolean;
  claudeRuntime: ClaudeRuntimeConfig;
  createSandbox(id: string): ReplySandbox;
  fetch?: typeof fetch;
  now?: () => string;
  hydrateThreadContext?(event: SlackQueueEvent): Promise<SlackQueueEvent>;
}

export interface MeetingTaskProcessResult {
  outcome: "already_completed" | "tasks_registered";
  registered: number;
  responseTs?: string;
}

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return cleaned || undefined;
}

function normalizeDueAt(value: unknown): string | undefined {
  const due = cleanText(value, 64);
  if (!due) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return `${due}T00:00:00+09:00`;
  return Number.isNaN(Date.parse(due)) ? undefined : due;
}

function parseCandidates(stdout: string): TaskCandidate[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    throw new ReplyPipelineError("task_candidates_invalid");
  }
  const rawTasks = typeof payload === "object" && payload !== null
    ? (payload as { tasks?: unknown }).tasks
    : undefined;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > MAX_TASKS) {
    throw new ReplyPipelineError("task_candidates_invalid");
  }
  const candidates = rawTasks.map((raw): TaskCandidate | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    const title = cleanText(record.title, MAX_TITLE_CHARS);
    if (!title) return undefined;
    const description = cleanText(record.description, MAX_DESCRIPTION_CHARS);
    const priorityValue = cleanText(record.priority, 16)?.toLowerCase();
    const priority = priorityValue && ALLOWED_PRIORITIES.has(priorityValue)
      ? priorityValue as TaskCandidate["priority"]
      : undefined;
    const due_at = normalizeDueAt(record.due_at);
    return {
      title,
      ...(description ? { description } : {}),
      ...(priority ? { priority } : {}),
      ...(due_at ? { due_at } : {}),
    };
  });
  if (candidates.some((candidate) => !candidate)) {
    throw new ReplyPipelineError("task_candidates_invalid");
  }
  return candidates as TaskCandidate[];
}

export function isMeetingTaskRequest(event: SlackQueueEvent): boolean {
  if (event.eventType !== "app_mention" || !event.userId || event.botId || event.subtype) {
    return false;
  }
  const normalized = event.text.replace(/<@[^>]{1,128}>/g, " ");
  return normalized.includes("議事録") && normalized.includes("タスク");
}

function buildExtractionPrompt(event: SlackQueueEvent): string {
  const current = event.text
    .replace(/<@[^>]{1,128}>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, 4_000);
  const context = event.threadContext
    ?.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, 20_000);
  const source = [context, current].filter(Boolean).join("\n\n");
  return [
    "次の日本語議事録から、実行が明示されたタスクだけを抽出してください。",
    "推測で担当者、期限、projectを補わないでください。",
    "JSON以外を出力しないでください。",
    '{"tasks":[{"title":"...","description":"...","priority":"low|medium|high|urgent","due_at":"YYYY-MM-DD"}]}',
    "tenant、workspace、channel、project_codesなどの権限情報は出力しないでください。",
    "",
    source,
  ].join("\n");
}

async function extractCandidates(
  event: SlackQueueEvent,
  options: Pick<MeetingTaskPipelineOptions, "oauthConfigured" | "claudeRuntime" | "createSandbox">,
): Promise<TaskCandidate[]> {
  if (!options.oauthConfigured) throw new ReplyPipelineError("oauth_not_configured");
  const sandbox = options.createSandbox(`meeting-tasks-${event.eventId}`);
  try {
    const promptPath = runtimeClaudePromptPath("meeting-task");
    await sandbox.writeFile(promptPath, buildExtractionPrompt(event));
    let result;
    try {
      result = await sandbox.exec(
        buildRuntimeClaudeCommand("meeting-task", options.claudeRuntime),
        {
          timeout: 120_000,
          env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
        },
      );
    } catch {
      throw new ReplyPipelineError("sandbox_unavailable");
    }
    if (!result.success) throw new ReplyPipelineError("claude_execution_failed");
    return parseCandidates(result.stdout);
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

function taskRunPath(eventId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) throw new ReplyPipelineError("event_id_invalid");
  return `/task-runs/${eventId}.json`;
}

async function loadTaskRun(fs: WorkspaceFs, eventId: string): Promise<TaskRunState | undefined> {
  const path = taskRunPath(eventId);
  await fs.mkdir("/task-runs", { recursive: true });
  if (!(await fs.ls("/task-runs")).includes(path)) return undefined;
  try {
    const raw = await fs.readFile(path);
    const text = typeof raw === "string" ? raw : await new Response(raw).text();
    const state = JSON.parse(text) as TaskRunState;
    state.failures ??= [];
    return state;
  } catch {
    throw new ReplyPipelineError("task_run_state_invalid");
  }
}

async function saveTaskRun(fs: WorkspaceFs, state: TaskRunState): Promise<void> {
  await fs.mkdir("/task-runs", { recursive: true });
  await fs.writeFile(taskRunPath(state.eventId), JSON.stringify(state));
}

export async function taskIdempotencyKey(eventId: string, index: number): Promise<string> {
  const input = new TextEncoder().encode(`meeting-task:${eventId}:${index}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `meeting-task-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function createBrainbaseTask(
  event: SlackQueueEvent,
  candidate: TaskCandidate,
  index: number,
  options: MeetingTaskPipelineOptions,
): Promise<string> {
  if (!options.brainbaseApiBaseUrl || !options.brainbaseTaskToken) {
    throw new ReplyPipelineError("brainbase_not_configured");
  }
  let task: Awaited<ReturnType<TaskApiClient["createTask"]>>;
  try {
    const client = new TaskApiClient({
      baseUrl: options.brainbaseApiBaseUrl,
      token: options.brainbaseTaskToken,
      fetchImpl: (async (input, init) => {
        return await (options.fetch ?? fetch)(input, {
          ...init,
          signal: AbortSignal.timeout(15_000),
        });
      }) as typeof fetch,
    });
    task = await client.createTask(
      applyTrustedProjectScope(candidate, options.binding.projectCodes),
      await taskIdempotencyKey(event.eventId, index),
    );
  } catch (error) {
    if (error instanceof TaskApiError) {
      if (error.code === "task_store_invalid_response") {
        throw new ReplyPipelineError("brainbase_invalid_response");
      }
      throw new ReplyPipelineError("brainbase_task_registration_failed");
    }
    throw new ReplyPipelineError("brainbase_unavailable");
  }
  const taskId = cleanText(task.id, 256);
  if (!taskId) throw new ReplyPipelineError("brainbase_invalid_response");
  return taskId;
}

function notificationText(state: TaskRunState): string {
  const registeredLines = [...state.registered]
    .sort((left, right) => left.index - right.index)
    .map((task) => `• ${task.title}（${task.taskId}）`);
  const failedLines = [...state.failures]
    .sort((left, right) => left.index - right.index)
    .map((failure) => `• ${state.candidates[failure.index]?.title ?? `候補${failure.index + 1}`}（登録失敗: ${failure.code}）`);
  return [
    `Brainbaseタスク登録: 成功${state.registered.length}件・失敗${state.failures.length}件`,
    ...registeredLines,
    ...failedLines,
  ].join("\n");
}

async function publishNotification(
  fs: WorkspaceFs,
  event: SlackQueueEvent,
  state: TaskRunState,
  options: MeetingTaskPipelineOptions,
): Promise<string> {
  const text = notificationText(state);
  if (state.notificationTs) {
    await updateSlackReply(event, state.notificationTs, text, options);
    return state.notificationTs;
  }
  const responseTs = await postSlackReply(event, text, options);
  state.notificationTs = responseTs;
  await saveTaskRun(fs, state);
  return responseTs;
}

export async function processMeetingTaskEvent(
  fs: WorkspaceFs,
  event: SlackQueueEvent,
  options: MeetingTaskPipelineOptions,
): Promise<MeetingTaskProcessResult> {
  if (await isReplyCompleted(fs, event.eventId)) {
    return { outcome: "already_completed", registered: 0 };
  }
  return withSlackThreadStatus(event, options, async () => {
    const hydratedEvent = options.hydrateThreadContext
      ? await options.hydrateThreadContext(event)
      : event;
    let state = await loadTaskRun(fs, event.eventId);
    if (!state) {
      state = {
        eventId: event.eventId,
        candidates: await extractCandidates(hydratedEvent, options),
        registered: [],
        failures: [],
      };
      await saveTaskRun(fs, state);
    }
    for (let index = 0; index < state.candidates.length; index += 1) {
      if (state.registered.some((task) => task.index === index)) continue;
      const candidate = state.candidates[index];
      try {
        const taskId = await createBrainbaseTask(hydratedEvent, candidate, index, options);
        state.registered.push({ ...candidate, index, taskId });
        state.failures = state.failures.filter((failure) => failure.index !== index);
      } catch (error) {
        const code = error instanceof ReplyPipelineError ? error.code : "unexpected_error";
        state.failures = [
          ...state.failures.filter((failure) => failure.index !== index),
          { index, code },
        ];
      }
      await saveTaskRun(fs, state);
    }
    const responseTs = await publishNotification(fs, hydratedEvent, state, options);
    if (state.failures.length > 0) {
      throw new ReplyPipelineError("brainbase_task_registration_partial");
    }
    await persistReplyCompletion(fs, {
      eventId: event.eventId,
      responseTs,
      completedAt: options.now?.() ?? new Date().toISOString(),
    });
    return { outcome: "tasks_registered", registered: state.registered.length, responseTs };
  });
}
