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
import {
  buildMeetingMinutesFailureControl,
  buildSettingsDeepLink,
  type SettingsDeepLinkTarget,
} from "./settings-deep-link.js";
import {
  normalizeMeetingMinutesDestinations,
  type CanonicalMinutesDestination,
} from "./meeting-minutes-destinations.js";

export interface MeetingMinutesPipelineConfig {
  /** Master switch — defaults to false when the block is absent. */
  enabled?: boolean;
  /**
   * Router channel IDs to watch for .txt uploads. Required; empty = off.
   * Wildcards are rejected; every router must be explicitly allowlisted.
   */
  routerChannels?: string[];
  /** Destination projects. Required; empty = off. */
  destinations?: MinutesDestination[];
  /** Explicitly approved copy targets in other Slack workspaces. Never sent to the LLM. */
  shareDestinations?: MinutesShareDestination[];
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
  /** Legacy state compatibility only; wildcard routing is no longer accepted. */
  inPlace?: boolean;
  projectId?: string;
  destinationId?: string;
  /** LLM proposal only; it is never delivery authority. */
  suggestedProjectId?: string;
  routingReason?: string;
  /** Slack-signed source-workspace operator who made the delivery decision. */
  destinationApprovedBy?: string;
  destinationApprovedAt?: number;
  destinationChannelId?: string;
  destinationConnectorInstanceId?: string;
  destinationWorkspaceId?: string;
  /** Parent (overview) message ts in the destination channel. */
  postedParentTs?: string;
  /** Child message timestamps, retained so a later reroute can scrub stale content. */
  postedThreadTs?: string[];
  /** Durable progress for a reroute whose Slack side effects span several API calls. */
  reroute?: MinutesRerouteRecord;
  /** Durable journal for a refresh whose Slack updates span several API calls. */
  refresh?: MinutesRefreshRecord;
  /** Our control message ts in the router thread (chat.update target). */
  controlTs?: string;
  /** Persisted so reroute can repost without regenerating. */
  minutes?: GeneratedMinutes;
  shares?: Record<string, MinutesShareRecord>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface MinutesRefreshRecord {
  status: "generating" | "updating" | "completed" | "failed";
  approvedBy: string;
  approvedAt: number;
  updatedAt: number;
  /** Generated candidate is kept separate until every Slack mutation succeeds. */
  candidate?: GeneratedMinutes;
  updatedThreadTs: string[];
  postedThreadTs: string[];
  error?: string;
}

export interface MinutesRerouteRecord {
  projectId: string;
  destinationChannelId: string;
  status: "scrubbing" | "posting" | "completed" | "failed";
  scrubbedMessageTs: string[];
  postedParentTs?: string;
  postedThreadTs: string[];
  updatedAt: number;
  error?: string;
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

/** Pseudo project id for wildcard-matched in-place runs (never in config). */
export const IN_PLACE_PROJECT_ID = "__in_place__";

export const ACTION_MM_CHOOSE_DEST = "meeting_minutes_choose_destination";
export const ACTION_MM_CHOOSE_DEST_PATTERN = /^meeting_minutes_choose_destination:\d+:\d+$/;
export const ACTION_MM_REROUTE = "meeting_minutes_reroute";
export const ACTION_MM_RETRY = "meeting_minutes_retry";
export const ACTION_MM_SHARE = "meeting_minutes_share";
export const ACTION_MM_REFRESH = "meeting_minutes_refresh";

export interface MinutesShareDestination {
  /** Opaque, stable key used in Block actions; all target fields are re-read from config. */
  shareId: string;
  projectId: string;
  name: string;
  emoji?: string;
  connectorInstanceId: string;
  workspaceId: string;
  channelId: string;
}

export interface MinutesShareRecord {
  status: "posting" | "posted" | "failed";
  connectorInstanceId: string;
  workspaceId: string;
  channelId: string;
  approvedBy: string;
  approvedAt: number;
  updatedAt: number;
  postedParentTs?: string;
  postedThreadTs?: string[];
  error?: string;
}

export interface MeetingMinutesShareProgress {
  parentTs: string;
  threadTs: string[];
}

export interface MeetingMinutesShareRequest {
  sourceConnectorInstanceId: string;
  destination: MinutesShareDestination;
  minutes: GeneratedMinutes;
  /** Persist target side effects after every successful Slack post; throwing halts delivery. */
  onProgress: (progress: MeetingMinutesShareProgress) => void;
}

export interface MeetingMinutesUpdateRequest extends MeetingMinutesShareRequest {
  existing: MeetingMinutesShareProgress;
}

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

function saveState(state: PipelineState): boolean {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch {
    logger.warn("[meeting-minutes] code=state_persist_failed");
    return false;
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

export interface SlackClientLike {
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
  sourceConnectorInstanceId?: string;
  /** Narrow gateway that resolves the live target connector and posts with its client. */
  shareMinutes?: (request: MeetingMinutesShareRequest) => Promise<{ parentTs: string }>;
  /** Dedicated update gateway; target identity and channel authority are revalidated remotely. */
  updateMinutes?: (request: MeetingMinutesUpdateRequest) => Promise<MeetingMinutesShareProgress>;
  /** Fixed operator Web origin. Credentials and error text are never added to it. */
  settingsWebBaseUrl?: string;
  /** Runtime workspace identity discovered by auth.test after construction. */
  getWorkspaceId?: () => string | null | undefined;
}

export class MeetingMinutesPipeline {
  private readonly app: App;
  private readonly client: SlackClientLike;
  private readonly enabled: boolean;
  private readonly routerChannels: Set<string>;
  private readonly watchAllChannels: boolean;
  private readonly destinations: CanonicalMinutesDestination[];
  private readonly shareDestinations: MinutesShareDestination[];
  private readonly invalidWildcardConfig: boolean;
  private readonly operators: ApproverResolver;
  private readonly operatorsEmpty: boolean;
  private readonly maxFileBytes: number;
  private readonly ttlMs: number;
  private readonly routingOptions: MinutesLlmOptions;
  private readonly generationOptions: MinutesLlmOptions;
  private readonly deps: MeetingMinutesPipelineDeps;
  /** One lock per run for every state-changing action. */
  private readonly runLocks = new Set<string>();
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
    const configuredRouters = (config.routerChannels ?? []).map((value) => value.trim()).filter(Boolean);
    this.invalidWildcardConfig = configuredRouters.includes("*");
    this.routerChannels = new Set(configuredRouters.filter((value) => value !== "*"));
    this.watchAllChannels = false;
    this.shareDestinations = (config.shareDestinations ?? []).filter(
      (d) =>
        d &&
        d.shareId &&
        d.projectId &&
        d.name &&
        d.connectorInstanceId &&
        d.workspaceId &&
        d.channelId,
    );
    this.destinations = normalizeMeetingMinutesDestinations({
      sourceConnectorInstanceId: deps.sourceConnectorInstanceId ?? "slack",
      destinations: config.destinations,
      shareDestinations: this.shareDestinations,
    });
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
    if (this.invalidWildcardConfig) {
      logger.warn('[meeting-minutes] invalid routerChannels: "*" is forbidden — feature not started');
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
      } catch {
        logger.warn("[meeting-minutes] code=message_handler_failed");
      }
    });

    const wrap = (fn: (body: any, action: any) => Promise<void>) => async ({ ack, body, action }: any) => {
      await ack();
      await fn(body, action).catch(() => {
        logger.warn("[meeting-minutes] code=action_handler_failed");
      });
    };
    this.app.action(ACTION_MM_CHOOSE_DEST, wrap((body, action) => this.handleChooseDestination(body, action)));
    this.app.action(ACTION_MM_CHOOSE_DEST_PATTERN, wrap((body, action) => this.handleChooseDestination(body, action)));
    this.app.action(ACTION_MM_REROUTE, wrap((body, action) => this.handleReroute(body, action)));
    this.app.action(ACTION_MM_RETRY, wrap((body, action) => this.handleRetry(body, action)));
    this.app.action(ACTION_MM_REFRESH, wrap((body, action) => this.handleRefresh(body, action)));
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
    if (!channel || !ts) return;
    if (!this.watchAllChannels && !this.routerChannels.has(channel)) return;
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

    // Explicit router channels route via LLM classification; channels matched
    // only by the "*" wildcard expand the minutes in place instead.
    const inPlace = this.watchAllChannels && !this.routerChannels.has(channel);
    const run: MinutesRun = {
      routerChannelId: channel,
      fileId,
      sourceTs: ts,
      fileName: (file.name as string) ?? "transcript.txt",
      sourceTextHash: "",
      status: "received",
      ...(inPlace ? { inPlace: true, destinationChannelId: channel } : {}),
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

    // Stage: routing (skipped for in-place runs and when a destination is fixed).
    if (
      (!run.projectId || !run.destinationApprovedBy || !run.destinationApprovedAt) &&
      !run.inPlace
    ) {
      const classify = this.deps.classifyImpl ?? classifyMinutesDestination;
      const legacyProposal = run.projectId
        ? this.destinations.find((destination) => destination.projectId === run.projectId)
        : undefined;
      const routed = legacyProposal
        ? { destination: legacyProposal, reason: "旧stateの未確認宛先" }
        : await classify(transcript.text, this.destinations, this.routingOptions);
      advanceStatus(run, "awaiting_destination");
      run.projectId = undefined;
      run.destinationId = undefined;
      run.destinationChannelId = undefined;
      if (routed) {
        run.suggestedProjectId = routed.destination.projectId;
        run.routingReason = routed.reason;
      }
      run.updatedAt = now;
      saveState(state);
      const proposal = routed
        ? `候補は *${routed.destination.name}* です。投稿前に宛先を確認してください。${routed.reason ? `\n_推定根拠: ${routed.reason}_` : ""}`
        : "❓ どのプロジェクトの会議か判定できませんでした。宛先を選んでください。";
      await this.updateControl(state, key, {
        text: proposal,
        blocks: this.destinationSelectBlocks(key, proposal),
      });
      return; // resumes only after an authorized operator selection
    }

    const destination = run.inPlace
      ? {
          projectId: IN_PLACE_PROJECT_ID,
          name: run.fileName.replace(/\.txt$/i, ""),
          channelId: run.destinationChannelId ?? run.routerChannelId,
        }
      : this.destinations.find((d) => d.destinationId === run.destinationId);
    if (!destination) {
      await this.failRun(state, key, "route", `宛先プロジェクト ${run.projectId} がconfigにありません`);
      return;
    }
    if (
      !run.inPlace &&
      (run.destinationConnectorInstanceId !== ("connectorInstanceId" in destination ? destination.connectorInstanceId : undefined) ||
        run.destinationWorkspaceId !== ("workspaceId" in destination ? destination.workspaceId : undefined) ||
        run.destinationChannelId !== destination.channelId)
    ) {
      await this.failRun(state, key, "route", "承認後に宛先設定が変更されたため投稿を中止しました");
      return;
    }

    // Stage: generation (with one automatic retry on contract violations).
    if (!run.minutes) {
      const generated = await this.generateWithRetry(transcript.text, destination, state, now);
      if ("error" in generated) {
        await this.failRun(state, key, "generate", "議事録生成に失敗しました");
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
        const connectorInstanceId = "connectorInstanceId" in destination
          ? destination.connectorInstanceId
          : this.deps.sourceConnectorInstanceId;
        const isRemote = connectorInstanceId !== this.deps.sourceConnectorInstanceId;
        if (isRemote) {
          const deliver = this.deps.shareMinutes;
          const sourceConnectorInstanceId = this.deps.sourceConnectorInstanceId;
          const workspaceId = "workspaceId" in destination ? destination.workspaceId : undefined;
          const destinationId = "destinationId" in destination ? destination.destinationId : undefined;
          if (!deliver || !sourceConnectorInstanceId || !workspaceId || !destinationId || !connectorInstanceId) {
            throw new Error("target delivery connector is unavailable");
          }
          if (run.postedParentTs) {
            throw new Error("partial remote delivery requires operator review");
          }
          const result = await deliver({
            sourceConnectorInstanceId,
            destination: {
              shareId: destinationId,
              projectId: destination.projectId,
              name: destination.name,
              connectorInstanceId,
              workspaceId,
              channelId: destination.channelId,
            },
            minutes,
            onProgress: ({ parentTs, threadTs }) => {
              const freshRun = state.runs[key];
              if (!freshRun || freshRun.destinationId !== destinationId) {
                throw new Error("delivery authority state is unavailable");
              }
              freshRun.postedParentTs = parentTs;
              freshRun.postedThreadTs = [...threadTs];
              if (!saveState(state)) throw new Error("delivery progress could not be persisted");
            },
          });
          run.postedParentTs = result.parentTs;
          run.postedThreadTs ??= [];
        } else if (!run.postedParentTs) {
          if (
            "workspaceId" in destination && destination.workspaceId &&
            this.deps.getWorkspaceId?.() !== destination.workspaceId
          ) {
            throw new Error("source workspace identity mismatch");
          }
          const parent = await this.client.apiCall("chat.postMessage", {
            channel: destination.channelId,
            text: minutes.overview,
            unfurl_links: false,
          });
          if (typeof parent.ts !== "string" || !parent.ts) {
            throw new Error("parent post returned no timestamp");
          }
          run.postedParentTs = parent.ts;
          run.postedThreadTs = [];
          saveState(state);
        }
        const chunks = splitForSlack(minutes.body);
        for (const chunk of (isRemote ? [] : chunks.slice(run.postedThreadTs?.length ?? 0))) {
          const child = await this.client.apiCall("chat.postMessage", {
            channel: destination.channelId,
            thread_ts: run.postedParentTs,
            text: chunk,
            unfurl_links: false,
          });
          const childTs = child.ts as string | undefined;
          if (!childTs) throw new Error("thread post returned no timestamp");
          run.postedThreadTs ??= [];
          run.postedThreadTs.push(childTs);
          saveState(state);
        }
      } catch {
        await this.failRun(state, key, "post", "議事録の投稿に失敗しました");
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
      const notifier = "connectorInstanceId" in destination &&
        destination.connectorInstanceId !== this.deps.sourceConnectorInstanceId
        ? null
        : this.deps.taskProposalNotifier;
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
        } catch {
          logger.warn(`[meeting-minutes] code=task_handoff_failed run=${key}`);
          handoffNote = "\n⚠️ タスク自動登録に失敗しました（議事録の展開は成功）。";
        }
      } else {
        handoffNote = "\n⚠️ タスク自動登録は未接続です。";
      }
      run.updatedAt = now;
      saveState(state);
    }

    const summary = run.inPlace
      ? `✅ このチャンネルへ議事録を展開しました\n${minutes.title}${handoffNote}`
      : `✅ *${destination.name}* <#${destination.channelId}> へ議事録を展開しました\n${minutes.title}${run.routingReason ? `\n_振り分け根拠: ${run.routingReason}_` : ""}${handoffNote}`;
    await this.updateControl(state, key, {
      text: summary,
      blocks: this.successBlocks(
        key,
        summary,
        "destinationId" in destination ? destination.destinationId : IN_PLACE_PROJECT_ID,
        minutes.overview,
      ),
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
        logger.warn(`[meeting-minutes] code=generation_contract_invalid attempt=${attempt}`);
        if (attempt === 2) return result;
      } catch (err) {
        logger.warn(`[meeting-minutes] code=generation_attempt_failed attempt=${attempt}`);
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
    } catch {
      logger.warn("[meeting-minutes] code=open_task_context_unavailable");
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
    } catch {
      logger.warn("[meeting-minutes] code=transcript_fetch_failed");
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
    } catch {
      logger.warn("[meeting-minutes] code=control_message_failed");
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
    logger.warn(`[meeting-minutes] code=run_failed stage=${stage} run=${key}`);
    await this.updateControl(state, key, buildMeetingMinutesFailureControl({
      key,
      message,
      settingsWebBaseUrl: this.deps.settingsWebBaseUrl,
      retryActionId: ACTION_MM_RETRY,
      target: {
        workspaceId: this.deps.getWorkspaceId?.() ?? undefined,
        projectId: run.projectId,
        channelId: run.destinationChannelId ?? run.routerChannelId,
      },
    }));
  }

  private settingsLink(target: SettingsDeepLinkTarget): string | null {
    return buildSettingsDeepLink(this.deps.settingsWebBaseUrl, {
      workspaceId: target.workspaceId ?? this.deps.getWorkspaceId?.() ?? undefined,
      projectId: target.projectId,
      channelId: target.channelId,
    });
  }

  private destinationOptions(excludeDestinationId?: string): unknown[] {
    return this.destinations
      .filter((d) => d.destinationId !== excludeDestinationId)
      .slice(0, 100)
      .map((d) => ({
        text: {
          type: "plain_text",
          text: `${d.emoji ?? "📁"} ${d.name}`.slice(0, 75),
          emoji: true,
        },
        value: d.destinationId,
      }));
  }

  private destinationSelectBlocks(key: string, text: string): unknown[] {
    const options = this.destinationOptions();
    const rows: unknown[] = [];
    for (let offset = 0; offset < options.length; offset += 5) {
      const rowIndex = offset / 5;
      rows.push({
        type: "actions",
        elements: options.slice(offset, offset + 5).map((option, columnIndex) => ({
          type: "button",
          action_id: `${ACTION_MM_CHOOSE_DEST}:${rowIndex}:${columnIndex}`,
          style: "primary",
          text: (option as { text: unknown }).text,
          value: JSON.stringify({ key, destinationId: (option as { value: string }).value }),
        })),
      });
    }
    return [{ type: "section", text: { type: "mrkdwn", text } }, ...rows];
  }

  private rerouteBlocks(key: string, text: string, currentDestinationId: string): unknown[] {
    const options = this.destinationOptions(currentDestinationId).map((o) => ({
      ...(o as Record<string, unknown>),
      value: JSON.stringify({ key, destinationId: (o as { value: string }).value }),
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

  private successBlocks(
    key: string,
    text: string,
    currentDestinationId: string,
    overview: string,
  ): unknown[] {
    const blocks = this.rerouteBlocks(key, text, currentDestinationId);
    const safeOverview = overview.length > 2800 ? `${overview.slice(0, 2799)}…` : overview;
    blocks.splice(1, 0, {
      type: "section",
      text: { type: "mrkdwn", text: `*📝 会議の概要*\n${safeOverview}` },
    });
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        action_id: ACTION_MM_REFRESH,
        text: { type: "plain_text", text: "🔄 議事録を更新", emoji: true },
        value: JSON.stringify({ key }),
        confirm: {
          title: { type: "plain_text", text: "議事録を更新" },
          text: { type: "plain_text", text: "同じTXTから最新ロジックで再生成し、既存の議事録を上書きします。登録済みタスクは変更しません。" },
          confirm: { type: "plain_text", text: "更新する" },
          deny: { type: "plain_text", text: "やめる" },
        },
      }],
    });
    return blocks;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private parseSelectedValue(action: any): { key: string; destinationId?: string; projectId?: string; shareId?: string } | null {
    const raw = action?.selected_option?.value ?? action?.value;
    try {
      const parsed = JSON.parse(raw ?? "");
      if (parsed && typeof parsed.key === "string") return parsed;
    } catch {
      /* fall through */
    }
    return null;
  }

  private async notifyEphemeral(
    body: any,
    message: string,
    target?: SettingsDeepLinkTarget,
  ): Promise<void> {
    const channel = body?.channel?.id ?? body?.container?.channel_id;
    const user = body?.user?.id;
    if (!channel || !user) return;
    try {
      const settingsUrl = target ? this.settingsLink(target) : null;
      await this.client.apiCall("chat.postEphemeral", {
        channel,
        user,
        text: settingsUrl ? `${message}\n構成を確認: ${settingsUrl}` : message,
      });
    } catch {
      logger.warn("[meeting-minutes] code=ephemeral_notice_failed");
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
      await this.notifyEphemeral(body, "この操作の権限がありません。", { channelId });
      return null;
    }
    const state = loadState();
    pruneExpired(state, Date.now());
    const run = state.runs[value.key];
    if (!run) {
      saveState(state);
      await this.notifyEphemeral(body, "この実行は期限切れです。transcriptを再アップロードしてください。", { channelId });
      return null;
    }
    if (!channelId || channelId !== run.routerChannelId) {
      logger.warn(`[meeting-minutes] action channel mismatch for ${value.key}`);
      await this.notifyEphemeral(body, "この操作元が議事録の実行チャンネルと一致しません。", {
        projectId: run.projectId,
        channelId: run.routerChannelId,
      });
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
    const destination = this.destinations.find((d) =>
      d.destinationId === value?.destinationId ||
      (!value?.destinationId && d.projectId === value?.projectId),
    );
    if (!destination) return;
    run.projectId = destination.projectId;
    run.destinationId = destination.destinationId;
    run.destinationConnectorInstanceId = destination.connectorInstanceId;
    run.destinationWorkspaceId = destination.workspaceId;
    run.destinationChannelId = destination.channelId;
    run.routingReason = "operator選択";
    run.destinationApprovedBy = body.user.id;
    run.destinationApprovedAt = Date.now();
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
    const lockKey = value?.key;
    if (lockKey && this.runLocks.has(lockKey)) {
      await this.notifyEphemeral(body, "この議事録では別の操作が進行中です。");
      return;
    }
    if (lockKey) this.runLocks.add(lockKey);
    try {
    const loaded = await this.loadAuthorizedRun(body, value);
    if (!loaded) return;
    const { state, key, run } = loaded;
    if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.posted || !run.minutes) {
      await this.notifyEphemeral(body, "この実行はまだ展開されていないため、振り直しできません。");
      return;
    }
    const next = this.destinations.find((d) =>
      d.destinationId === value?.destinationId ||
      (!value?.destinationId && d.projectId === value?.projectId),
    );
    if (!next || next.destinationId === run.destinationId) return;
    if (
      next.connectorInstanceId !== this.deps.sourceConnectorInstanceId ||
      run.destinationConnectorInstanceId !== this.deps.sourceConnectorInstanceId
    ) {
      await this.notifyEphemeral(body, "workspaceをまたぐ振り直しは未対応です。投稿の重複を避けるため実行しません。");
      return;
    }
    const previousChannelId = run.destinationChannelId;
    if (run.reroute && run.reroute.status !== "completed") {
      await this.notifyEphemeral(
        body,
        "前回の振り直し結果が未確定です。重複投稿を避けるため自動再実行しません。",
      );
      return;
    }

    run.reroute = {
      projectId: next.projectId,
      destinationChannelId: next.channelId,
      status: "scrubbing",
      scrubbedMessageTs: [],
      postedThreadTs: [],
      updatedAt: Date.now(),
    };
    saveState(state);

    try {
      // Remove the generated content from the wrong destination before
      // reposting. Keep a small audit marker instead of leaking the old text.
      if (previousChannelId && run.postedParentTs) {
        await this.client.apiCall("chat.update", {
          channel: previousChannelId,
          ts: run.postedParentTs,
          text: `⚠️ 振り分け誤りのため <#${next.channelId}> へ移動しました`,
          blocks: [],
        });
        run.reroute.scrubbedMessageTs.push(run.postedParentTs);
        run.reroute.updatedAt = Date.now();
        saveState(state);
        for (const threadTs of run.postedThreadTs ?? []) {
          await this.client.apiCall("chat.update", {
            channel: previousChannelId,
            ts: threadTs,
            text: "（振り分け誤りのため議事録本文を移動しました）",
            blocks: [],
          });
          run.reroute.scrubbedMessageTs.push(threadTs);
          run.reroute.updatedAt = Date.now();
          saveState(state);
        }
      }
      run.reroute.status = "posting";
      run.reroute.updatedAt = Date.now();
      saveState(state);
      const parent = await this.client.apiCall("chat.postMessage", {
        channel: next.channelId,
        text: run.minutes.overview,
        unfurl_links: false,
      });
      if (typeof parent.ts !== "string" || !parent.ts) {
        throw new Error("reroute parent post returned no timestamp");
      }
      const newParentTs = parent.ts;
      run.reroute.postedParentTs = newParentTs;
      run.reroute.updatedAt = Date.now();
      saveState(state);
      const newThreadTs: string[] = [];
      for (const chunk of splitForSlack(run.minutes.body)) {
        const child = await this.client.apiCall("chat.postMessage", {
          channel: next.channelId,
          thread_ts: newParentTs,
          text: chunk,
          unfurl_links: false,
        });
        if (typeof child.ts !== "string" || !child.ts) {
          throw new Error("reroute thread post returned no timestamp");
        }
        newThreadTs.push(child.ts);
        run.reroute.postedThreadTs.push(child.ts);
        run.reroute.updatedAt = Date.now();
        saveState(state);
      }
      run.projectId = next.projectId;
      run.destinationId = next.destinationId;
      run.destinationConnectorInstanceId = next.connectorInstanceId;
      run.destinationWorkspaceId = next.workspaceId;
      run.destinationChannelId = next.channelId;
      run.inPlace = false;
      run.postedParentTs = newParentTs;
      run.postedThreadTs = newThreadTs;
      run.routingReason = "operator振り直し";
      run.destinationApprovedBy = body.user.id;
      run.destinationApprovedAt = Date.now();
      run.reroute.status = "completed";
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
        blocks: this.successBlocks(key, summary, next.destinationId, run.minutes.overview),
      });
    } catch (err) {
      run.reroute = {
        ...(run.reroute ?? {
          projectId: next.projectId,
          destinationChannelId: next.channelId,
          scrubbedMessageTs: [],
          postedThreadTs: [],
        }),
        status: "failed",
        error: String(err).slice(0, 300),
        updatedAt: Date.now(),
      };
      saveState(state);
      logger.warn(`[meeting-minutes] code=reroute_failed run=${key}`);
      await this.notifyEphemeral(
        body,
        "振り直しに失敗しました。旧・新投稿が一部残っている可能性があるため自動再実行しません。",
        { projectId: next.projectId, channelId: next.channelId },
      );
    }
    } finally {
      if (lockKey) this.runLocks.delete(lockKey);
    }
  }

  /** Explicitly copy generated minutes to a configured destination in another workspace. */
  async handleShareMinutes(body: any, action: any): Promise<void> {
    const value = this.parseSelectedValue(action);
    // The state file is a whole-run snapshot. Lock the run, not the destination,
    // so simultaneous shares to different targets cannot overwrite each other.
    const lockKey = value?.key ?? null;
    if (lockKey && this.runLocks.has(lockKey)) {
      await this.notifyEphemeral(body, "この共有先への処理はすでに進行中です。");
      return;
    }
    if (lockKey) this.runLocks.add(lockKey);
    try {
      const loaded = await this.loadAuthorizedRun(body, value);
      if (!loaded) return;
      const { state, key, run } = loaded;
      if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.posted || !run.minutes) {
        await this.notifyEphemeral(body, "議事録の通常投稿が完了するまで共有できません。");
        return;
      }
      const destination = this.shareDestinations.find(
        (candidate) =>
          candidate.shareId === value?.shareId && candidate.projectId === run.projectId,
      );
      if (!destination) {
        await this.notifyEphemeral(body, "共有先が現在の設定と一致しません。共有を中止しました。", {
          projectId: run.projectId,
          channelId: run.destinationChannelId ?? run.routerChannelId,
        });
        return;
      }
      const existing = run.shares?.[destination.shareId];
      if (existing) {
        await this.notifyEphemeral(
          body,
          existing.status === "posted"
            ? "この共有先への議事録共有は完了済みです。"
            : "前回の共有状態を確認できないため再送しません。運用担当者が確認してください。",
        );
        return;
      }
      const share = this.deps.shareMinutes;
      const sourceConnectorInstanceId = this.deps.sourceConnectorInstanceId;
      if (!share || !sourceConnectorInstanceId) {
        await this.notifyEphemeral(body, "共有用connectorが未接続です。投稿は行いませんでした。", {
          workspaceId: destination.workspaceId,
          projectId: destination.projectId,
          channelId: destination.channelId,
        });
        return;
      }
      const now = Date.now();
      run.shares ??= {};
      run.shares[destination.shareId] = {
        status: "posting",
        connectorInstanceId: destination.connectorInstanceId,
        workspaceId: destination.workspaceId,
        channelId: destination.channelId,
        approvedBy: body.user.id,
        approvedAt: now,
        updatedAt: now,
      };
      if (!saveState(state)) {
        await this.notifyEphemeral(body, "共有承認を永続化できなかったため投稿しませんでした。");
        return;
      }
      try {
        const result = await share({
          sourceConnectorInstanceId,
          destination,
          minutes: run.minutes,
          onProgress: ({ parentTs, threadTs }) => {
            const progressState = loadState();
            const progressShare = progressState.runs[key]?.shares?.[destination.shareId];
            if (!progressShare || progressShare.status !== "posting") {
              throw new Error("share authority state is unavailable");
            }
            progressShare.postedParentTs = parentTs;
            progressShare.postedThreadTs = [...threadTs];
            progressShare.updatedAt = Date.now();
            if (!saveState(progressState)) throw new Error("share progress could not be persisted");
          },
        });
        const fresh = loadState();
        const freshRun = fresh.runs[key];
        if (!freshRun?.shares?.[destination.shareId]) return;
        freshRun.shares[destination.shareId] = {
          ...freshRun.shares[destination.shareId],
          status: "posted",
          postedParentTs: result.parentTs,
          updatedAt: Date.now(),
        };
        saveState(fresh);
        await this.postControl(run.routerChannelId, run.sourceTs, undefined, {
          text: `✅ ${destination.name} へ議事録を共有しました。`,
        });
      } catch (err) {
        const fresh = loadState();
        const freshRun = fresh.runs[key];
        if (freshRun?.shares?.[destination.shareId]) {
          freshRun.shares[destination.shareId] = {
            ...freshRun.shares[destination.shareId],
            status: "failed",
            error: String(err).slice(0, 300),
            updatedAt: Date.now(),
          };
          saveState(fresh);
        }
        await this.postControl(run.routerChannelId, run.sourceTs, undefined, {
          text: `⚠️ ${destination.name} への共有に失敗しました。重複防止のため自動再送はしません。${this.settingsLink({ workspaceId: destination.workspaceId, projectId: destination.projectId, channelId: destination.channelId }) ? `\n構成を確認: ${this.settingsLink({ workspaceId: destination.workspaceId, projectId: destination.projectId, channelId: destination.channelId })}` : ""}`,
        });
      }
    } finally {
      if (lockKey) this.runLocks.delete(lockKey);
    }
  }

