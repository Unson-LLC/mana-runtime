/**
 * Task Board Canvas for Slack — a self-updating Canvas that mirrors the
 * canonical Brainbase task store (source of truth: Brainbase PostgreSQL).
 *
 * The canvas is a read-only projection: it is regenerated wholesale on every
 * update, so edits made directly on the canvas are never read back into the
 * store and will be overwritten.
 *
 * Lifecycle: started by SlackConnector when `taskCanvas.enabled === true`.
 * Polls the Brainbase task API every `pollIntervalMs` (default 5 min),
 * renders Markdown, and pushes it into each placement channel's Slack Canvas.
 * Canvases are created on first run and reused afterwards; their IDs are persisted under
 * `${JINN_HOME}/.task-canvas-state.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import {
  BrainbaseTaskClient,
  isBrainbaseTaskStoreConfigured,
  type BrainbaseTask,
} from "../../shared/brainbase-tasks.js";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import type { PlacementProfile } from "../../shared/types.js";
import { buildTaskCanvasProjectSettingsUrl } from "./settings-deep-link.js";

export interface TaskCanvasConfig {
  enabled?: boolean;
  /** Slack channel to host this projection. If unset, a standalone canvas is created. */
  channelId?: string;
  /** Display title. Defaults to "タスクボード". */
  title?: string;
  /** Polling interval in ms. Default 5 min. */
  pollIntervalMs?: number;
  /** Max tasks rendered per status section. Default 50. */
  maxPerSection?: number;
  /** Union of placement projects visible in this channel canvas. */
  projectCodes?: string[];
  /** Mana Web UI origin used to build a channel-scoped project settings link. */
  settingsWebBaseUrl?: string;
  /** Fully resolved settings link rendered in the canvas. */
  settingsUrl?: string;
}

interface PersistedState {
  canvasId?: string;
  channelId?: string;
  canvases?: Record<string, string>;
}

const STATE_FILE = path.join(JINN_HOME, ".task-canvas-state.json");
const DEFAULT_TITLE = "タスクボード";
const DEFAULT_POLL_MS = 300_000;
const MIN_POLL_MS = 30_000;
const DEFAULT_MAX_PER_SECTION = 50;
const MAX_CONSECUTIVE_FAILURES = 10;
// Canonical Task API caps list page size at 50 (must_be_between_1_and_50).
const FETCH_PAGE_LIMIT = 50;
const FETCH_MAX_TASKS = 1000;

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "緊急",
  high: "高",
  medium: "中",
  low: "低",
};

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

// Strip control chars and defang Slack mention / markdown syntax so a task
// title can never turn into an @channel ping or break the canvas layout.
const CANVAS_CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

