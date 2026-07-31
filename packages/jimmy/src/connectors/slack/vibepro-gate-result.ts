/**
 * "成果報告＋次の一手" UX for a `/vibepro needs_input` result caused by
 * unresolved VibePro gates.
 *
 * Before this module, a needs_input gate stop rendered as a raw text dump
 * (`Development: needs_input\nStory: ...\nVibePro gates are not resolved
 * yet. N gate(s) remain, e.g.: <truncated English gate text> Review the
 * worktree before resuming.`) with no next action — needs_input was a dead
 * end. This module renders it instead as a Slack Block Kit card showing what
 * was actually accomplished (commit count + subjects) and the remaining
 * gates (severity-grouped, with a details button for the full list), plus a
 * button that resumes the same Story's Gate-resolution round through
 * `SessionManager.continueDevelopmentGates`.
 *
 * Pending gate results are persisted under
 * `${JINN_HOME}/.vibepro-gate-results.json` keyed by storyId, mirroring
 * vibepro-decision.ts's TTL'd JSON store. The card's buttons only carry the
 * small storyId (Slack's button value limit can't hold up to 30 gates), so
 * both the "continue" and "details" actions look the persisted gates up by
 * storyId.
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import type { DevelopmentCommits, DevelopmentGate, Target } from "../../shared/types.js";

const STATE_FILE = path.join(JINN_HOME, ".vibepro-gate-results.json");
const TTL_MS = 24 * 3600_000;
const MAX_CARD_GATES = 3;
const MAX_CARD_COMMIT_SUBJECTS = 3;
const MAX_SLACK_MESSAGE_CHARS = 3800;

export const ACTION_CONTINUE_GATES = "vibepro_continue_gates";
export const ACTION_GATE_DETAILS = "vibepro_gate_details";

interface PendingGateResult {
  storyId: string;
  channel: string;
  thread?: string;
  gates: DevelopmentGate[];
  commits?: DevelopmentCommits;
  createdAt: number;
  expiresAt: number;
  /** Set once "続行してGateを解消させる" has been pressed and accepted — the
   * card's button then reports "開始済み" instead of the misleading
   * "期限切れ". */
  continueRequestedAt?: number;
}

type PersistedState = Record<string, PendingGateResult>;

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
    logger.warn(`[vibepro-gate-result] failed to persist state: ${err}`);
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

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// Gate/commit text is either LLM-derived or a raw VibePro CLI line; either
// way it must never become an @channel ping or smuggle mrkdwn syntax.
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ").replace(/[<>]/g, " ").trim();
}

function severityLabel(severity: DevelopmentGate["severity"]): string {
  return severity === "critical" ? "critical" : "evidence";
}

function sortBySeverity(gates: DevelopmentGate[]): DevelopmentGate[] {
  return [...gates].sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === "critical" ? -1 : 1;
  });
}

/** Fallback plain text (Slack requires `text` alongside `blocks`). */
export function gateResultFallbackText(storyId: string, gates: DevelopmentGate[], commits?: DevelopmentCommits): string {
  const commitPart = commits && commits.count > 0 ? `commit ${commits.count}件` : "実装なし";
  return `Story ${storyId}: Gate未解決のため停止しました（${commitPart}、残Gate ${gates.length}件）。`;
}