  /** Regenerate from the immutable Slack file and overwrite the existing destination posts. */
  async handleRefresh(body: any, action: any): Promise<void> {
    const value = this.parseSelectedValue(action);
    const lockKey = value?.key;
    if (lockKey && this.runLocks.has(lockKey)) {
      await this.notifyEphemeral(body, "この議事録はすでに更新中です。");
      return;
    }
    if (lockKey) this.runLocks.add(lockKey);
    try {
      const loaded = await this.loadAuthorizedRun(body, value);
      if (!loaded) return;
      const { state, key, run } = loaded;
      if ((STATUS_RANK[run.status] ?? -1) < STATUS_RANK.posted || !run.minutes || !run.postedParentTs) {
        await this.notifyEphemeral(body, "議事録の展開が完了していないため更新できません。");
        return;
      }
      const destination = run.inPlace
        ? {
            projectId: IN_PLACE_PROJECT_ID,
            name: run.fileName.replace(/\.txt$/i, ""),
            channelId: run.destinationChannelId ?? run.routerChannelId,
          }
        : this.destinations.find((candidate) => candidate.destinationId === run.destinationId);
      if (!destination || destination.channelId !== run.destinationChannelId) {
        await this.notifyEphemeral(body, "現在の宛先設定と一致しないため更新を中止しました。");
        return;
      }
      if (
        !run.inPlace &&
        (!("connectorInstanceId" in destination) ||
          run.destinationConnectorInstanceId !== destination.connectorInstanceId ||
          run.destinationWorkspaceId !== destination.workspaceId)
      ) {
        await this.notifyEphemeral(body, "connectorまたはworkspace設定が変更されたため更新を中止しました。");
        return;
      }

      const now = Date.now();
      const resumable = run.refresh?.status === "failed" && run.refresh.candidate;
      run.refresh = resumable
        ? { ...run.refresh!, status: "updating", error: undefined, updatedAt: now }
        : {
            status: "generating",
            approvedBy: body.user.id,
            approvedAt: now,
            updatedAt: now,
            updatedThreadTs: [],
            postedThreadTs: [...(run.postedThreadTs ?? [])],
          };
      if (!saveState(state)) {
        await this.notifyEphemeral(body, "更新開始を永続化できなかったため処理しませんでした。");
        return;
      }
      await this.updateControl(state, key, { text: "⏳ 同じTXTから議事録を更新中…" });

      if (!run.refresh.candidate) {
        const transcript = await (this.deps.fetchTranscript ?? this.fetchTranscriptDefault.bind(this))(run.fileId);
        if (!transcript?.text.trim() || sha256Hex(transcript.text) !== run.sourceTextHash) {
          throw new Error("source transcript is unavailable or changed");
        }
        const generated = await this.generateWithRetry(transcript.text, destination, state, now);
        if ("error" in generated) throw new Error("minutes generation failed");
        run.refresh.candidate = generated.minutes;
        run.refresh.status = "updating";
        run.refresh.updatedAt = Date.now();
        if (!saveState(state)) throw new Error("refresh candidate could not be persisted");
      }

      const candidate = run.refresh.candidate;
      const existing = {
        parentTs: run.postedParentTs,
        threadTs: [...(run.postedThreadTs ?? [])],
      };
      const connectorInstanceId = "connectorInstanceId" in destination
        ? destination.connectorInstanceId
        : this.deps.sourceConnectorInstanceId;
      const isRemote = connectorInstanceId !== this.deps.sourceConnectorInstanceId;
      let result: MeetingMinutesShareProgress;
      if (isRemote) {
        const update = this.deps.updateMinutes;
        const sourceConnectorInstanceId = this.deps.sourceConnectorInstanceId;
        if (!update || !sourceConnectorInstanceId || !("workspaceId" in destination) || !destination.workspaceId) {
          throw new Error("target update connector is unavailable");
        }
        result = await update({
          sourceConnectorInstanceId,
          destination: {
            shareId: destination.destinationId,
            projectId: destination.projectId,
            name: destination.name,
            connectorInstanceId: destination.connectorInstanceId,
            workspaceId: destination.workspaceId,
            channelId: destination.channelId,
          },
          minutes: candidate,
          existing,
          onProgress: (progress) => {
            run.refresh!.postedThreadTs = [...progress.threadTs];
            run.refresh!.updatedAt = Date.now();
            if (!saveState(state)) throw new Error("refresh progress could not be persisted");
          },
        });
      } else {
        if (
          "workspaceId" in destination && destination.workspaceId &&
          this.deps.getWorkspaceId?.() !== destination.workspaceId
        ) throw new Error("source workspace identity mismatch");
        result = await this.updateLocalMinutes(destination.channelId, candidate, existing, (progress) => {
          run.refresh!.postedThreadTs = [...progress.threadTs];
          run.refresh!.updatedAt = Date.now();
          if (!saveState(state)) throw new Error("refresh progress could not be persisted");
        });
      }

      // Commit official state only after all Slack mutations completed.
      run.minutes = candidate;
      run.postedThreadTs = [...result.threadTs];
      run.refresh.status = "completed";
      run.refresh.updatedAt = Date.now();
      run.updatedAt = Date.now();
      state.lastMinutesByChannel[destination.channelId] = {
        title: candidate.title,
        overview: candidate.overview,
        postedTs: run.postedParentTs,
      };
      if (!saveState(state)) throw new Error("completed refresh could not be persisted");
      const summary = `✅ *${destination.name}* <#${destination.channelId}> の議事録を更新しました\n${candidate.title}\n_登録済みタスクは変更していません_`;
      await this.updateControl(state, key, {
        text: summary,
        blocks: this.successBlocks(
          key,
          summary,
          "destinationId" in destination ? destination.destinationId : IN_PLACE_PROJECT_ID,
          candidate.overview,
        ),
      });
    } catch (err) {
      if (lockKey) {
        const failed = loadState();
        const failedRun = failed.runs[lockKey];
        if (failedRun?.refresh) {
          failedRun.refresh.status = "failed";
          failedRun.refresh.error = String(err).slice(0, 300);
          failedRun.refresh.updatedAt = Date.now();
          saveState(failed);
          if (failedRun.minutes) {
            const destinationName = failedRun.inPlace
              ? failedRun.fileName.replace(/\.txt$/i, "")
              : this.destinations.find((candidate) => candidate.destinationId === failedRun.destinationId)?.name
                ?? "現在の宛先";
            const failureText =
              `⚠️ *${destinationName}* の議事録更新に失敗しました\n` +
              "既存の議事録は保持しています。同じボタンから更新を再開できます。";
            await this.updateControl(failed, lockKey, {
              text: failureText,
              blocks: this.successBlocks(
                lockKey,
                failureText,
                failedRun.inPlace ? IN_PLACE_PROJECT_ID : failedRun.destinationId ?? IN_PLACE_PROJECT_ID,
                failedRun.minutes.overview,
              ),
            });
          }
        }
      }
      const errorMessage = (err instanceof Error ? err.message : String(err))
        .replace(/[\r\n]+/g, " ")
        .slice(0, 300);
      logger.warn(
        `[meeting-minutes] code=refresh_failed run=${lockKey ?? "unknown"} error=${errorMessage}`,
      );
      await this.notifyEphemeral(body, "議事録の更新に失敗しました。既存内容を正本として保持し、同じ更新ボタンから再開できます。");
    } finally {
      if (lockKey) this.runLocks.delete(lockKey);
    }
  }

