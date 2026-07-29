/**
 * Meeting minutes → task-candidate proposal → one-tap registration.
 *
 * Ported from mana's `meeting-flow-integration.js` design onto mana-runtime
 * conventions. Watches allowlisted Slack channels for posted meeting minutes
 * (typically another bot — mana — posting the minutes text), extracts task
 * candidates with an LLM, proposes them as Slack Blocks with approve/reject
 * buttons, and registers approved candidates into the canonical Brainbase
 * task store (companion API) with a deterministic idempotency key
 * `meeting:<channelId>:<sourceTs>:<index>`.
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
   * Slack user IDs allowed to press approve/reject. The connector falls back
   * to its allowFrom list when unset. Empty means the feature stays off.
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
 * Who may approve proposals. The static implementation covers the pilot
 * (operator only); the interface is the extension point for resolving
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

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface StoredCandidate extends MeetingTaskCandidate {
  index: number;
  status: CandidateStatus;
  /** Canonical task id once approved and registered. */
  taskId?: string;
}

export interface StoredProposal {
  channelId: string;
  /** ts of the source minutes message — part of the idempotency key. */
  sourceTs: string;
  /** ts of our posted proposal message (chat.update target). */
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

export const ACTION_APPROVE = "meeting_task_approve";
export const ACTION_REJECT = "meeting_task_reject";
export const ACTION_APPROVE_ALL = "meeting_task_approve_all";
export const ACTION_REJECT_ALL = "meeting_task_reject_all";

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

const STATUS_SUFFIX: Record<CandidateStatus, string> = {
  pending: "",
  approved: " — ✅ _登録済み_",
  rejected: " — ❌ _却下済み_",
};

/**
 * Renders the proposal message blocks from stored state. Re-rendered in full
 * on every approval/rejection (chat.update), so buttons for settled
 * candidates disappear and bulk buttons vanish once nothing is pending.
 */
export function buildProposalBlocks(proposal: StoredProposal): unknown[] {
  const pending = proposal.candidates.filter((c) => c.status === "pending");
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📋 *議事録からのタスク候補*（${proposal.candidates.length}件） — 承認すると正本タスクボードに登録されます`,
      },
    },
    { type: "divider" },
  ];

  for (const candidate of proposal.candidates) {
    const lines = [`*${sanitize(candidate.title)}*${STATUS_SUFFIX[candidate.status]}`];
    const meta: string[] = [];
    if (candidate.assignee && candidate.assignee !== "未定") meta.push(`担当: ${sanitize(candidate.assignee)}`);
    if (candidate.due) meta.push(`期限: ${candidate.due}`);
    if (meta.length > 0) lines.push(meta.join(" | "));
    if (candidate.context) lines.push(`_${sanitize(candidate.context)}_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
    if (candidate.status === "pending") {
      const value = JSON.stringify({ key: proposalKey(proposal.channelId, proposal.sourceTs), index: candidate.index });
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "承認して登録" },
            action_id: ACTION_APPROVE,
            value,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "却下" },
            action_id: ACTION_REJECT,
            value,
          },
        ],
      });
    }
  }

  if (pending.length > 1) {
    const value = JSON.stringify({ key: proposalKey(proposal.channelId, proposal.sourceTs) });
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: `全承認（${pending.length}件）` },
          action_id: ACTION_APPROVE_ALL,
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "全却下" },
          action_id: ACTION_REJECT_ALL,
          value,
        },
      ],
    });
  }

  return blocks;
}