function sanitize(text: string): string {
  return text
    .replace(CANVAS_CONTROL_CHARS_RE, " ")
    .replace(/[<>]/g, " ")
    .replace(/[*_~`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskLine(task: BrainbaseTask): string {
  const priority = PRIORITY_LABEL[task.priority] ?? sanitize(task.priority);
  const projects = (task.project_codes ?? []).map((code) => `[${sanitize(code)}]`).join(" ");
  const due = task.due_at ? ` 期限: ${task.due_at.slice(0, 10)}` : "";
  const waiting = task.status === "waiting" && task.waiting_on ? ` 待ち: ${sanitize(task.waiting_on)}` : "";
  return `* ${projects ? `${projects} ` : ""}[${priority}] ${sanitize(task.title)}${due}${waiting}`;
}

function sortTasks(tasks: BrainbaseTask[]): BrainbaseTask[] {
  return [...tasks].sort((a, b) => {
    const priorityDelta = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return a.title.localeCompare(b.title);
  });
}

function renderSection(title: string, tasks: BrainbaseTask[], maxPerSection: number, level = 2): string {
  const sorted = sortTasks(tasks);
  const shown = sorted.slice(0, maxPerSection);
  const lines = shown.map(taskLine);
  const omitted = sorted.length - shown.length;
  if (omitted > 0) lines.push(`* …ほか${omitted}件`);
  if (lines.length === 0) lines.push("* なし");
  return `${"#".repeat(level)} ${title}（${sorted.length}件）\n${lines.join("\n")}`;
}

export function renderTaskCanvasMarkdown(
  tasks: BrainbaseTask[],
  options: {
    title?: string;
    maxPerSection?: number;
    nowIso?: string;
    projectCodes?: string[];
    settingsUrl?: string;
  } = {},
): string {
  const title = options.title ?? DEFAULT_TITLE;
  const maxPerSection = options.maxPerSection ?? DEFAULT_MAX_PER_SECTION;
  const projectCodes = options.projectCodes?.map((code) => code.trim()).filter(Boolean);
  if (projectCodes && projectCodes.length === 0) {
    return [
      `# ${title}`,
      "",
      "このチャンネルはprojectが未設定です。タスクを表示するprojectを1つ以上選択してください。",
      options.settingsUrl
        ? `[projectを設定](${options.settingsUrl})`
        : "Manaの管理画面URLが未設定です。管理者に確認してください。",
      "",
    ].join("\n");
  }
  const unique = [...new Map(tasks.map((task) => [task.id, task])).values()];
  const active = unique.filter((task) => task.status !== "completed");
  const completed = unique.filter((task) => task.status === "completed");
  const assignees = new Map<string, BrainbaseTask[]>();
  for (const task of active) {
    const assignee = task.assignee_display_name?.trim() || "未割当";
    assignees.set(assignee, [...(assignees.get(assignee) ?? []), task]);
  }
  const assigneeSections = [...assignees.entries()]
    .sort(([a], [b]) => a === "未割当" ? 1 : b === "未割当" ? -1 : a.localeCompare(b, "ja"))
    .flatMap(([assignee, assigned]) => [
      `## ${sanitize(assignee)}`,
      "",
      renderSection("進行中", assigned.filter((task) => task.status === "in_progress"), maxPerSection, 3),
      "",
      renderSection("保留", assigned.filter((task) => task.status === "waiting"), maxPerSection, 3),
      "",
      renderSection("未着手", assigned.filter((task) => task.status === "pending"), maxPerSection, 3),
      "",
    ]);
  return [
    `# ${title}`,
    "",
    "正本はBrainbase（PostgreSQL）。このcanvasは読み取り専用ミラーで、直接編集しても正本には反映されず次回更新で上書きされます。",
    ...(projectCodes?.length ? [`対象project: ${projectCodes.map(sanitize).join(", ")}`] : []),
    ...(options.settingsUrl ? [`[project設定を変更](${options.settingsUrl})`] : []),
    ...(options.nowIso ? [`最終更新: ${options.nowIso}`] : []),
    "",
    ...assigneeSections,
    `## 完了（累計${completed.length}件）`,
    "",
  ].join("\n");
}

export async function fetchAllTasks(client: BrainbaseTaskClient, projectCodes: string[] = []): Promise<BrainbaseTask[]> {
  const tasks = new Map<string, BrainbaseTask>();
  let cursor: string | undefined;
  while (tasks.size < FETCH_MAX_TASKS) {
    const page = await client.listTasks({
      limit: FETCH_PAGE_LIMIT,
      project_code: projectCodes.length ? projectCodes : undefined,
      cursor,
    });
    for (const task of page.items) tasks.set(task.id, task);
    if (!page.next_cursor || page.items.length === 0) break;
    cursor = page.next_cursor;
  }
  return [...tasks.values()];
}

function loadState(): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistedState;
  } catch {
    return {};
  }
}