/** Builds the Block Kit "成果報告＋次の一手" card posted to the thread. */
export function buildGateResultBlocks(storyId: string, gates: DevelopmentGate[], commits?: DevelopmentCommits): unknown[] {
  const hasCommits = (commits?.count ?? 0) > 0;
  const headerText = hasCommits
    ? "⏸ 実装は進みましたが、PR準備のGateが未解決で停止しました"
    : "⏸ Gate未解決のため停止しました";

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headerText}*\nStory: ${sanitize(storyId)}` },
    },
    { type: "divider" },
  ];

  if (hasCommits && commits) {
    const subjectLines = commits.subjects.slice(0, MAX_CARD_COMMIT_SUBJECTS).map((subject) => `• ${sanitize(subject)}`);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [`*ここまでの成果: commit ${commits.count}件*`, ...subjectLines].join("\n"),
      },
    });
  }

  const criticalCount = gates.filter((gate) => gate.severity === "critical").length;
  const evidenceCount = gates.filter((gate) => gate.severity === "evidence").length;
  const shown = sortBySeverity(gates).slice(0, MAX_CARD_GATES);
  const remaining = gates.length - shown.length;
  const gateLines = shown.map((gate) => `• [${severityLabel(gate.severity)}] ${sanitize(gate.text)}`);
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*残Gate ${gates.length}件（critical ${criticalCount} / evidence ${evidenceCount}）*`,
        ...gateLines,
        remaining > 0 ? `_他 ${remaining} 件は「📄 全Gate詳細」で確認できます_` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    },
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "🔁 続行してGateを解消させる" },
        action_id: ACTION_CONTINUE_GATES,
        value: storyId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "📄 全Gate詳細" },
        action_id: ACTION_GATE_DETAILS,
        value: storyId,
      },
    ],
  });

  return blocks;
}

/**
 * Splits the full severity-grouped gate list into chunks that each fit
 * Slack's per-message text limit, so a Story with many gates never silently
 * drops entries.
 */
