/**
 * Meeting minutes → task extraction → default registration → Slack undo/edit.
 *
 * Ported from mana's `meeting-flow-integration.js` design onto mana-runtime
 * conventions, then inverted from approve-first to register-first (operator
 * decision 2026-07-30): extracted candidates are registered into the
 * canonical Brainbase task store immediately, and the Slack message offers
 * 取り消し (delete) and 編集 (modal) per task instead of an approval gate.
 * Registration is idempotent per candidate via the deterministic key
 * `meeting:<channelId>:<sourceTs>:<index>`, so retries never double-register.
 *
 * Assignees are resolved from Graph SSOT person entities (names/aliases) at
 * registration time — best-effort and fail-open. The edit modal's assignee
 * select is populated from the same Graph list, which makes this the first
 * runtime Graph consumer (roadmap pillar 2).
 *
 * Proposal context is persisted under `${JINN_HOME}/.meeting-task-proposals.json`
 * with a 72h TTL (mana used DynamoDB TTL for the same window). Expired
 * proposals reject button presses instead of reconstructing state from blocks
 * — mana's blocks-fallback path could double-register and is not ported.
 *
 * Registered by SlackConnector before app.start(). The connector's own
 * message handler drops bot messages, so this module registers its own
 * `app.message` listener (Bolt runs all matching listeners; the app's own
 * posts are already dropped by Bolt's default ignoreSelf middleware).
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import {
  BrainbaseTaskClient,
  isBrainbaseTaskStoreConfigured,
} from "../../shared/brainbase-tasks.js";
import {
  GraphPeopleClient,
  resolvePersonByName,
  type GraphPerson,
} from "../../shared/brainbase-graph.js";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import {
  extractMeetingTaskCandidates,
  type ExtractMeetingTasksOptions,
  type MeetingTaskCandidate,
} from "./meeting-task-extractor.js";

export interface MeetingTaskProposalConfig {
  /** Master switch — defaults to false when the block is absent. */
  enabled?: boolean;
  /** Channel IDs to watch. Required; empty means the feature stays off. */
  channels?: string[];
  /**
   * Slack user IDs allowed to cancel/edit registered tasks. The connector
   * falls back to its allowFrom list when unset. Empty keeps the feature off.
   */
  approverUserIds?: string[];
  /** Minimum message length to consider as minutes. Default 200. */
  minMessageChars?: number;
  /** Proposal context lifetime in hours. Default 72 (mana's M11 window). */
  ttlHours?: number;
  /** LLM extraction overrides (engine/bin/model/timeoutMs). */
  engine?: "claude" | "codex";
  bin?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Who may cancel/edit registered tasks. The static implementation covers the
 * pilot (operator only); the interface is the extension point for resolving
 * approvers from Graph SSOT RACI (roadmap pillar 2).
 */
export interface ApproverResolver {
  canApprove(userId: string, channelId: string): Promise<boolean>;
}

export class StaticApproverResolver implements ApproverResolver {
  private readonly userIds: Set<string>;
  constructor(userIds: string[]) {
    this.userIds = new Set(userIds.filter(Boolean));
  }
  get size(): number {
    return this.userIds.size;
  }
  async canApprove(userId: string): Promise<boolean> {
    return this.userIds.has(userId);
  }
}

/**
 * pending  — extraction produced the candidate but registration failed
 *            (canonical store unreachable etc.); a retry button is shown.
 * registered — task exists in the canonical store (default outcome).
 * removed  — operator pressed 取り消し and the task was deleted.
 */
export type CandidateStatus = "pending" | "registered" | "removed";

export interface StoredCandidate extends MeetingTaskCandidate {
  index: number;
  status: CandidateStatus;
  /** Canonical task id once registered. */
  taskId?: string;
  /** Graph person resolved from the minutes assignee name, when unambiguous. */
  assigneePersonId?: string;
  assigneePersonName?: string;
}

