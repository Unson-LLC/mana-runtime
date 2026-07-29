/**
 * Task due-date reminder for Slack — watches the canonical Brainbase task
 * store (source of truth: Brainbase PostgreSQL) and posts a notification to a
 * Slack channel when an open task approaches or passes its due date.
 *
 * Notifications are once-per-state: each task is notified at most once per
 * (due_at, kind) where kind is "due_soon" or "overdue". Changing a task's due
 * date re-arms both notifications; a task that was notified as due_soon is
 * notified again when it crosses into overdue. Notified state is persisted
 * under `${JINN_HOME}/.task-reminder-state.json` so restarts do not re-ping.
 *
 * Lifecycle: started by SlackConnector when `taskReminder.enabled === true`.
 * Polls the Brainbase task API every `checkIntervalMs` (default 30 min).
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import {
  BrainbaseTaskClient,
  isBrainbaseTaskStoreConfigured,
  type BrainbaseTask,
} from "../../shared/brainbase-tasks.js";
import { fetchAllTasks } from "./task-canvas.js";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export interface TaskReminderConfig {
  enabled?: boolean;
  /** Slack channel ID to post reminders into. Required. */
  channelId?: string;
  /** Polling interval in ms. Default 30 min. */
  checkIntervalMs?: number;
  /** How many hours before due_at a task counts as "due soon". Default 24. */
  dueSoonHours?: number;
}

export type ReminderKind = "due_soon" | "overdue";

interface NotifiedEntry {
  dueAt: string;
  kind: ReminderKind;
}

type PersistedState = Record<string, NotifiedEntry>;

const STATE_FILE = path.join(JINN_HOME, ".task-reminder-state.json");
const DEFAULT_CHECK_MS = 1_800_000;
const MIN_CHECK_MS = 60_000;
const DEFAULT_DUE_SOON_HOURS = 24;
const MAX_CONSECUTIVE_FAILURES = 10;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const OPEN_STATUSES = new Set(["pending", "in_progress", "waiting"]);

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "緊急",
  high: "高",
  medium: "中",
  low: "低",
};

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// Strip control chars and defang Slack mention syntax so a task title can
// never turn into an @channel ping.
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

export interface DueTaskEntry {
  task: BrainbaseTask;
  kind: ReminderKind;
}

/** Classifies open tasks with a due date into overdue / due-soon buckets. */
export function classifyDueTasks(
  tasks: BrainbaseTask[],
  now: number,
  dueSoonHours: number,
): DueTaskEntry[] {
  const entries: DueTaskEntry[] = [];
  for (const task of tasks) {
    if (!OPEN_STATUSES.has(task.status) || !task.due_at) continue;
    const due = Date.parse(task.due_at);
    if (Number.isNaN(due)) continue;
    if (due < now) {
      entries.push({ task, kind: "overdue" });
    } else if (due <= now + dueSoonHours * HOUR_MS) {
      entries.push({ task, kind: "due_soon" });
    }
  }
  return entries;
}

function taskLine(entry: DueTaskEntry, now: number): string {
  const { task, kind } = entry;
  const priority = PRIORITY_LABEL[task.priority] ?? sanitize(task.priority);
  const due = Date.parse(task.due_at!);
  const dueDate = task.due_at!.slice(0, 10);
  const relative =
    kind === "overdue"
      ? `${Math.max(1, Math.ceil((now - due) / DAY_MS))}日超過`
      : `あと${Math.max(1, Math.round((due - now) / HOUR_MS))}時間`;
  return `• [${priority}] ${sanitize(task.title)} — 期限 ${dueDate}（${relative}）`;
}

