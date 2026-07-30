/**
 * Meeting minutes pipeline — transcript (.txt) upload in a router channel →
 * default routing → minutes generation → expansion into the project channel →
 * handoff to the register-first task flow.
 *
 * Design: docs/architecture/story-meeting-minutes-pipeline.md. mana's Lambda
 * pipeline is the reference implementation (frozen after this ships); Eve's
 * meeting-agent supplies the quality contract and stage layout. Stages are
 * sequenced by deterministic code — the LLM is only invoked for routing
 * classification and minutes generation (meeting-minutes-generator.ts).
 *
 * State lives in `${JINN_HOME}/.meeting-minutes-runs.json` with monotonic
 * status transitions (received → routed → posted → tasks_dispatched;
 * failed:<stage> never regresses a completed stage). The transcript itself is
 * never persisted — only its sha256, which also dedupes re-uploads of the
 * same recording.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "@slack/bolt";
import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { GraphEntityClient } from "../../shared/brainbase-graph.js";
import {
  BrainbaseTaskClient,
  isBrainbaseTaskStoreConfigured,
} from "../../shared/brainbase-tasks.js";
import {
  classifyMinutesDestination,
  generateMinutes,
  splitForSlack,
  type GeneratedMinutes,
  type MinutesContext,
  type MinutesDestination,
  type MinutesLlmOptions,
} from "./meeting-minutes-generator.js";
import {
  StaticApproverResolver,
  type ApproverResolver,
  type MeetingTaskProposalNotifier,
} from "./meeting-task-proposal.js";

export interface MeetingMinutesPipelineConfig {
  /** Master switch — defaults to false when the block is absent. */
  enabled?: boolean;
  /** Router channel IDs to watch for .txt uploads. Required; empty = off. */
  routerChannels?: string[];
  /** Destination projects. Required; empty = off. */
  destinations?: MinutesDestination[];
  /** Slack user IDs allowed to reroute/retry. Falls back to allowFrom. */
  operatorUserIds?: string[];
  /** Max transcript file size in bytes. Default 1 MiB. */
  maxFileBytes?: number;
  /** Run context lifetime in days. Default 14. */
  ttlDays?: number;
  /** LLM overrides per stage. */
  routing?: MinutesLlmOptions;
  generation?: MinutesLlmOptions;
}

/**
 * failed:<stage> is terminal for the automatic flow; the retry button
 * resumes from the failed stage. Completed stages never re-run.
 */
export type MinutesRunStatus =
  | "received"
  | "awaiting_destination"
  | "routed"
  | "posted"
  | "tasks_dispatched"
  | `failed:${string}`;

export interface MinutesRun {
  routerChannelId: string;
  fileId: string;
  sourceTs: string;
  fileName: string;
  sourceTextHash: string;
  status: MinutesRunStatus;
  projectId?: string;
  routingReason?: string;
  destinationChannelId?: string;
  /** Parent (overview) message ts in the destination channel. */
  postedParentTs?: string;
  /** Our control message ts in the router thread (chat.update target). */
  controlTs?: string;
  /** Persisted so reroute can repost without regenerating. */
  minutes?: GeneratedMinutes;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PipelineState {
  runs: Record<string, MinutesRun>;
  /** Overview of the last minutes posted per channel — next run's context. */
  lastMinutesByChannel: Record<string, { title: string; overview: string; postedTs: string }>;
}

const STATE_FILE = path.join(JINN_HOME, ".meeting-minutes-runs.json");
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

export const ACTION_MM_CHOOSE_DEST = "meeting_minutes_choose_destination";
export const ACTION_MM_REROUTE = "meeting_minutes_reroute";
export const ACTION_MM_RETRY = "meeting_minutes_retry";

/** Stage order for monotonic transitions. */
const STATUS_RANK: Record<string, number> = {
  received: 0,
  awaiting_destination: 1,
  routed: 2,
  posted: 3,
  tasks_dispatched: 4,
};

function loadState(): PipelineState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PipelineState;
    if (parsed && typeof parsed === "object") {
      return {
        runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
        lastMinutesByChannel:
          parsed.lastMinutesByChannel && typeof parsed.lastMinutesByChannel === "object"
            ? parsed.lastMinutesByChannel
            : {},
      };
    }
  } catch {
    /* fresh state */
  }
  return { runs: {}, lastMinutesByChannel: {} };
}