export interface StoredProposal {
  channelId: string;
  /** ts of the source minutes message — part of the idempotency key. */
  sourceTs: string;
  /** ts of our posted message (chat.update target). */
  proposalTs: string;
  createdAt: number;
  expiresAt: number;
  candidates: StoredCandidate[];
}

type PersistedState = Record<string, StoredProposal>;

const STATE_FILE = path.join(JINN_HOME, ".meeting-task-proposals.json");
const DEFAULT_MIN_MESSAGE_CHARS = 200;
const DEFAULT_TTL_HOURS = 72;
const HOUR_MS = 3_600_000;

export const ACTION_CANCEL = "meeting_task_cancel";
export const ACTION_EDIT = "meeting_task_edit";
export const ACTION_RETRY = "meeting_task_retry";
export const ACTION_CANCEL_ALL = "meeting_task_cancel_all";
export const EDIT_VIEW_CALLBACK_ID = "meeting_task_edit_submit";
const ASSIGNEE_NONE = "__none__";

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// Same defanging rule as task-reminder: LLM-derived text must never become
// an @channel ping or smuggle mrkdwn link syntax.
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
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
    logger.warn(`[meeting-task-proposal] failed to persist state: ${err}`);
  }
}

function pruneExpired(state: PersistedState, now: number): boolean {
  let pruned = false;
  for (const key of Object.keys(state)) {
    if (state[key].expiresAt <= now) {
      delete state[key];
      pruned = true;
    }
  }
  return pruned;
}

export function proposalKey(channelId: string, sourceTs: string): string {
  return `${channelId}:${sourceTs}`;
}

/** Deterministic idempotency key — `meeting:` avoids the reserved `api:`/`workflow:` prefixes. */
export function candidateIdempotencyKey(proposal: StoredProposal, index: number): string {
  return `meeting:${proposal.channelId}:${proposal.sourceTs}:${index}`;
}

/**
 * Renders the message blocks from stored state. Re-rendered in full after
 * every cancel/edit (chat.update), so buttons always reflect current status.
 */
export function buildProposalBlocks(proposal: StoredProposal): unknown[] {
  const registered = proposal.candidates.filter((c) => c.status === "registered");
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📋 *議事録から${proposal.candidates.length}件のタスクを正本に登録しました* — 間違いは取り消し/編集できます`,
      },
    },
    { type: "divider" },
  ];

  for (const candidate of proposal.candidates) {
    const value = JSON.stringify({
      key: proposalKey(proposal.channelId, proposal.sourceTs),
      index: candidate.index,
    });
    const statusPrefix =
      candidate.status === "registered" ? "✅" : candidate.status === "removed" ? "🗑" : "⚠️";
    const lines = [
      `${statusPrefix} *${sanitize(candidate.title)}*` +
        (candidate.status === "removed"
          ? " — _取り消し済み_"
          : candidate.status === "pending"
            ? " — _登録失敗（再試行できます）_"
            : ""),
    ];
    const meta: string[] = [];
    const assigneeLabel = candidate.assigneePersonName ?? candidate.assignee;
    if (assigneeLabel && assigneeLabel !== "未定") meta.push(`担当: ${sanitize(assigneeLabel)}`);
    if (candidate.due) meta.push(`期限: ${candidate.due}`);
    if (meta.length > 0) lines.push(meta.join(" | "));
    if (candidate.context) lines.push(`_${sanitize(candidate.context)}_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
    if (candidate.status === "registered") {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "編集" },
            action_id: ACTION_EDIT,
            value,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "取り消し" },
            action_id: ACTION_CANCEL,
            value,
            confirm: {
              title: { type: "plain_text", text: "タスクの取り消し" },
              text: { type: "plain_text", text: "正本タスクボードから削除します。よろしいですか？" },
              confirm: { type: "plain_text", text: "削除する" },
              deny: { type: "plain_text", text: "やめる" },
            },
          },
        ],
      });
    } else if (candidate.status === "pending") {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "登録を再試行" },
            action_id: ACTION_RETRY,
            value,
          },
        ],
      });
    }
  }

  if (registered.length > 1) {
    const value = JSON.stringify({ key: proposalKey(proposal.channelId, proposal.sourceTs) });
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: `全取り消し（${registered.length}件）` },
          action_id: ACTION_CANCEL_ALL,
          value,
          confirm: {
            title: { type: "plain_text", text: "全タスクの取り消し" },
            text: { type: "plain_text", text: "登録済みの全タスクを正本から削除します。よろしいですか？" },
            confirm: { type: "plain_text", text: "全て削除する" },
            deny: { type: "plain_text", text: "やめる" },
          },
        },
      ],
    });
  }

  return blocks;
}

