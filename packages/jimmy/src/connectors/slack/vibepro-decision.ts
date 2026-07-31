/**
 * Human-in-the-Loop question/answer UX for `/vibepro`.
 *
 * When the isolated development runner (scripts/development-runner/run.mjs)
 * decides a request is too ambiguous to implement safely, it stops with
 * `{status: "needs_decision", storyId, questions, summary}` instead of
 * implementing a guess. This module renders that as a Slack Block Kit
 * question card with a button that opens a modal, collects the human's
 * answers, and resumes the same Story exactly once (the 1-round-trip rule —
 * the resumed agent session is instructed not to ask again).
 *
 * Pending decisions are persisted under `${JINN_HOME}/.vibepro-decisions.json`
 * keyed by storyId, mirroring meeting-task-proposal.ts's TTL'd JSON store.
 * The button's `value` only carries the small storyId (Slack's 2000-char
 * button value limit can't hold up to 5 questions x 5 options), so opening
 * the modal looks the persisted questions up by storyId. Once the modal is
 * open, submission is self-describing from `view.state.values` (block IDs
 * encode the question id) plus `private_metadata` (storyId/channel/thread),
 * so a gateway restart between "modal open" and "submit" doesn't lose
 * anything the user is actively filling in.
 */

import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import type { DevelopmentAnswer, DevelopmentQuestion, Target } from "../../shared/types.js";

const STATE_FILE = path.join(JINN_HOME, ".vibepro-decisions.json");
const TTL_MS = 24 * 3600_000;
const QUESTION_BLOCK_PREFIX = "question:";
const FREE_TEXT_BLOCK_PREFIX = "freetext:";

export const ACTION_OPEN_FORM = "vibepro_open_answer_form";
export const VIEW_ANSWER_SUBMIT = "vibepro_answer_submit";

interface PendingDecision {
  storyId: string;
  channel: string;
  thread?: string;
  questions: DevelopmentQuestion[];
  summary: string;
  createdAt: number;
  expiresAt: number;
}

type PersistedState = Record<string, PendingDecision>;

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
    logger.warn(`[vibepro-decision] failed to persist state: ${err}`);
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

// LLM-derived text must never become an @channel ping or smuggle mrkdwn syntax.
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS_RE, " ").replace(/[<>]/g, " ").trim();
}

/** Fallback plain text (Slack requires `text` alongside `blocks`). */
export function decisionFallbackText(storyId: string, questions: DevelopmentQuestion[]): string {
  return `Story ${storyId} を確定するため、${questions.length}件の回答が必要です。`;
}