function saveState(state: PipelineState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[meeting-minutes] failed to persist state: ${err}`);
  }
}

function pruneExpired(state: PipelineState, now: number): void {
  for (const key of Object.keys(state.runs)) {
    if (state.runs[key].expiresAt <= now) delete state.runs[key];
  }
}

export function runKey(channelId: string, fileId: string, ts: string): string {
  return `router:${channelId}:${fileId}:${ts}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Advance status; never regress a completed stage (failed:* is a marker, not a rank). */
export function advanceStatus(run: MinutesRun, next: MinutesRunStatus): void {
  if (next.startsWith("failed:")) {
    run.status = next;
    return;
  }
  const currentRank = STATUS_RANK[run.status] ?? -1; // failed:* → -1, retry may re-enter
  const nextRank = STATUS_RANK[next] ?? -1;
  if (nextRank >= currentRank || run.status.startsWith("failed:")) {
    run.status = next;
  }
}

function jstDateStr(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(now));
}

interface SlackClientLike {
  apiCall(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface TranscriptFile {
  text: string;
  fileName: string;
}

export interface MeetingMinutesPipelineDeps {
  /** Fetches the transcript text for a Slack file id. Null on failure. */
  fetchTranscript?: (fileId: string) => Promise<TranscriptFile | null>;
  classifyImpl?: typeof classifyMinutesDestination;
  generateImpl?: typeof generateMinutes;
  graphClient?: GraphEntityClient;
  taskClientFactory?: () => BrainbaseTaskClient;
  approverResolver?: ApproverResolver;
  /** Register-first task flow to hand posted minutes to. */
  taskProposalNotifier?: Pick<MeetingTaskProposalNotifier, "processMinutesText"> | null;
}

export class MeetingMinutesPipeline {
  private readonly app: App;
  private readonly client: SlackClientLike;
  private readonly enabled: boolean;
  private readonly routerChannels: Set<string>;
  private readonly destinations: MinutesDestination[];
  private readonly operators: ApproverResolver;
  private readonly operatorsEmpty: boolean;
  private readonly maxFileBytes: number;
  private readonly ttlMs: number;
  private readonly routingOptions: MinutesLlmOptions;
  private readonly generationOptions: MinutesLlmOptions;
  private readonly deps: MeetingMinutesPipelineDeps;
  private readonly bootTimeMs = Date.now();
  private active = false;

  constructor(
    app: App,
    config: MeetingMinutesPipelineConfig,
    fallbackOperators: string[],
    deps: MeetingMinutesPipelineDeps = {},
  ) {
    this.app = app;
    this.client = app.client as unknown as SlackClientLike;
    this.enabled = config.enabled === true;
    this.routerChannels = new Set((config.routerChannels ?? []).filter(Boolean));
    this.destinations = (config.destinations ?? []).filter(
      (d) => d && d.projectId && d.name && d.channelId,
    );
    const operatorIds = (
      config.operatorUserIds?.length ? config.operatorUserIds : fallbackOperators
    ).filter(Boolean);
    this.operators = deps.approverResolver ?? new StaticApproverResolver(operatorIds);
    this.operatorsEmpty =
      this.operators instanceof StaticApproverResolver && this.operators.size === 0;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.ttlMs = (config.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
    this.routingOptions = config.routing ?? {};
    this.generationOptions = config.generation ?? {};
    this.deps = deps;
  }

  /** Registers Bolt listeners. Must be called before app.start(). Fail closed. */
  register(): void {
    if (!this.enabled) {
      logger.info("[meeting-minutes] disabled by config");
      return;
    }
    if (this.routerChannels.size === 0) {
      logger.warn("[meeting-minutes] no routerChannels configured — feature not started");
      return;
    }
    if (this.destinations.length === 0) {
      logger.warn("[meeting-minutes] no destinations configured — feature not started");
      return;
    }
    if (this.operatorsEmpty) {
      logger.warn("[meeting-minutes] no operators configured — feature not started");
      return;
    }
    if (!isBrainbaseTaskStoreConfigured()) {
      // Only the open-task context and the task handoff need the store, but a
      // pilot without it configured is misdeployed — better to stay off loud.
      logger.warn("[meeting-minutes] Brainbase task store not configured — feature not started");
      return;
    }

    this.active = true;
    logger.info(
      `[meeting-minutes] starting (routers=${[...this.routerChannels].join(",")}, destinations=${this.destinations.length})`,
    );

    this.app.message(async ({ event }) => {
      try {
        await this.maybeHandleFileMessage(event as unknown as Record<string, unknown>);
      } catch (err) {
        logger.warn(`[meeting-minutes] message handling failed: ${err}`);
      }
    });

    const wrap = (fn: (body: any, action: any) => Promise<void>) => async ({ ack, body, action }: any) => {
      await ack();
      await fn(body, action).catch((err) => {
        logger.warn(`[meeting-minutes] action handling failed: ${err}`);
      });
    };
    this.app.action(ACTION_MM_CHOOSE_DEST, wrap((body, action) => this.handleChooseDestination(body, action)));
    this.app.action(ACTION_MM_REROUTE, wrap((body, action) => this.handleReroute(body, action)));
    this.app.action(ACTION_MM_RETRY, wrap((body, action) => this.handleRetry(body, action)));
  }

  stop(): void {
    this.active = false;
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /** Exposed for tests: detection gates → run creation → DAG execution. */
  async maybeHandleFileMessage(event: Record<string, unknown>, now: number = Date.now()): Promise<void> {
    if (!this.active) return;
    const channel = event.channel as string | undefined;
    const ts = event.ts as string | undefined;
    if (!channel || !ts || !this.routerChannels.has(channel)) return;
    if (event.subtype !== "file_share") return;
    const files = Array.isArray(event.files) ? (event.files as Record<string, unknown>[]) : [];
    const txtFiles = files.filter((f) =>
      typeof f?.name === "string" && (f.name as string).toLowerCase().endsWith(".txt"),
    );
    if (txtFiles.length === 0) return;
    if (txtFiles.length > 1) {
      logger.warn(`[meeting-minutes] multiple .txt files attached — processing the first only`);
    }
    const file = txtFiles[0];
    const fileId = file.id as string | undefined;
    if (!fileId) return;
    const tsMs = Number.parseFloat(ts) * 1000;
    if (Number.isFinite(tsMs) && tsMs < this.bootTimeMs - 60_000) return;
    if (typeof file.size === "number" && file.size > this.maxFileBytes) {
      await this.postControl(channel, ts, undefined, {
        text: `⚠️ ファイルが大きすぎます（上限 ${Math.floor(this.maxFileBytes / 1024)}KB）。処理をスキップしました。`,
      });
      return;
    }

    const state = loadState();
    pruneExpired(state, now);
    const key = runKey(channel, fileId, ts);
    if (state.runs[key]) {
      saveState(state);
      return; // Slack redelivery
    }

    const run: MinutesRun = {
      routerChannelId: channel,
      fileId,
      sourceTs: ts,
      fileName: (file.name as string) ?? "transcript.txt",
      sourceTextHash: "",
      status: "received",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
    state.runs[key] = run;
    saveState(state);

    await this.executeRun(key, now);
  }

  // -------------------------------------------------------------------------
  // DAG execution — deterministic stage sequencing
  // -------------------------------------------------------------------------

  /**
   * Runs (or resumes) the DAG for one run. Reads fresh state, executes the
   * stages the run has not yet completed, persists after every stage. Safe to
   * call again after a failure — completed stages are skipped via status.
   */
  private async executeRun(key: string, now: number): Promise<void> {
    const state = loadState();
    const run = state.runs[key];
    if (!run) return;

    // Stage: download + hash (always — the transcript is never persisted).
    const transcript = await (this.deps.fetchTranscript ?? this.fetchTranscriptDefault.bind(this))(
      run.fileId,
    );
    if (!transcript || !transcript.text.trim()) {
      await this.failRun(state, key, "download", "transcriptの取得に失敗しました");
      return;
    }
    const hash = sha256Hex(transcript.text);
    if (!run.sourceTextHash) {
      const duplicate = Object.entries(state.runs).find(
        ([otherKey, other]) => otherKey !== key && other.sourceTextHash === hash,
      );
      if (duplicate) {
        logger.info(`[meeting-minutes] duplicate transcript (hash match with ${duplicate[0]}) — skipping`);
        delete state.runs[key];
        saveState(state);
        await this.postControl(run.routerChannelId, run.sourceTs, undefined, {
          text: "ℹ️ 同一内容のtranscriptが処理済みのため、スキップしました。",
        });
        return;
      }
      run.sourceTextHash = hash;
      run.updatedAt = now;
      saveState(state);
    } else if (run.sourceTextHash !== hash) {
      // Slack files are immutable; a mismatch means a different file id path.
      logger.warn(`[meeting-minutes] transcript hash changed on retry for ${key} — continuing with new hash`);
      run.sourceTextHash = hash;
    }

    // Stage: routing (skipped when a destination is already fixed).
    if (!run.projectId) {
      const classify = this.deps.classifyImpl ?? classifyMinutesDestination;
      const routed = await classify(transcript.text, this.destinations, this.routingOptions);
      if (!routed) {
        advanceStatus(run, "awaiting_destination");
        run.updatedAt = now;
        saveState(state);
        await this.updateControl(state, key, {
          text: "❓ どのプロジェクトの会議か判定できませんでした。宛先を選んでください。",
          blocks: this.destinationSelectBlocks(key, "❓ どのプロジェクトの会議か判定できませんでした。宛先を選んでください。"),
        });
        return; // resumes via handleChooseDestination
      }
      run.projectId = routed.destination.projectId;
      run.destinationChannelId = routed.destination.channelId;
      run.routingReason = routed.reason;
      advanceStatus(run, "routed");
      run.updatedAt = now;
      saveState(state);
      logger.info(`[meeting-minutes] routed ${key} → ${run.projectId} (${routed.reason})`);
    }

    const destination = this.destinations.find((d) => d.projectId === run.projectId);
    if (!destination) {
      await this.failRun(state, key, "route", `宛先プロジェクト ${run.projectId} がconfigにありません`);
      return;
    }

    // Stage: generation (with one automatic retry on contract violations).
    if (!run.minutes) {
      const generated = await this.generateWithRetry(transcript.text, destination, state, now);
      if ("error" in generated) {
        await this.failRun(state, key, "generate", `議事録生成に失敗しました: ${generated.error.reason}`);
        return;
      }
      run.minutes = generated.minutes;
      run.updatedAt = now;
      saveState(state);
    }
    const minutes = run.minutes;
    if (!minutes) return;

    // Stage: post (parent = overview, thread = 2900-char body chunks).
    if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.posted) {
      try {
        const parent = await this.client.apiCall("chat.postMessage", {
          channel: destination.channelId,
          text: minutes.overview,
          unfurl_links: false,
        });
        run.postedParentTs = (parent.ts as string) ?? "";
        for (const chunk of splitForSlack(minutes.body)) {
          await this.client.apiCall("chat.postMessage", {
            channel: destination.channelId,
            thread_ts: run.postedParentTs,
            text: chunk,
            unfurl_links: false,
          });
        }
      } catch (err) {
        await this.failRun(state, key, "post", `投稿に失敗しました（${destination.name}）: ${err}`);
        return;
      }
      advanceStatus(run, "posted");
      run.updatedAt = now;
      state.lastMinutesByChannel[destination.channelId] = {
        title: minutes.title,
        overview: minutes.overview,
        postedTs: run.postedParentTs ?? "",
      };
      saveState(state);
    }

    // Stage: task handoff (best-effort — the posting already succeeded).
    let handoffNote = "";
    if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.tasks_dispatched) {
      const notifier = this.deps.taskProposalNotifier;
      if (notifier && run.postedParentTs) {
        try {
          const dispatched = await notifier.processMinutesText(
            destination.channelId,
            run.postedParentTs,
            minutes.body,
            now,
          );
          if (dispatched) {
            advanceStatus(run, "tasks_dispatched");
          } else {
            handoffNote = "\n⚠️ タスク自動登録は無効のためスキップしました。";
          }
        } catch (err) {
          logger.warn(`[meeting-minutes] task handoff failed for ${key}: ${err}`);
          handoffNote = "\n⚠️ タスク自動登録に失敗しました（議事録の展開は成功）。";
        }
      } else {
        handoffNote = "\n⚠️ タスク自動登録は未接続です。";
      }
      run.updatedAt = now;
      saveState(state);
    }

    const summary = `✅ *${destination.name}* <#${destination.channelId}> へ議事録を展開しました\n${minutes.title}${run.routingReason ? `\n_振り分け根拠: ${run.routingReason}_` : ""}${handoffNote}`;
    await this.updateControl(state, key, {
      text: summary,
      blocks: this.rerouteBlocks(key, summary, destination.projectId),
    });
  }

  private async generateWithRetry(
    transcript: string,
    destination: MinutesDestination,
    state: PipelineState,
    now: number,
  ): Promise<{ minutes: GeneratedMinutes } | { error: { reason: string } }> {
    const ctx = await this.buildContext(destination, now);
    const generate = this.deps.generateImpl ?? generateMinutes;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await generate(transcript, ctx, this.generationOptions);
        if ("minutes" in result) return result;
        logger.warn(
          `[meeting-minutes] generation attempt ${attempt} violated the contract: ${result.error.reason}`,
        );
        if (attempt === 2) return result;
      } catch (err) {
        logger.warn(`[meeting-minutes] generation attempt ${attempt} failed: ${err}`);
        if (attempt === 2) return { error: { reason: String(err) } };
      }
    }
    return { error: { reason: "unreachable" } };
  }

  /** Context prep — every source fails open with a warn. */
  private async buildContext(destination: MinutesDestination, now: number): Promise<MinutesContext> {
    const graph = this.deps.graphClient ?? new GraphEntityClient();
    const [people, projects, brands, decisions] = await Promise.all([
      graph.listEntities("person"),
      graph.listEntities("project"),
      graph.listEntities("brand"),
      graph.listEntities("decision"),
    ]);
    if (people.length + projects.length + brands.length === 0) {
      logger.warn("[meeting-minutes] Graph unavailable — generating without the proper-noun dictionary");
    }

    let openTasks: string[] = [];
    try {
      const client = (this.deps.taskClientFactory ?? (() => new BrainbaseTaskClient()))();
      const [pending, inProgress] = await Promise.all([
        client.listTasks({ status: "pending", limit: 20 }),
        client.listTasks({ status: "in_progress", limit: 20 }),
      ]);
      openTasks = [...inProgress.items, ...pending.items].map((t) => t.title).slice(0, 20);
    } catch (err) {
      logger.warn(`[meeting-minutes] open-task context unavailable: ${err}`);
    }

    const projectNeedle = destination.name.toLowerCase();
    const relatedDecisions = decisions
      .filter((d) => d.name.toLowerCase().includes(projectNeedle))
      .map((d) => d.name)
      .slice(0, 10);

    const state = loadState();
    const previous = state.lastMinutesByChannel[destination.channelId];

    return {
      properNouns: [...people, ...projects, ...brands],
      openTasks,
      decisions: relatedDecisions,
      previousMinutes: previous ? { title: previous.title, overview: previous.overview } : undefined,
      projectName: destination.name,
      dateStr: jstDateStr(now),
    };
  }

  // -------------------------------------------------------------------------
  // Slack transcript fetch (default impl)
  // -------------------------------------------------------------------------

  private async fetchTranscriptDefault(fileId: string): Promise<TranscriptFile | null> {
    try {
      const info = await this.client.apiCall("files.info", { file: fileId });
      const file = info.file as Record<string, unknown> | undefined;
      const url = file?.url_private_download ?? file?.url_private;
      if (typeof url !== "string") return null;
      const token = (this.app.client as unknown as { token?: string }).token ?? "";
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        logger.warn(`[meeting-minutes] transcript download failed: ${res.status}`);
        return null;
      }
      const text = await res.text();
      return { text, fileName: (file?.name as string) ?? "transcript.txt" };
    } catch (err) {
      logger.warn(`[meeting-minutes] transcript fetch failed: ${err}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Control message in the router thread
  // -------------------------------------------------------------------------

  private async postControl(
    channel: string,
    threadTs: string,
    controlTs: string | undefined,
    message: { text: string; blocks?: unknown[] },
  ): Promise<string | undefined> {
    try {
      if (controlTs) {
        await this.client.apiCall("chat.update", {
          channel,
          ts: controlTs,
          text: message.text,
          ...(message.blocks ? { blocks: message.blocks } : { blocks: [] }),
        });
        return controlTs;
      }
      const result = await this.client.apiCall("chat.postMessage", {
        channel,
        thread_ts: threadTs,
        text: message.text,
        ...(message.blocks ? { blocks: message.blocks } : {}),
        unfurl_links: false,
      });
      return result.ts as string | undefined;
    } catch (err) {
      logger.warn(`[meeting-minutes] control message failed: ${err}`);
      return controlTs;
    }
  }

  private async updateControl(
    state: PipelineState,
    key: string,
    message: { text: string; blocks?: unknown[] },
  ): Promise<void> {
    const run = state.runs[key];
    if (!run) return;
    const ts = await this.postControl(run.routerChannelId, run.sourceTs, run.controlTs, message);
    if (ts && ts !== run.controlTs) {
      run.controlTs = ts;
      saveState(state);
    }
  }

  private async failRun(state: PipelineState, key: string, stage: string, message: string): Promise<void> {
    const run = state.runs[key];
    if (!run) return;
    advanceStatus(run, `failed:${stage}`);
    run.updatedAt = Date.now();
    saveState(state);
    logger.warn(`[meeting-minutes] ${key} failed at ${stage}: ${message}`);
    await this.updateControl(state, key, {
      text: `⚠️ ${message}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `⚠️ ${message}` } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "再試行" },
              action_id: ACTION_MM_RETRY,
              value: JSON.stringify({ key }),
            },
          ],
        },
      ],
    });
  }

  private destinationOptions(excludeProjectId?: string): unknown[] {
    return this.destinations
      .filter((d) => d.projectId !== excludeProjectId)
      .slice(0, 100)
      .map((d) => ({
        text: { type: "plain_text", text: d.name.slice(0, 75) },
        value: d.projectId,
      }));
  }

  private destinationSelectBlocks(key: string, text: string): unknown[] {
    return [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: ACTION_MM_CHOOSE_DEST,
            placeholder: { type: "plain_text", text: "宛先プロジェクトを選択" },
            options: this.destinationOptions().map((o) => ({
              ...(o as Record<string, unknown>),
              value: JSON.stringify({ key, projectId: (o as { value: string }).value }),
            })),
          },
        ],
      },
    ];
  }

  private rerouteBlocks(key: string, text: string, currentProjectId: string): unknown[] {
    const options = this.destinationOptions(currentProjectId).map((o) => ({
      ...(o as Record<string, unknown>),
      value: JSON.stringify({ key, projectId: (o as { value: string }).value }),
    }));
    const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text } }];
    if (options.length > 0) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: ACTION_MM_REROUTE,
            placeholder: { type: "plain_text", text: "間違っていたら振り直す" },
            options,
            confirm: {
              title: { type: "plain_text", text: "議事録の振り直し" },
              text: { type: "plain_text", text: "選択したプロジェクトのチャンネルへ議事録を再展開します。登録済みタスクは自動では変更されません。" },
              confirm: { type: "plain_text", text: "振り直す" },
              deny: { type: "plain_text", text: "やめる" },
            },
          },
        ],
      });
    }
    return blocks;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private parseSelectedValue(action: any): { key: string; projectId?: string } | null {
    const raw = action?.selected_option?.value ?? action?.value;
    try {
      const parsed = JSON.parse(raw ?? "");
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
      logger.warn(`[meeting-minutes] ephemeral notice failed: ${err}`);
    }
  }

  private async loadAuthorizedRun(
    body: any,
    value: { key: string } | null,
  ): Promise<{ state: PipelineState; key: string; run: MinutesRun } | null> {
    const userId = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id ?? body?.container?.channel_id;
    if (!value || !userId) return null;
    if (!(await this.operators.canApprove(userId, channelId ?? ""))) {
      logger.warn(`[meeting-minutes] unauthorized action from ${userId}`);
      await this.notifyEphemeral(body, "この操作の権限がありません。");
      return null;
    }
    const state = loadState();
    pruneExpired(state, Date.now());
    const run = state.runs[value.key];
    if (!run) {
      saveState(state);
      await this.notifyEphemeral(body, "この実行は期限切れです。transcriptを再アップロードしてください。");
      return null;
    }
    return { state, key: value.key, run };
  }

  /** Exposed for tests. Operator picked a destination for an unrouted run. */
  async handleChooseDestination(body: any, action: any): Promise<void> {
    const value = this.parseSelectedValue(action);
    const loaded = await this.loadAuthorizedRun(body, value);
    if (!loaded) return;
    const { state, key, run } = loaded;
    if (run.status !== "awaiting_destination") {
      await this.notifyEphemeral(body, "この実行はすでに振り分け済みです。");
      return;
    }
    const destination = this.destinations.find((d) => d.projectId === value?.projectId);
    if (!destination) return;
    run.projectId = destination.projectId;
    run.destinationChannelId = destination.channelId;
    run.routingReason = "operator選択";
    advanceStatus(run, "routed");
    run.updatedAt = Date.now();
    saveState(state);
    await this.updateControl(state, key, { text: `⏳ *${destination.name}* へ展開中…` });
    await this.executeRun(key, Date.now());
  }

  /**
   * Exposed for tests. Reroute a posted run: annotate the wrong parent
   * message, repost into the new destination, never touch registered tasks
   * (their idempotency keys are bound to the original posting — re-running
   * the handoff would double-register).
   */
  async handleReroute(body: any, action: any): Promise<void> {
    const value = this.parseSelectedValue(action);
    const loaded = await this.loadAuthorizedRun(body, value);
    if (!loaded) return;
    const { state, key, run } = loaded;
    if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.posted || !run.minutes) {
      await this.notifyEphemeral(body, "この実行はまだ展開されていないため、振り直しできません。");
      return;
    }
    const next = this.destinations.find((d) => d.projectId === value?.projectId);
    if (!next || next.projectId === run.projectId) return;
    const previous = this.destinations.find((d) => d.projectId === run.projectId);

    try {
      const parent = await this.client.apiCall("chat.postMessage", {
        channel: next.channelId,
        text: run.minutes.overview,
        unfurl_links: false,
      });
      const newParentTs = (parent.ts as string) ?? "";
      for (const chunk of splitForSlack(run.minutes.body)) {
        await this.client.apiCall("chat.postMessage", {
          channel: next.channelId,
          thread_ts: newParentTs,
          text: chunk,
          unfurl_links: false,
        });
      }
      // Annotate (not delete) the old parent — threads may already have replies.
      if (previous && run.postedParentTs) {
        await this.client.apiCall("chat.update", {
          channel: previous.channelId,
          ts: run.postedParentTs,
          text: `⚠️ 振り分け誤りのため <#${next.channelId}> へ移動しました\n\n${run.minutes.overview}`,
        }).catch((err: unknown) => {
          logger.warn(`[meeting-minutes] old parent annotation failed: ${err}`);
        });
      }
      run.projectId = next.projectId;
      run.destinationChannelId = next.channelId;
      run.postedParentTs = newParentTs;
      run.routingReason = "operator振り直し";
      run.updatedAt = Date.now();
      state.lastMinutesByChannel[next.channelId] = {
        title: run.minutes.title,
        overview: run.minutes.overview,
        postedTs: newParentTs,
      };
      saveState(state);
      const summary = `✅ *${next.name}* <#${next.channelId}> へ振り直しました\n${run.minutes.title}\n_登録済みタスクはタスク登録メッセージの取り消し/編集から操作してください_`;
      await this.updateControl(state, key, {
        text: summary,
        blocks: this.rerouteBlocks(key, summary, next.projectId),
      });
    } catch (err) {
      logger.warn(`[meeting-minutes] reroute failed: ${err}`);
      await this.notifyEphemeral(body, `振り直しに失敗しました: ${err}`);
    }
  }

  /** Exposed for tests. Resume a failed run from its failed stage. */
  async handleRetry(body: any, action: any): Promise<void> {
    const value = this.parseSelectedValue(action);
    const loaded = await this.loadAuthorizedRun(body, value);
    if (!loaded) return;
    const { state, key, run } = loaded;
    if (!run.status.startsWith("failed:")) {
      await this.notifyEphemeral(body, "この実行は失敗状態ではありません。");
      return;
    }
    await this.updateControl(state, key, { text: "⏳ 再試行中…" });
    await this.executeRun(key, Date.now());
  }
}