/** Plain-text fallback for notifications (Slack requires text alongside blocks). */
export function proposalFallbackText(proposal: StoredProposal): string {
  return `議事録からのタスク候補 ${proposal.candidates.length}件`;
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MeetingTaskProposalDeps {
  taskClientFactory?: () => BrainbaseTaskClient;
  extractImpl?: (
    transcript: string,
    projectName?: string,
    options?: ExtractMeetingTasksOptions,
  ) => Promise<MeetingTaskCandidate[]>;
  approverResolver?: ApproverResolver;
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
  private readonly enabled: boolean;
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
    this.enabled = config.enabled === true;
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
      `[meeting-task-proposal] starting (channels=${[...this.channels].join(",")})`,
    );

    this.app.message(async ({ event }) => {
      try {
        await this.maybeHandleMessage(event as unknown as Record<string, unknown>);
      } catch (err) {
        logger.warn(`[meeting-task-proposal] message handling failed: ${err}`);
      }
    });

    const single = async ({ ack, body, action }: any, approve: boolean) => {
      await ack();
      await this.handleSingleAction(body, action, approve).catch((err) => {
        logger.warn(`[meeting-task-proposal] action handling failed: ${err}`);
      });
    };
    const bulk = async ({ ack, body, action }: any, approve: boolean) => {
      await ack();
      await this.handleBulkAction(body, action, approve).catch((err) => {
        logger.warn(`[meeting-task-proposal] bulk action handling failed: ${err}`);
      });
    };
    this.app.action(ACTION_APPROVE, (args: any) => single(args, true));
    this.app.action(ACTION_REJECT, (args: any) => single(args, false));
    this.app.action(ACTION_APPROVE_ALL, (args: any) => bulk(args, true));
    this.app.action(ACTION_REJECT_ALL, (args: any) => bulk(args, false));
  }

  stop(): void {
    this.active = false;
  }

  /** Exposed for tests: detection gates + extraction + proposal posting. */
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

    const state = loadState();
    const pruned = pruneExpired(state, now);
    const key = proposalKey(channel, ts);
    if (state[key]) {
      if (pruned) saveState(state);
      return; // already proposed for this message (Slack retry)
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

    const result = await this.client.apiCall("chat.postMessage", {
      channel,
      thread_ts: (event.thread_ts as string) ?? ts,
      text: proposalFallbackText(proposal),
      blocks: buildProposalBlocks(proposal),
      unfurl_links: false,
    });
    proposal.proposalTs = (result.ts as string) ?? "";

    // Re-load: the extraction + postMessage awaits above could interleave
    // with a button handler writing the file.
    const fresh = loadState();
    pruneExpired(fresh, now);
    fresh[key] = proposal;
    saveState(fresh);
    logger.info(`[meeting-task-proposal] proposed ${candidates.length} candidate(s) for ${key}`);
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

  private async denyOrExpire(body: any, message: string): Promise<void> {
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
    action: any,
  ): Promise<{ state: PersistedState; key: string; proposal: StoredProposal } | null> {
    const value = this.parseActionValue(action);
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    if (!value || !userId) return null;
    if (!(await this.approvers.canApprove(userId, channelId ?? ""))) {
      logger.warn(`[meeting-task-proposal] unauthorized action from ${userId}`);
      await this.denyOrExpire(body, "この操作の権限がありません。");
      return null;
    }
    const state = loadState();
    pruneExpired(state, Date.now());
    const proposal = state[value.key];
    if (!proposal) {
      await this.denyOrExpire(body, "この提案は期限切れです（72時間）。議事録を再投稿してください。");
      return null;
    }
    return { state, key: value.key, proposal };
  }

  private async registerCandidate(proposal: StoredProposal, candidate: StoredCandidate): Promise<void> {
    const client = this.taskClientFactory();
    const descriptionParts = [candidate.context, `担当（議事録記載）: ${candidate.assignee}`, `出典: 議事録 ${proposal.channelId}/${proposal.sourceTs}`];
    const task = await client.createTask(
      {
        title: candidate.title,
        description: descriptionParts.filter(Boolean).join("\n"),
        // assignee_person_id is intentionally omitted: it requires Graph
        // person resolution which the pilot operator id does not satisfy.
        ...(candidate.due ? { due_at: `${candidate.due}T00:00:00+09:00` } : {}),
      },
      candidateIdempotencyKey(proposal, candidate.index),
    );
    candidate.status = "approved";
    candidate.taskId = task.id;
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
  async handleSingleAction(body: any, action: any, approve: boolean): Promise<void> {
    const loaded = await this.loadAuthorizedProposal(body, action);
    if (!loaded) return;
    const { state, proposal } = loaded;
    const value = this.parseActionValue(action)!;
    const candidate = proposal.candidates.find((c) => c.index === value.index);
    if (!candidate || candidate.status !== "pending") return;

    if (approve) {
      try {
        await this.registerCandidate(proposal, candidate);
      } catch (err) {
        logger.warn(`[meeting-task-proposal] task registration failed: ${err}`);
        await this.denyOrExpire(body, `タスク登録に失敗しました: ${err}。もう一度押すと再試行します（二重登録はされません）。`);
        return; // stays pending — retry is safe thanks to the idempotency key
      }
    } else {
      candidate.status = "rejected";
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
  }

  /** Exposed for tests. */
  async handleBulkAction(body: any, action: any, approve: boolean): Promise<void> {
    const loaded = await this.loadAuthorizedProposal(body, action);
    if (!loaded) return;
    const { state, proposal } = loaded;
    const failures: string[] = [];
    for (const candidate of proposal.candidates) {
      if (candidate.status !== "pending") continue;
      if (approve) {
        try {
          await this.registerCandidate(proposal, candidate);
        } catch (err) {
          failures.push(`${candidate.title}: ${err}`);
        }
      } else {
        candidate.status = "rejected";
      }
    }
    saveState(state);
    await this.updateProposalMessage(proposal);
    if (failures.length > 0) {
      await this.denyOrExpire(
        body,
        `一部のタスク登録に失敗しました（${failures.length}件）。残りは再度「全承認」で再試行できます。\n${failures.join("\n")}`,
      );
    }
  }
}