/** Renders the Slack message text. Returns null when there is nothing to say. */
export function renderReminderMessage(entries: DueTaskEntry[], now: number): string | null {
  if (entries.length === 0) return null;
  const overdue = entries.filter((entry) => entry.kind === "overdue");
  const dueSoon = entries.filter((entry) => entry.kind === "due_soon");
  const byDue = (a: DueTaskEntry, b: DueTaskEntry) => a.task.due_at!.localeCompare(b.task.due_at!);
  const sections: string[] = ["⏰ *タスク期限リマインド*（正本: Brainbaseタスクボード）"];
  if (overdue.length > 0) {
    sections.push(
      `*期限超過（${overdue.length}件）*\n${overdue.sort(byDue).map((e) => taskLine(e, now)).join("\n")}`,
    );
  }
  if (dueSoon.length > 0) {
    sections.push(
      `*期限接近（${dueSoon.length}件）*\n${dueSoon.sort(byDue).map((e) => taskLine(e, now)).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function loadState(): PersistedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state: PersistedState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[task-reminder] failed to persist state: ${err}`);
  }
}

/** overdue supersedes due_soon: notifying overdue also covers due_soon. */
function alreadyNotified(entry: NotifiedEntry | undefined, dueAt: string, kind: ReminderKind): boolean {
  if (!entry || entry.dueAt !== dueAt) return false;
  return entry.kind === kind || entry.kind === "overdue";
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Polls the canonical task store and posts due-date reminders to Slack.
 */
export class TaskReminderNotifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private readonly client: SlackClientLike;
  private readonly taskClientFactory: () => BrainbaseTaskClient;
  private readonly config: {
    enabled: boolean;
    channelId?: string;
    checkIntervalMs: number;
    dueSoonHours: number;
  };

  constructor(app: App, config: TaskReminderConfig, taskClientFactory?: () => BrainbaseTaskClient) {
    this.client = app.client as unknown as SlackClientLike;
    this.taskClientFactory = taskClientFactory ?? (() => new BrainbaseTaskClient());
    this.config = {
      enabled: config.enabled !== false,
      channelId: config.channelId,
      checkIntervalMs: Math.max(MIN_CHECK_MS, config.checkIntervalMs ?? DEFAULT_CHECK_MS),
      dueSoonHours: config.dueSoonHours ?? DEFAULT_DUE_SOON_HOURS,
    };
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info("[task-reminder] disabled by config");
      return;
    }
    if (!this.config.channelId) {
      logger.warn("[task-reminder] no channelId configured — reminders not started");
      return;
    }
    if (!isBrainbaseTaskStoreConfigured()) {
      logger.warn(
        "[task-reminder] Brainbase task store is not configured (BRAINBASE_TASK_API_BASE_URL / BRAINBASE_TASK_API_TOKEN) — reminders not started",
      );
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.consecutiveFailures = 0;
    logger.info(
      `[task-reminder] starting (interval=${this.config.checkIntervalMs}ms, channel=${this.config.channelId}, dueSoonHours=${this.config.dueSoonHours})`,
    );
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one reminder pass immediately. Exposed for tests. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.inflight || this.stopped) return;
    this.inflight = true;
    try {
      const tasks = await fetchAllTasks(this.taskClientFactory());
      const entries = classifyDueTasks(tasks, now, this.config.dueSoonHours);
      const state = loadState();

      const fresh = entries.filter(
        (entry) => !alreadyNotified(state[entry.task.id], entry.task.due_at!, entry.kind),
      );
      const message = renderReminderMessage(fresh, now);
      if (message && !this.stopped) {
        await this.client.apiCall("chat.postMessage", {
          channel: this.config.channelId!,
          text: message,
          unfurl_links: false,
        });
        for (const entry of fresh) {
          state[entry.task.id] = { dueAt: entry.task.due_at!, kind: entry.kind };
        }
      }

      // Drop state for tasks that are no longer in a reminder-worthy window
      // (completed, deleted, or due date pushed out) so a future due date
      // re-arms notification.
      const active = new Set(entries.map((entry) => entry.task.id));
      let pruned = false;
      for (const id of Object.keys(state)) {
        if (!active.has(id)) {
          delete state[id];
          pruned = true;
        }
      }
      if ((message && fresh.length > 0) || pruned) saveState(state);
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      logger.warn(
        `[task-reminder] tick failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`,
      );
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `[task-reminder] disabling after ${this.consecutiveFailures} consecutive failures — ` +
            `last error: ${err}. Fix the cause and restart the gateway to re-enable.`,
        );
        this.stop();
      }
    } finally {
      this.inflight = false;
    }
  }
}