export function buildGateDetailChunks(gates: DevelopmentGate[]): string[] {
  const lines: string[] = [];
  const critical = gates.filter((gate) => gate.severity === "critical");
  const evidence = gates.filter((gate) => gate.severity === "evidence");
  if (critical.length > 0) {
    lines.push(`*critical（${critical.length}件）*`);
    critical.forEach((gate, index) => lines.push(`${index + 1}. ${sanitize(gate.text)}`));
  }
  if (evidence.length > 0) {
    lines.push(`*evidence（${evidence.length}件）*`);
    evidence.forEach((gate, index) => lines.push(`${index + 1}. ${sanitize(gate.text)}`));
  }

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_SLACK_MESSAGE_CHARS) {
      if (current) chunks.push(current);
      current = line.length > MAX_SLACK_MESSAGE_CHARS ? line.slice(0, MAX_SLACK_MESSAGE_CHARS) : line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface VibeproGateResultDeps {
  /**
   * Continues the Story's Gate-resolution round. Returns false when the
   * runner is busy or disabled (caller reports that back to Slack) — the
   * actual long-running continuation + final result posting happens
   * elsewhere (SessionManager owns the runner invocation and result
   * delivery, same as the Human-in-the-Loop resume path).
   */
  continueGates: (storyId: string, target: Target) => boolean;
}

export class VibeproGateResultNotifier {
  private readonly app: App;
  private readonly client: SlackClientLike;
  private readonly allowedUsers: Set<string>;
  private readonly continueGates: VibeproGateResultDeps["continueGates"];
  private active = false;

  constructor(app: App, allowFrom: string[], deps: VibeproGateResultDeps) {
    this.app = app;
    this.client = app.client as unknown as SlackClientLike;
    this.allowedUsers = new Set(allowFrom.filter(Boolean));
    this.continueGates = deps.continueGates;
  }

  /** Registers Bolt listeners. Must be called before app.start(). Fail-closed with no allowFrom. */
  register(): void {
    if (this.allowedUsers.size === 0) {
      logger.warn("[vibepro-gate-result] no allowFrom users configured — feature not started");
      return;
    }
    this.active = true;

    this.app.action(ACTION_CONTINUE_GATES, async ({ ack, body, action }: any) => {
      await ack();
      await this.handleContinue(body, action).catch((err) => {
        logger.warn(`[vibepro-gate-result] continue handling failed: ${err}`);
      });
    });
    this.app.action(ACTION_GATE_DETAILS, async ({ ack, body, action }: any) => {
      await ack();
      await this.handleDetails(body, action).catch((err) => {
        logger.warn(`[vibepro-gate-result] details handling failed: ${err}`);
      });
    });
  }

  stop(): void {
    this.active = false;
  }

  /** Posts the "成果報告＋次の一手" card and persists it for the button handlers. */
  async postResult(target: Target, storyId: string, gates: DevelopmentGate[], commits?: DevelopmentCommits): Promise<void> {
    if (!this.active) {
      logger.warn("[vibepro-gate-result] postResult called while inactive — posting plain text fallback");
      await this.client.apiCall("chat.postMessage", {
        channel: target.channel,
        thread_ts: target.thread || target.messageTs,
        text: gateResultFallbackText(storyId, gates, commits),
      });
      return;
    }
    const now = Date.now();
    const state = loadState();
    pruneExpired(state, now);
    const thread = target.thread || target.messageTs;
    state[storyId] = {
      storyId,
      channel: target.channel,
      thread,
      gates,
      commits,
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    saveState(state);

    await this.client.apiCall("chat.postMessage", {
      channel: target.channel,
      thread_ts: thread,
      text: gateResultFallbackText(storyId, gates, commits),
      blocks: buildGateResultBlocks(storyId, gates, commits),
      unfurl_links: false,
    });
  }

  private async notifyEphemeral(channel: string | undefined, userId: string | undefined, message: string): Promise<void> {
    if (!channel || !userId) return;
    try {
      await this.client.apiCall("chat.postEphemeral", { channel, user: userId, text: message });
    } catch (err) {
      logger.warn(`[vibepro-gate-result] ephemeral notice failed: ${err}`);
    }
  }

  private lookupPending(storyId: string): PendingGateResult | null {
    const state = loadState();
    if (pruneExpired(state, Date.now())) saveState(state);
    return state[storyId] ?? null;
  }

  /** Exposed for tests. Handles a "続行してGateを解消させる" button press. */
  async handleContinue(body: any, action: any): Promise<void> {
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    if (!userId || !this.allowedUsers.has(userId)) {
      logger.warn(`[vibepro-gate-result] unauthorized continue from ${userId}`);
      await this.notifyEphemeral(channelId, userId, "この操作の権限がありません。");
      return;
    }
    const storyId = action?.value as string | undefined;
    if (!storyId) return;
    const pending = this.lookupPending(storyId);
    if (!pending) {
      await this.notifyEphemeral(channelId, userId, "このGate結果セッションは期限切れです。/vibepro で状況を確認してください。");
      return;
    }
    if (pending.continueRequestedAt) {
      await this.notifyEphemeral(channelId, userId, `Story ${storyId} のGate解消ラウンドはすでに開始済みです。`);
      return;
    }

    const target: Target = { channel: pending.channel, thread: pending.thread };
    const started = this.continueGates(storyId, target);
    if (started) {
      const state = loadState();
      if (state[storyId]) {
        state[storyId].continueRequestedAt = Date.now();
        saveState(state);
      }
      await this.client.apiCall("chat.postMessage", {
        channel: pending.channel,
        thread_ts: pending.thread,
        text: `🔁 Gate解消ラウンドを開始します（Story ${storyId}）`,
      });
    } else {
      await this.notifyEphemeral(
        channelId,
        userId,
        "別の開発タスクが実行中のため、いまは続行できません。しばらくしてからもう一度お試しください。",
      );
    }
  }

  /** Exposed for tests. Handles a "全Gate詳細" button press. */
  async handleDetails(body: any, action: any): Promise<void> {
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    if (!userId || !this.allowedUsers.has(userId)) {
      logger.warn(`[vibepro-gate-result] unauthorized details request from ${userId}`);
      await this.notifyEphemeral(channelId, userId, "この操作の権限がありません。");
      return;
    }
    const storyId = action?.value as string | undefined;
    if (!storyId) return;
    const pending = this.lookupPending(storyId);
    if (!pending) {
      await this.notifyEphemeral(channelId, userId, "このGate結果セッションは期限切れです。/vibepro で状況を確認してください。");
      return;
    }

    const chunks = buildGateDetailChunks(pending.gates);
    for (const chunk of chunks) {
      await this.client.apiCall("chat.postMessage", {
        channel: pending.channel,
        thread_ts: pending.thread,
        text: chunk,
      });
    }
  }
}