/** Builds the Block Kit question card posted to the thread. */
export function buildQuestionCardBlocks(storyId: string, questions: DevelopmentQuestion[], summary: string): unknown[] {
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🙋 *Storyを確定するため回答が必要です（Story: ${sanitize(storyId)}）*\n${sanitize(summary)}`,
      },
    },
    { type: "divider" },
  ];

  questions.forEach((question, index) => {
    const lines = [`*${index + 1}. ${sanitize(question.question)}*`];
    for (const option of question.options) {
      const suffix = option.recommended ? "（推奨）" : "";
      const description = option.description ? ` — ${sanitize(option.description)}` : "";
      lines.push(`  • ${sanitize(option.label)}${suffix}${description}`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "回答フォームを開く" },
        action_id: ACTION_OPEN_FORM,
        value: storyId,
      },
    ],
  });

  return blocks;
}

/** Builds the answer-collection modal from a persisted pending decision. */
export function buildAnswerModalView(pending: PendingDecision): Record<string, unknown> {
  const blocks: unknown[] = [];
  for (const question of pending.questions) {
    const hasOptions = question.options.length > 0;
    if (hasOptions) {
      const sortedOptions = [...question.options].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
      blocks.push({
        type: "input",
        block_id: `${QUESTION_BLOCK_PREFIX}${question.id}`,
        label: { type: "plain_text", text: question.question.slice(0, 150) },
        element: {
          type: "radio_buttons",
          action_id: "value",
          options: sortedOptions.map((option) => ({
            text: {
              type: "plain_text",
              text: `${option.label}${option.recommended ? "（推奨）" : ""}`.slice(0, 75),
            },
            value: option.label,
          })),
        },
      });
      if (question.allow_free_text) {
        blocks.push({
          type: "input",
          block_id: `${FREE_TEXT_BLOCK_PREFIX}${question.id}`,
          optional: true,
          label: { type: "plain_text", text: "補足（自由記述・任意）" },
          element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 },
        });
      }
    } else {
      blocks.push({
        type: "input",
        block_id: `${QUESTION_BLOCK_PREFIX}${question.id}`,
        label: { type: "plain_text", text: question.question.slice(0, 150) },
        element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 },
      });
    }
  }

  return {
    type: "modal",
    callback_id: VIEW_ANSWER_SUBMIT,
    private_metadata: JSON.stringify({ storyId: pending.storyId, channel: pending.channel, thread: pending.thread }),
    title: { type: "plain_text", text: "Storyの回答" },
    submit: { type: "plain_text", text: "送信" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks,
  };
}

/** Extracts answers from a submitted modal view's state values. */
export function extractAnswersFromViewState(values: Record<string, Record<string, any>>): DevelopmentAnswer[] {
  const answers: DevelopmentAnswer[] = [];
  for (const [blockId, block] of Object.entries(values ?? {})) {
    if (!blockId.startsWith(QUESTION_BLOCK_PREFIX)) continue;
    const id = blockId.slice(QUESTION_BLOCK_PREFIX.length);
    const raw = block?.value;
    const selectedLabel = raw?.selected_option?.value as string | undefined;
    const typedText = (raw?.value as string | undefined)?.trim();
    const base = selectedLabel ?? typedText ?? "";
    if (!base) continue;
    const freeTextBlock = values[`${FREE_TEXT_BLOCK_PREFIX}${id}`];
    const freeText = (freeTextBlock?.value?.value as string | undefined)?.trim();
    const answer = freeText ? `${base} / ${freeText}` : base;
    answers.push({ id, answer: answer.slice(0, 2000) });
  }
  return answers;
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface VibeproDecisionDeps {
  /**
   * Resumes the Story with the collected answers. Returns false when the
   * runner is busy or disabled (caller reports that back to Slack) — the
   * actual long-running resume + final result posting happens elsewhere
   * (SessionManager owns the runner invocation and result delivery).
   */
  resumeDecision: (storyId: string, answers: DevelopmentAnswer[], target: Target) => boolean;
}

export class VibeproDecisionNotifier {
  private readonly app: App;
  private readonly client: SlackClientLike;
  private readonly allowedUsers: Set<string>;
  private readonly resumeDecision: VibeproDecisionDeps["resumeDecision"];
  private active = false;

  constructor(app: App, allowFrom: string[], deps: VibeproDecisionDeps) {
    this.app = app;
    this.client = app.client as unknown as SlackClientLike;
    this.allowedUsers = new Set(allowFrom.filter(Boolean));
    this.resumeDecision = deps.resumeDecision;
  }

  /** Registers Bolt listeners. Must be called before app.start(). Fail-closed with no allowFrom. */
  register(): void {
    if (this.allowedUsers.size === 0) {
      logger.warn("[vibepro-decision] no allowFrom users configured — feature not started");
      return;
    }
    this.active = true;

    this.app.action(ACTION_OPEN_FORM, async ({ ack, body, action }: any) => {
      await ack();
      await this.handleOpenForm(body, action).catch((err) => {
        logger.warn(`[vibepro-decision] open form failed: ${err}`);
      });
    });
    this.app.view(VIEW_ANSWER_SUBMIT, async ({ ack, body, view }: any) => {
      await ack();
      await this.handleSubmit(body, view).catch((err) => {
        logger.warn(`[vibepro-decision] submit handling failed: ${err}`);
      });
    });
  }

  stop(): void {
    this.active = false;
  }

  /** Posts the question card and persists the pending decision for modal-build. */
  async postQuestions(target: Target, storyId: string, questions: DevelopmentQuestion[], summary: string): Promise<void> {
    if (!this.active) {
      logger.warn("[vibepro-decision] postQuestions called while inactive — posting plain text fallback");
      await this.client.apiCall("chat.postMessage", {
        channel: target.channel,
        thread_ts: target.thread || target.messageTs,
        text: `${decisionFallbackText(storyId, questions)}\n${summary}`,
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
      questions,
      summary,
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    saveState(state);

    await this.client.apiCall("chat.postMessage", {
      channel: target.channel,
      thread_ts: thread,
      text: decisionFallbackText(storyId, questions),
      blocks: buildQuestionCardBlocks(storyId, questions, summary),
      unfurl_links: false,
    });
  }

  private async notifyEphemeral(channel: string | undefined, userId: string | undefined, message: string): Promise<void> {
    if (!channel || !userId) return;
    try {
      await this.client.apiCall("chat.postEphemeral", { channel, user: userId, text: message });
    } catch (err) {
      logger.warn(`[vibepro-decision] ephemeral notice failed: ${err}`);
    }
  }

  /** Exposed for tests. Opens the answer modal for a question card button press. */
  async handleOpenForm(body: any, action: any): Promise<void> {
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    const triggerId = body?.trigger_id as string | undefined;
    if (!triggerId) return;
    if (!userId || !this.allowedUsers.has(userId)) {
      logger.warn(`[vibepro-decision] unauthorized open-form from ${userId}`);
      await this.notifyEphemeral(channelId, userId, "この操作の権限がありません。");
      return;
    }
    const storyId = action?.value as string | undefined;
    if (!storyId) return;
    const state = loadState();
    if (pruneExpired(state, Date.now())) saveState(state);
    const pending = state[storyId];
    if (!pending) {
      await this.notifyEphemeral(channelId, userId, "この質問セッションは期限切れです。/vibepro で再依頼してください。");
      return;
    }
    await this.client.apiCall("views.open", {
      trigger_id: triggerId,
      view: buildAnswerModalView(pending),
    });
  }

  /** Exposed for tests. Applies a submitted modal, then resumes the Story. */
  async handleSubmit(body: any, view: any): Promise<void> {
    let meta: { storyId?: string; channel?: string; thread?: string } | null = null;
    try {
      meta = JSON.parse(view?.private_metadata ?? "");
    } catch {
      return;
    }
    if (!meta || typeof meta.storyId !== "string" || typeof meta.channel !== "string") return;

    const userId = body?.user?.id as string | undefined;
    if (!userId || !this.allowedUsers.has(userId)) {
      logger.warn(`[vibepro-decision] unauthorized answer submit from ${userId}`);
      return;
    }

    const answers = extractAnswersFromViewState(view?.state?.values ?? {});
    if (answers.length === 0) return;

    const target: Target = { channel: meta.channel, thread: meta.thread };
    const started = this.resumeDecision(meta.storyId, answers, target);
    if (started) {
      await this.client.apiCall("chat.postMessage", {
        channel: meta.channel,
        thread_ts: meta.thread,
        text: `回答を受け付けました。Story ${meta.storyId} を再開します。`,
      });
      const state = loadState();
      delete state[meta.storyId];
      saveState(state);
    } else {
      await this.client.apiCall("chat.postMessage", {
        channel: meta.channel,
        thread_ts: meta.thread,
        text: "別の開発タスクが実行中のため、いまは再開できません。しばらくしてからもう一度お試しください。",
      });
    }
  }
}