/** Plain-text fallback for notifications (Slack requires text alongside blocks). */
export function proposalFallbackText(proposal: StoredProposal): string {
  return `議事録から${proposal.candidates.length}件のタスクを登録しました`;
}

/** Builds the edit modal view. People list may be empty (Graph unavailable). */
export function buildEditModalView(
  proposal: StoredProposal,
  candidate: StoredCandidate,
  people: GraphPerson[],
): Record<string, unknown> {
  const options = [
    { text: { type: "plain_text", text: "（担当なし）" }, value: ASSIGNEE_NONE },
    ...people.slice(0, 99).map((person) => ({
      text: { type: "plain_text", text: person.name.slice(0, 75) },
      value: person.id,
    })),
  ];
  const initialOption = candidate.assigneePersonId
    ? options.find((o) => o.value === candidate.assigneePersonId)
    : undefined;
  const blocks: unknown[] = [
    {
      type: "input",
      block_id: "title",
      label: { type: "plain_text", text: "タイトル" },
      element: {
        type: "plain_text_input",
        action_id: "value",
        initial_value: candidate.title,
        max_length: 120,
      },
    },
    {
      type: "input",
      block_id: "due",
      optional: true,
      label: { type: "plain_text", text: "期限" },
      element: {
        type: "datepicker",
        action_id: "value",
        ...(candidate.due ? { initial_date: candidate.due } : {}),
      },
    },
  ];
  if (options.length > 1) {
    blocks.push({
      type: "input",
      block_id: "assignee",
      optional: true,
      label: { type: "plain_text", text: "担当者（Graph SSOT）" },
      element: {
        type: "static_select",
        action_id: "value",
        options,
        ...(initialOption ? { initial_option: initialOption } : {}),
      },
    });
  }
  return {
    type: "modal",
    callback_id: EDIT_VIEW_CALLBACK_ID,
    private_metadata: JSON.stringify({
      key: proposalKey(proposal.channelId, proposal.sourceTs),
      index: candidate.index,
    }),
    title: { type: "plain_text", text: "タスクを編集" },
    submit: { type: "plain_text", text: "保存" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks,
  };
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MeetingTaskProposalDeps {
  taskClientFactory?: () => BrainbaseTaskClient;
  peopleClient?: GraphPeopleClient;
  extractImpl?: (
    transcript: string,
    projectName?: string,
    options?: ExtractMeetingTasksOptions,
  ) => Promise<MeetingTaskCandidate[]>;
  approverResolver?: ApproverResolver;
  projectCodesForChannel?: (channelId: string) => string[];
}

export class MeetingTaskProposalNotifier {
  private readonly client: SlackClientLike;
  private readonly app: App;
  private readonly channels: Set<string>;
  private readonly approvers: ApproverResolver;
  private readonly minMessageChars: number;
  private readonly ttlMs: number;
  private readonly extractOptions: ExtractMeetingTasksOptions;
  private readonly extractImpl: NonNullable<MeetingTaskProposalDeps["extractImpl"]>;
  private readonly taskClientFactory: () => BrainbaseTaskClient;
  private readonly peopleClient: GraphPeopleClient;
  private readonly enabled: boolean;
  private readonly projectCodesForChannel: (channelId: string) => string[];
  private readonly bootTimeMs = Date.now();
  private active = false;

  constructor(app: App, config: MeetingTaskProposalConfig, fallbackApprovers: string[], deps: MeetingTaskProposalDeps = {}) {
    this.app = app;
    this.client = app.client as unknown as SlackClientLike;
    this.channels = new Set((config.channels ?? []).filter(Boolean));
    const approverIds = (config.approverUserIds?.length ? config.approverUserIds : fallbackApprovers).filter(Boolean);
    this.approvers = deps.approverResolver ?? new StaticApproverResolver(approverIds);
    this.minMessageChars = config.minMessageChars ?? DEFAULT_MIN_MESSAGE_CHARS;
    this.ttlMs = (config.ttlHours ?? DEFAULT_TTL_HOURS) * HOUR_MS;
    this.extractOptions = {
      engine: config.engine,
      bin: config.bin,
      model: config.model,
      timeoutMs: config.timeoutMs,
    };
    this.extractImpl = deps.extractImpl ?? extractMeetingTaskCandidates;
    this.taskClientFactory = deps.taskClientFactory ?? (() => new BrainbaseTaskClient());
    this.peopleClient = deps.peopleClient ?? new GraphPeopleClient();
    this.enabled = config.enabled === true;
    this.projectCodesForChannel = deps.projectCodesForChannel ?? (() => []);
  }

  /**
   * Registers Bolt listeners. Must be called before app.start(). All gates
   * fail closed: no channels or no approvers means the feature stays off.
   */
  register(): void {
    if (!this.enabled) {
      logger.info("[meeting-task-proposal] disabled by config");
      return;
    }
    if (this.channels.size === 0) {
      logger.warn("[meeting-task-proposal] no channels configured — feature not started");
      return;
    }
    if (this.approvers instanceof StaticApproverResolver && this.approvers.size === 0) {
      logger.warn("[meeting-task-proposal] no approvers configured — feature not started");
      return;
    }
    if (!isBrainbaseTaskStoreConfigured()) {
      logger.warn(
        "[meeting-task-proposal] Brainbase task store is not configured (BRAINBASE_TASK_API_BASE_URL / BRAINBASE_TASK_API_TOKEN) — feature not started",
      );
      return;
    }

    this.active = true;
    logger.info(
      `[meeting-task-proposal] starting (channels=${[...this.channels].join(",")}, mode=register-first)`,
    );

    this.app.message(async ({ event }) => {
      try {
        await this.maybeHandleMessage(event as unknown as Record<string, unknown>);
      } catch (err) {
        logger.warn(`[meeting-task-proposal] message handling failed: ${err}`);
      }
    });

    const wrap = (fn: (body: any, action: any) => Promise<void>) => async ({ ack, body, action }: any) => {
      await ack();
      await fn(body, action).catch((err) => {
        logger.warn(`[meeting-task-proposal] action handling failed: ${err}`);
      });
    };
    this.app.action(ACTION_CANCEL, wrap((body, action) => this.handleCancelAction(body, action)));
    this.app.action(ACTION_RETRY, wrap((body, action) => this.handleRetryAction(body, action)));
    this.app.action(ACTION_CANCEL_ALL, wrap((body, action) => this.handleCancelAllAction(body, action)));
    this.app.action(ACTION_EDIT, wrap((body, action) => this.handleEditOpenAction(body, action)));
    this.app.view(EDIT_VIEW_CALLBACK_ID, async ({ ack, body, view }: any) => {
      await ack();
      await this.handleEditSubmit(body, view).catch((err) => {
        logger.warn(`[meeting-task-proposal] edit submit failed: ${err}`);
      });
    });
  }

  stop(): void {
    this.active = false;
  }

  /** Exposed for tests: detection gates + extraction + default registration. */
  async maybeHandleMessage(event: Record<string, unknown>, now: number = Date.now()): Promise<void> {
    if (!this.active) return;
    const channel = event.channel as string | undefined;
    const ts = event.ts as string | undefined;
    if (!channel || !ts || !this.channels.has(channel)) return;
    // Message edits/deletes and other subtypes never carry fresh minutes.
    // bot_message subtype is fine — mana posts minutes as a bot.
    const subtype = event.subtype as string | undefined;
    if (subtype && subtype !== "bot_message" && subtype !== "thread_broadcast") return;
    // File-share posts are mana's own trigger (.txt upload) — skipping them
    // keeps the two pipelines from firing on the same event.
    if (Array.isArray(event.files) && event.files.length > 0) return;
    // Ignore messages predating boot (Slack redelivers on reconnect).
    const tsMs = Number.parseFloat(ts) * 1000;
    if (Number.isFinite(tsMs) && tsMs < this.bootTimeMs - 60_000) return;

    const text = ((event.text as string) || "").trim();
    if (text.length < this.minMessageChars) return;

    await this.processMinutes(channel, ts, (event.thread_ts as string) ?? ts, text, now);
  }

  /**
   * Direct entry point for minutes this bot posted itself (the meeting-minutes
   * pipeline hands off here — Bolt's ignoreSelf hides our own posts from the
   * message listener above). Skips the channel/subtype gates but keeps the
   * state-file idempotency, so a redelivered handoff never double-registers.
   * Requires the feature to be registered and active.
   */
  async processMinutesText(
    channel: string,
    ts: string,
    text: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    if (!this.active) {
      logger.warn("[meeting-task-proposal] handoff ignored — feature not active");
      return false;
    }
    await this.processMinutes(channel, ts, ts, text, now);
    return true;
  }

  private async processMinutes(
    channel: string,
    ts: string,
    threadTs: string,
    text: string,
    now: number,
  ): Promise<void> {
    const state = loadState();
    const pruned = pruneExpired(state, now);
    const key = proposalKey(channel, ts);
    if (state[key]) {
      if (pruned) saveState(state);
      return; // already handled for this message (Slack retry)
    }

    const candidates = await this.extractImpl(text, undefined, this.extractOptions);
    if (candidates.length === 0) {
      logger.info(`[meeting-task-proposal] no candidates extracted for ${key}`);
      if (pruned) saveState(state);
      return;
    }

    const proposal: StoredProposal = {
      channelId: channel,
      sourceTs: ts,
      proposalTs: "",
      createdAt: now,
      expiresAt: now + this.ttlMs,
      candidates: candidates.map((candidate, index) => ({ ...candidate, index, status: "pending" })),
    };

    // Best-effort Graph assignee resolution — [] when Graph is unavailable.
    const people = await this.peopleClient.listPeople();
    let registeredCount = 0;
    for (const candidate of proposal.candidates) {
      const person = candidate.assignee !== "未定" ? resolvePersonByName(people, candidate.assignee) : null;
      if (person) {
        candidate.assigneePersonId = person.id;
        candidate.assigneePersonName = person.name;
      }
      try {
        await this.registerCandidate(proposal, candidate);
        registeredCount++;
      } catch (err) {
        logger.warn(
          `[meeting-task-proposal] registration failed for ${key}#${candidate.index}: ${err}`,
        );
      }
    }

    const result = await this.client.apiCall("chat.postMessage", {
      channel,
      thread_ts: threadTs,
      text: proposalFallbackText(proposal),
      blocks: buildProposalBlocks(proposal),
      unfurl_links: false,
    });
    proposal.proposalTs = (result.ts as string) ?? "";

    // Re-load: the awaits above could interleave with a button handler
    // writing the file.
    const fresh = loadState();
    pruneExpired(fresh, now);
    fresh[key] = proposal;
    saveState(fresh);
    logger.info(
      `[meeting-task-proposal] registered ${registeredCount}/${candidates.length} task(s) for ${key}`,
    );
  }

  private parseActionValue(action: any): { key: string; index?: number } | null {
    try {
      const parsed = JSON.parse(action?.value ?? "");
      if (parsed && typeof parsed.key === "string") return parsed;
    } catch {
      /* fall through */
    }
    return null;
  }

  private async notifyEphemeral(body: any, message: string): Promise<void> {
    const channel = body?.channel?.id ?? body?.container?.channel_id;
    const user = body?.user?.id;
    if (!channel || !user) return;
    try {
      await this.client.apiCall("chat.postEphemeral", { channel, user, text: message });
    } catch (err) {
      logger.warn(`[meeting-task-proposal] ephemeral notice failed: ${err}`);
    }
  }

  private async loadAuthorizedProposal(
    body: any,
    value: { key: string } | null,
  ): Promise<{ state: PersistedState; key: string; proposal: StoredProposal } | null> {
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    if (!value || !userId) return null;
    if (!(await this.approvers.canApprove(userId, channelId ?? ""))) {
      logger.warn(`[meeting-task-proposal] unauthorized action from ${userId}`);
      await this.notifyEphemeral(body, "この操作の権限がありません。");
      return null;
    }
    const state = loadState();
    pruneExpired(state, Date.now());
    const proposal = state[value.key];
    if (!proposal) {
      await this.notifyEphemeral(body, "この提案は期限切れです（72時間）。タスクボード上で直接操作してください。");
      return null;
    }
    return { state, key: value.key, proposal };
  }

  private async registerCandidate(proposal: StoredProposal, candidate: StoredCandidate): Promise<void> {
    const client = this.taskClientFactory();
    const descriptionParts = [
      candidate.context,
      `担当（議事録記載）: ${candidate.assignee}`,
      `出典: 議事録 ${proposal.channelId}/${proposal.sourceTs}`,
    ];
    const task = await client.createTask(
      {
        title: candidate.title,
        description: descriptionParts.filter(Boolean).join("\n"),
        ...(candidate.assigneePersonId ? { assignee_person_id: candidate.assigneePersonId } : {}),
        ...(candidate.due ? { due_at: `${candidate.due}T00:00:00+09:00` } : {}),
        project_codes: this.projectCodesForChannel(proposal.channelId),
      },
      candidateIdempotencyKey(proposal, candidate.index),
    );
    candidate.status = "registered";
    candidate.taskId = task.id;
  }

  private async deleteCandidateTask(candidate: StoredCandidate): Promise<void> {
    if (!candidate.taskId) return;
    const client = this.taskClientFactory();
    const task = await client.getTask(candidate.taskId);
    await client.deleteTask(candidate.taskId, task.version);
    candidate.status = "removed";
  }

  private async updateProposalMessage(proposal: StoredProposal): Promise<void> {
    if (!proposal.proposalTs) return;
    await this.client.apiCall("chat.update", {
      channel: proposal.channelId,
      ts: proposal.proposalTs,
      text: proposalFallbackText(proposal),
      blocks: buildProposalBlocks(proposal),
    });
  }

  /** Exposed for tests. */
  async handleCancelAction(body: any, action: any): Promise<void> {
    const value = this.parseActionValue(action);
    const loaded = await this.loadAuthorizedProposal(body, value);
    if (!loaded) return;
    const { state, proposal } = loaded;
    const candidate = proposal.candidates.find((c) => c.index === value!.index);
    if (!candidate || candidate.status !== "registered") return;
    try {
      await this.deleteCandidateTask(candidate);
    } catch (err) {
      logger.warn(`[meeting-task-proposal] task deletion failed: ${err}`);
      await this.notifyEphemeral(body, `タスクの取り消しに失敗しました: ${err}`);
      return;
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
  }

  /** Exposed for tests. */
  async handleRetryAction(body: any, action: any): Promise<void> {
    const value = this.parseActionValue(action);
    const loaded = await this.loadAuthorizedProposal(body, value);
    if (!loaded) return;
    const { state, proposal } = loaded;
    const candidate = proposal.candidates.find((c) => c.index === value!.index);
    if (!candidate || candidate.status !== "pending") return;
    try {
      await this.registerCandidate(proposal, candidate);
    } catch (err) {
      logger.warn(`[meeting-task-proposal] retry registration failed: ${err}`);
      await this.notifyEphemeral(body, `タスク登録に失敗しました: ${err}。もう一度押すと再試行します（二重登録はされません）。`);
      return;
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
  }

  /** Exposed for tests. */
  async handleCancelAllAction(body: any, action: any): Promise<void> {
    const value = this.parseActionValue(action);
    const loaded = await this.loadAuthorizedProposal(body, value);
    if (!loaded) return;
    const { state, proposal } = loaded;
    const failures: string[] = [];
    for (const candidate of proposal.candidates) {
      if (candidate.status !== "registered") continue;
      try {
        await this.deleteCandidateTask(candidate);
      } catch (err) {
        failures.push(`${candidate.title}: ${err}`);
      }
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
    if (failures.length > 0) {
      await this.notifyEphemeral(
        body,
        `一部のタスク取り消しに失敗しました（${failures.length}件）。\n${failures.join("\n")}`,
      );
    }
  }

  /** Exposed for tests. Opens the edit modal. */
  async handleEditOpenAction(body: any, action: any): Promise<void> {
    const value = this.parseActionValue(action);
    const loaded = await this.loadAuthorizedProposal(body, value);
    if (!loaded) return;
    const { proposal } = loaded;
    const candidate = proposal.candidates.find((c) => c.index === value!.index);
    if (!candidate || candidate.status !== "registered") return;
    const triggerId = body?.trigger_id as string | undefined;
    if (!triggerId) return;
    const people = await this.peopleClient.listPeople();
    await this.client.apiCall("views.open", {
      trigger_id: triggerId,
      view: buildEditModalView(proposal, candidate, people),
    });
  }

  /** Exposed for tests. Applies the edit modal submission to the canonical task. */
  async handleEditSubmit(body: any, view: any): Promise<void> {
    let meta: { key: string; index?: number } | null = null;
    try {
      meta = JSON.parse(view?.private_metadata ?? "");
    } catch {
      return;
    }
    if (!meta || typeof meta.key !== "string") return;
    const userId = body?.user?.id as string | undefined;
    if (!userId || !(await this.approvers.canApprove(userId, ""))) {
      logger.warn(`[meeting-task-proposal] unauthorized edit submit from ${userId}`);
      return;
    }
    const state = loadState();
    pruneExpired(state, Date.now());
    const proposal = state[meta.key];
    const candidate = proposal?.candidates.find((c) => c.index === meta!.index);
    if (!proposal || !candidate || candidate.status !== "registered" || !candidate.taskId) return;

    const values = view?.state?.values ?? {};
    const newTitle = (values.title?.value?.value as string | undefined)?.trim();
    const newDue = (values.due?.value?.selected_date as string | undefined) || null;
    const assigneeSelection = values.assignee?.value?.selected_option?.value as string | undefined;

    const client = this.taskClientFactory();
    try {
      const current = await client.getTask(candidate.taskId);
      await client.updateTask(candidate.taskId, {
        expected_version: current.version,
        ...(newTitle ? { title: newTitle } : {}),
        ...(newDue ? { due_at: `${newDue}T00:00:00+09:00` } : {}),
        ...(assigneeSelection === ASSIGNEE_NONE
          ? { assignee_person_id: null }
          : assigneeSelection
            ? { assignee_person_id: assigneeSelection }
            : {}),
      });
    } catch (err) {
      logger.warn(`[meeting-task-proposal] task update failed: ${err}`);
      await this.notifyEphemeral(
        { user: { id: userId }, channel: { id: proposal.channelId } },
        `タスクの更新に失敗しました: ${err}`,
      );
      return;
    }

    if (newTitle) candidate.title = newTitle;
    candidate.due = newDue;
    if (assigneeSelection === ASSIGNEE_NONE) {
      candidate.assigneePersonId = undefined;
      candidate.assigneePersonName = undefined;
    } else if (assigneeSelection) {
      candidate.assigneePersonId = assigneeSelection;
      const people = await this.peopleClient.listPeople();
      candidate.assigneePersonName =
        people.find((p) => p.id === assigneeSelection)?.name ?? candidate.assigneePersonName;
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
  }
}