function saveState(state: PersistedState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[task-canvas] failed to persist state: ${err}`);
  }
}

function stateKey(channelId?: string): string {
  return channelId || "standalone";
}

function savedCanvasId(state: PersistedState, channelId?: string): string | undefined {
  return state.canvases?.[stateKey(channelId)]
    ?? (state.channelId === channelId ? state.canvasId : undefined);
}

function saveCanvasId(channelId: string | undefined, canvasId: string | null): void {
  const current = loadState();
  const canvases = { ...(current.canvases ?? {}) };
  if (canvasId) canvases[stateKey(channelId)] = canvasId;
  else delete canvases[stateKey(channelId)];
  saveState({ canvases });
}

export function taskCanvasConfigsForPlacements(
  config: TaskCanvasConfig,
  placements: PlacementProfile[] | undefined,
  connectorName: string,
  workspaceId?: string | null,
): TaskCanvasConfig[] {
  if (placements?.length && !workspaceId) return [];
  const matching = (placements ?? []).filter((placement) =>
    placement.enabled !== false
    && placement.taskCanvas?.enabled !== false
    && placement.connector === connectorName
    && placement.workspaceId === workspaceId,
  );
  if (matching.length === 0) return placements?.length ? [] : [{ ...config }];
  const byChannel = new Map<string, Set<string>>();
  for (const placement of matching) {
    const projects = byChannel.get(placement.channelId) ?? new Set<string>();
    for (const project of placement.projects ?? []) {
      const normalized = project.trim();
      if (normalized) projects.add(normalized);
    }
    byChannel.set(placement.channelId, projects);
  }
  return [...byChannel.entries()].map(([channelId, projects]) => ({
    ...config,
    channelId,
    projectCodes: [...projects],
    settingsUrl: buildTaskCanvasProjectSettingsUrl(config.settingsWebBaseUrl, {
      connectorId: connectorName,
      workspaceId,
      channelId,
    }) ?? undefined,
  }));
}

export function placementProjectCodesForChannel(
  placements: PlacementProfile[] | undefined,
  connectorName: string,
  channelId: string,
  workspaceId?: string | null,
): string[] {
  return [...new Set((placements ?? [])
    .filter((placement) =>
      placement.enabled !== false
      && placement.connector === connectorName
      && placement.channelId === channelId
      && Boolean(workspaceId)
      && placement.workspaceId === workspaceId,
    )
    .flatMap((placement) => placement.projects ?? [])
    .map((project) => project.trim())
    .filter(Boolean))];
}

function extractCanvasId(res: Record<string, unknown>): string | null {
  const direct = res.canvas_id;
  if (typeof direct === "string" && direct) return direct;
  const canvas = res.canvas as Record<string, unknown> | undefined;
  const nested = canvas?.id ?? canvas?.canvas_id;
  return typeof nested === "string" && nested ? nested : null;
}

function slackErrorCode(err: unknown): string {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  if (data?.error) return data.error;
  return err instanceof Error ? err.message : String(err);
}

function isCanvasNotFoundError(err: unknown): boolean {
  const code = slackErrorCode(err);
  return code.includes("canvas_not_found") || code.includes("not_found");
}

function isChannelCanvasAlreadyExistsError(err: unknown): boolean {
  return slackErrorCode(err).includes("channel_canvas_already_exists");
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Manages the lifecycle of the Task Board canvas: periodically fetches the
 * canonical task list from Brainbase, renders Markdown, and pushes it to Slack.
 */
export class TaskCanvasUpdater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private canvasId: string | null = null;
  private lastMarkdown: string | null = null;
  private readonly client: SlackClientLike;
  private readonly taskClientFactory: () => BrainbaseTaskClient;
  private readonly config: Required<Omit<TaskCanvasConfig, "channelId" | "enabled" | "projectCodes" | "settingsWebBaseUrl" | "settingsUrl">> & {
    channelId?: string;
    enabled: boolean;
    projectCodes?: string[];
    settingsUrl?: string;
  };

  constructor(app: App, config: TaskCanvasConfig, taskClientFactory?: () => BrainbaseTaskClient) {
    this.client = app.client as unknown as SlackClientLike;
    this.taskClientFactory = taskClientFactory ?? (() => new BrainbaseTaskClient());
    this.config = {
      enabled: config.enabled !== false,
      channelId: config.channelId,
      title: config.title || DEFAULT_TITLE,
      pollIntervalMs: Math.max(MIN_POLL_MS, config.pollIntervalMs ?? DEFAULT_POLL_MS),
      maxPerSection: config.maxPerSection ?? DEFAULT_MAX_PER_SECTION,
      projectCodes: config.projectCodes === undefined
        ? undefined
        : [...new Set(config.projectCodes.map((code) => code.trim()).filter(Boolean))],
      settingsUrl: config.settingsUrl,
    };

    const persisted = loadState();
    this.canvasId = savedCanvasId(persisted, this.config.channelId) ?? null;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info("[task-canvas] disabled by config");
      return;
    }
    if ((this.config.projectCodes === undefined || this.config.projectCodes.length > 0) && !isBrainbaseTaskStoreConfigured()) {
      logger.warn(
        "[task-canvas] Brainbase task store is not configured (BRAINBASE_TASK_API_BASE_URL / BRAINBASE_TASK_API_TOKEN) — mirror not started",
      );
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.consecutiveFailures = 0;
    logger.info(
      `[task-canvas] starting (interval=${this.config.pollIntervalMs}ms, channel=${this.config.channelId || "standalone"})`,
    );
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one mirror pass immediately. Exposed for on-demand refresh + tests. */
  async tick(): Promise<void> {
    if (this.inflight || this.stopped) return;
    this.inflight = true;
    try {
      const tasks = this.config.projectCodes?.length === 0
        ? []
        : await fetchAllTasks(this.taskClientFactory(), this.config.projectCodes);
      const markdown = renderTaskCanvasMarkdown(tasks, {
        title: this.config.title,
        maxPerSection: this.config.maxPerSection,
        projectCodes: this.config.projectCodes,
        settingsUrl: this.config.settingsUrl,
      });
      if (markdown === this.lastMarkdown) {
        this.consecutiveFailures = 0;
        return;
      }
      if (this.stopped) return;
      const published = await this.publish(markdown);
      if (published) {
        this.lastMarkdown = markdown;
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn(
        `[task-canvas] tick failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`,
      );
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `[task-canvas] disabling after ${this.consecutiveFailures} consecutive failures — ` +
            `last error: ${err}. Fix the cause and restart the gateway to re-enable.`,
        );
        this.stop();
      }
    } finally {
      this.inflight = false;
    }
  }

  private async publish(markdown: string): Promise<boolean> {
    if (!this.canvasId) {
      await this.createCanvas(markdown);
      return true;
    }
    try {
      await this.editCanvas(this.canvasId, markdown);
      return true;
    } catch (err) {
      if (isCanvasNotFoundError(err)) {
        logger.warn(`[task-canvas] edit target is gone, will try recreating: ${err}`);
        this.canvasId = null;
        saveCanvasId(this.config.channelId, null);
      } else {
        logger.warn(`[task-canvas] edit failed, keeping existing canvas id to avoid duplicate canvases: ${err}`);
      }
      return false;
    }
  }

  private async createCanvas(markdown: string): Promise<void> {
    const documentContent = { type: "markdown", markdown };
    if (this.config.channelId) {
      try {
        const res = await this.client.apiCall("conversations.canvases.create", {
          channel_id: this.config.channelId,
          document_content: documentContent,
          title: this.config.title,
        });
        const canvasId = extractCanvasId(res);
        if (!canvasId) {
          throw new Error(`conversations.canvases.create returned no canvas_id: ${JSON.stringify(res).slice(0, 200)}`);
        }
        this.canvasId = canvasId;
      } catch (err) {
        if (isChannelCanvasAlreadyExistsError(err)) {
          const existingId = await this.fetchExistingChannelCanvasId(this.config.channelId);
          if (!existingId) {
            throw err;
          }
          logger.info(`[task-canvas] adopting existing channel canvas ${existingId}`);
          this.canvasId = existingId;
          await this.editCanvas(existingId, markdown);
        } else {
          throw err;
        }
      }
    } else {
      const res = await this.client.apiCall("canvases.create", {
        title: this.config.title,
        document_content: documentContent,
      });
      const canvasId = extractCanvasId(res);
      if (!canvasId) {
        throw new Error(`canvases.create returned no canvas_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
      this.canvasId = canvasId;
    }
    saveCanvasId(this.config.channelId, this.canvasId);
    logger.info(`[task-canvas] created canvas ${this.canvasId}`);
  }

  private async fetchExistingChannelCanvasId(channelId: string): Promise<string | null> {
    try {
      const info = await this.client.apiCall("conversations.info", { channel: channelId });
      const channel = info.channel as Record<string, unknown> | undefined;
      const properties = channel?.properties as Record<string, unknown> | undefined;
      const canvas = properties?.canvas as Record<string, unknown> | undefined;
      const id = canvas?.file_id ?? canvas?.id;
      return typeof id === "string" && id ? id : null;
    } catch (err) {
      logger.warn(`[task-canvas] failed to fetch existing channel canvas: ${err}`);
      return null;
    }
  }

  private async editCanvas(canvasId: string, markdown: string): Promise<void> {
    await this.client.apiCall("canvases.edit", {
      canvas_id: canvasId,
      changes: [
        {
          operation: "replace",
          document_content: { type: "markdown", markdown },
        },
      ],
    });
  }
}