  private async updateLocalMinutes(
    channelId: string,
    minutes: GeneratedMinutes,
    existing: MeetingMinutesShareProgress,
    onProgress: (progress: MeetingMinutesShareProgress) => void,
  ): Promise<MeetingMinutesShareProgress> {
    const desired = splitForSlack(minutes.body);
    const threadTs = [...existing.threadTs];
    for (let i = 0; i < desired.length; i++) {
      if (threadTs[i]) {
        await this.client.apiCall("chat.update", { channel: channelId, ts: threadTs[i], text: desired[i], blocks: [] });
      } else {
        const posted = await this.client.apiCall("chat.postMessage", {
          channel: channelId, thread_ts: existing.parentTs, text: desired[i], unfurl_links: false,
        });
        if (typeof posted.ts !== "string" || !posted.ts) throw new Error("refresh thread post returned no timestamp");
        threadTs.push(posted.ts);
      }
      onProgress({ parentTs: existing.parentTs, threadTs });
    }
    for (let i = desired.length; i < threadTs.length; i++) {
      await this.client.apiCall("chat.update", {
        channel: channelId, ts: threadTs[i], text: "（更新により置換済み）", blocks: [],
      });
      onProgress({ parentTs: existing.parentTs, threadTs });
    }
    // Parent is the commit marker and is updated last.
    await this.client.apiCall("chat.update", {
      channel: channelId, ts: existing.parentTs, text: minutes.overview, blocks: [],
    });
    return { parentTs: existing.parentTs, threadTs };
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
