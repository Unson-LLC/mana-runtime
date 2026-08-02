import fs from "node:fs";
import { createHash } from "node:crypto";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  JinnConfig,
  PlacementProfile,
  Session,
  Target,
} from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import {
  accumulateSessionCost,
  createSession,
  deleteSession,
  getSession,
  getSessionBySessionKey,
  getMessages,
  insertMessage,
  updateSession,
} from "./registry.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "./callbacks.js";
import { buildContext } from "./context.js";
import { normalizeDelivery, normalizeTurns, deliverPublic, type DeliveryContext } from "./reply-disposition.js";
import { SessionQueue } from "./queue.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, isDeadSessionError, isPoisonedTranscriptError, isTransientServerError } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit, recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { isOperatorSpeaker } from "../shared/operator-match.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { checkBudget, getPlacementBudgetStatus, shouldNotifyPlacementBudgetWarning } from "../gateway/budgets.js";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../mcp/resolver.js";
import { buildCriticalReviewPrompt, classifyCriticalTask } from "./critical-routing.js";
import {
  formatDevelopmentResult,
  runDevelopmentRequest,
  type DevelopmentAnswer,
  type DevelopmentContinueGatesRequest,
  type DevelopmentProgress,
  type DevelopmentResult,
} from "./development-runner.js";
import {
  recordPendingDevelopmentRun,
  removePendingDevelopmentRun,
  type PendingDevelopmentRun,
} from "./development-pending.js";
import { reconcilePendingDevelopmentRuns } from "./development-reconciler.js";
import { placementDeliveryTargets, placementMcpServerNames, runPlacementBoundEngine, supportsPlacementEngine } from "../shared/placement-profile.js";
import { placementConfigRevision } from "../shared/security-events.js";
import { getSessionDelegationToken, SESSION_DELEGATION_HEADER } from "./delegation-auth.js";

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
  placement?: PlacementProfile;
  criticalRouting?: {
    enabled?: boolean;
    reviewerEmployee?: string;
  };
}

/**
 * Control slash commands handled by {@link SessionManager.handleCommand}.
 * Connectors should treat a message that begins with one of these as a bare
 * command and NOT wrap it with conversation context — handleCommand() matches
 * them by exact string / prefix, so any preamble breaks the parsing.
 */
export const SLASH_COMMANDS = ["/new", "/status", "/model", "/doctor", "/cron", "/develop"] as const;

/** True when `text` begins with a control slash command (see {@link SLASH_COMMANDS}). */
export function startsWithSlashCommand(text: string): boolean {
  const t = text.trimStart();
  return SLASH_COMMANDS.some((cmd) => t === cmd || t.startsWith(`${cmd} `));
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

function mergeTransportMeta(
  existing: Session["transportMeta"],
  incoming: IncomingMessage["transportMeta"],
): Session["transportMeta"] {
  const baseExisting = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  const baseIncoming = (incoming && typeof incoming === "object" && !Array.isArray(incoming))
    ? (incoming as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { ...baseExisting, ...baseIncoming };

  // Preserve Jinn internal keys from being overwritten by transport adapters.
  for (const key of ["engineOverride", "engineSessions", "claudeSyncSince", "criticalRouting"]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }

  return merged as any;
}

function placementTransportMeta(meta: Session["transportMeta"]): Session["transportMeta"] {
  const clean = { ...((meta || {}) as Record<string, unknown>) };
  for (const key of ["engineOverride", "engineSessions", "claudeSyncSince"]) delete clean[key];
  return clean as Session["transportMeta"];
}

const MAX_PROGRESS_MESSAGE_CHARS = 200;

/**
 * Renders one `DevelopmentProgress` snapshot from the isolated `/vibepro`
 * runner as the text for an editable, in-thread progress message. Real-world
 * testing showed Slack's assistant status API (`setTypingStatus`) does not
 * reliably surface custom status text — Slack substitutes a generic phrase
 * of its own — so real progress is now shown via a message posted once and
 * then rewritten in place (`editMessage`/`chat.update`) as new snapshots
 * arrive. `latest` is the agent's own commit subject line, so it is
 * re-sanitized here (newline-collapsed) even though the runner already
 * bounds it — defense in depth against untrusted content ending up verbatim
 * in a Slack message.
 */
function formatDevelopmentProgressMessage(progress: DevelopmentProgress): string {
  const minutes = Math.floor(progress.elapsedSec / 60);
  let text: string;
  if (progress.phase === "gate") {
    text = `🔍 Gate検証中 ${minutes}分 / commit ${progress.commits}件`;
  } else if (progress.commits > 0) {
    const latest = (progress.latest ?? "").replace(/\s+/g, " ").trim();
    text = latest
      ? `🔨 開発中 ${minutes}分 / commit ${progress.commits}件 — 最新: ${latest}`
      : `🔨 開発中 ${minutes}分 / commit ${progress.commits}件`;
  } else {
    text = `🔨 開発中 ${minutes}分 — Storyを分析しています`;
  }
  return text.length > MAX_PROGRESS_MESSAGE_CHARS ? `${text.slice(0, MAX_PROGRESS_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * Renders the final rewrite of the in-thread progress message once the run
 * completes (success or failure) — the last thing the user sees in place of
 * the "開発中…" text before the result card/message arrives right after.
 */
function formatDevelopmentProgressFinal(elapsedMinutes: number, commitCount?: number): string {
  return typeof commitCount === "number"
    ? `⏱ 実行 ${elapsedMinutes}分 / commit ${commitCount}件`
    : `⏱ 実行 ${elapsedMinutes}分`;
}

/** Slack (and any future connector) reports `message_not_found` in the API
 * error when the tracked progress message was deleted out from under us
 * (e.g. a user cleared the thread). Treated as a one-time repost trigger
 * rather than a hard failure. */
function isMessageNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message_not_found/i.test(message);
}

export class SessionManager {
  private config: JinnConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();
  private criticalDispatches = new Set<string>();
  private developmentRunning = false;
  /** The pending-run record id (see development-pending.ts) for whichever
   * development run this process is currently piping stdout from, if any.
   * Excludes that run from the reconciler sweep so pipe delivery and the
   * spool-based reconciler never race each other. */
  private inFlightDevelopmentRunId: string | null = null;

  constructor(
    config: JinnConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
  }

  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }

  /**
   * Replace the list of connector names that gets injected into engine
   * context (system prompt). Call this after a hot-reload of connectors so
   * sessions started post-reload see the current set, not the boot-time set.
   */
  setConnectorNames(names: string[]): void {
    this.connectorNames = [...names];
  }

  /**
   * Replace the active config object. Call this after ~/.ryoko/config.yaml
   * is reloaded so new sessions see fresh values for engines.default,
   * portal.portalName, engine bin paths, etc. — without it, every session
   * created after a Settings save would silently use boot-time values until
   * the daemon is restarted.
   */
  setConfig(config: JinnConfig): void {
    this.config = config;
  }

  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  getQueue(): SessionQueue {
    return this.queue;
  }

  async route(msg: IncomingMessage, connector: Connector, opts: RouteOptions = {}): Promise<{ sessionId: string } | void> {
    if (await this.handleCommand(msg, connector)) return;

    let session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      session = createSession({
        engine: opts.engine ?? opts.employee?.engine ?? this.config.engines.default,
        source: msg.source,
        sourceRef: msg.sessionKey,
        connector: msg.connector,
        sessionKey: msg.sessionKey,
        replyContext: msg.replyContext,
        messageId: msg.messageId,
        transportMeta: {
          ...(msg.transportMeta ?? {}),
          ...(opts.placement ? { placementId: opts.placement.id } : {}),
        },
        employee: opts.employee?.name ?? undefined,
        model: opts.model ?? opts.employee?.model ?? undefined,
        effortLevel: opts.employee?.effortLevel ?? undefined,
        title: opts.title,
        prompt: msg.text,
        portalName: this.config.portal?.portalName,
      });
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      let mergedMeta = mergeTransportMeta(session.transportMeta, {
        ...(msg.transportMeta ?? {}),
        ...(opts.placement ? { placementId: opts.placement.id } : {}),
      });
      const placementEngine = opts.engine ?? opts.employee?.engine ?? this.config.engines.default;
      const placementModel = opts.model ?? opts.employee?.model ?? null;
      const placementEmployee = opts.employee?.name ?? null;
      const placementEffort = opts.employee?.effortLevel ?? null;
      // A placement message may only resume the prior engine transcript when the
      // session's authority binding is unchanged: same placement, same engine,
      // same employee, and no stale cross-engine metadata. Anything else is a
      // rebind — kill the running engine and clear the transcript so context
      // gained under one authority can never leak into another.
      const priorMeta = (session.transportMeta || {}) as Record<string, unknown>;
      const samePlacementAuthority = Boolean(opts.placement) &&
        priorMeta["placementId"] === opts.placement?.id &&
        session.engine === placementEngine &&
        (session.employee ?? null) === placementEmployee &&
        priorMeta["engineOverride"] === undefined &&
        priorMeta["engineSessions"] === undefined;
      if (opts.placement) {
        if (!samePlacementAuthority) {
          const priorEngine = this.engines.get(session.engine);
          if (priorEngine && isInterruptibleEngine(priorEngine)) {
            priorEngine.kill(session.id, "placement authority rebind");
          }
        }
        mergedMeta = placementTransportMeta(mergedMeta);
      }
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.placement ? {
          engine: placementEngine,
          engineSessionId: samePlacementAuthority ? session.engineSessionId : null,
          employee: placementEmployee,
          model: placementModel,
          effortLevel: placementEffort,
        } : opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);
    const sessionId = session.id;

    const criticalConfig = opts.criticalRouting;
    const criticalDecision = criticalConfig?.enabled
      ? classifyCriticalTask(msg.text)
      : { critical: false as const };
    if (criticalDecision.critical) {
      const reviewerEmployee = criticalConfig?.reviewerEmployee?.trim() || "critical-reviewer";
      const dispatchKey = `${session.id}:${msg.messageId || msg.sessionKey}`;
      const routeMeta = (session.transportMeta && typeof session.transportMeta === "object")
        ? (session.transportMeta as Record<string, unknown>).criticalRouting as Record<string, unknown> | undefined
        : undefined;
      if (this.criticalDispatches.has(dispatchKey) || (msg.messageId && routeMeta?.messageId === msg.messageId)) {
        logger.info(`Skipping duplicate critical route for parent ${session.id}, message ${msg.messageId}`);
        return { sessionId };
      }
      this.criticalDispatches.add(dispatchKey);

      insertMessage(session.id, "user", msg.text);
      const dispatchingMeta = {
        ...((session.transportMeta || {}) as Record<string, unknown>),
        criticalRouting: {
          messageId: msg.messageId ?? null,
          reviewerEmployee,
          reason: criticalDecision.reason,
          status: "dispatching",
        },
      };
      updateSession(session.id, {
        status: "running",
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: dispatchingMeta as Session["transportMeta"],
        lastActivity: new Date().toISOString(),
      });

      try {
        const response = await fetch(
          `http://127.0.0.1:${this.config.gateway.port}/api/sessions/${session.id}/children`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(session.id),
            },
            body: JSON.stringify({
              employee: reviewerEmployee,
              prompt: buildCriticalReviewPrompt(msg.text),
              attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
            }),
          },
        );
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          throw new Error(`child session API returned ${response.status}${detail ? `: ${detail}` : ""}`);
        }
        const child = await response.json() as {
          id?: string;
          model?: string | null;
          effortLevel?: string | null;
        };
        if (!child.id) throw new Error("child session API did not return an id");

        const routeLabel = [child.model, child.effortLevel].filter(Boolean).join("/");
        const acknowledgement = `重要タスクとして ${reviewerEmployee}${routeLabel ? `（${routeLabel}）` : ""}へレビューを委譲しました。完了後、このスレッドに統合結果を返します。`;
        insertMessage(session.id, "assistant", acknowledgement);
        updateSession(session.id, {
          status: "idle",
          transportMeta: {
            ...dispatchingMeta,
            criticalRouting: {
              messageId: msg.messageId ?? null,
              reviewerEmployee,
              reason: criticalDecision.reason,
              status: "delegated",
              childSessionId: child.id,
            },
          } as Session["transportMeta"],
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        await connector.replyMessage(target, acknowledgement);
        logger.info(
          `Deterministic critical route: parent ${session.id} -> child ${child.id} (${reviewerEmployee}, reason: ${criticalDecision.reason})`,
        );
        return { sessionId };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failure = `重要レビューの委譲に失敗したため処理を停止しました。運用担当者が確認します。`;
        insertMessage(session.id, "assistant", failure);
        updateSession(session.id, {
          status: "error",
          lastActivity: new Date().toISOString(),
          lastError: errMsg,
        });
        logger.error(`Critical route failed for parent ${session.id}: ${errMsg}`);
        await connector.replyMessage(target, failure).catch(() => {});
        return { sessionId };
      } finally {
        this.criticalDispatches.delete(dispatchKey);
      }
    }

    if (session.status === "waiting") {
      const expectedResetAt = getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      await connector.replyMessage(
        target,
        `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. I queued this message and will respond automatically.`,
      ).catch(() => {});
    }

    if (session.status === "running" && this.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    // Queue cancellation is generational (see SessionQueue.clearQueue): this new
    // inbound message enqueues at the current generation and runs even if the session
    // was previously /stop- or watchdog-reset, so no explicit un-cancel is needed here.
    await this.queue.enqueue(msg.sessionKey, () =>
      this.runSession(session!, msg, attachmentPaths, connector, target, opts.employee, opts.placement),
    );

    return { sessionId };
  }

  /**
   * Build the audience/routing context used to sanitize engine output before it
   * is posted. `addressed` is true for any non-cron (human-originated) session:
   * "read-the-air" silence is handled upstream in triage, so a session that ran
   * at all owes a response. `channelExternal` defaults to true for non-DM when
   * the connector doesn't report it (safe — strips operator notes from any
   * public channel). See reply-disposition.ts / the 2026-06-18 design doc.
   */
  private buildDeliveryContext(
    session: Session,
    msg: IncomingMessage,
    capabilities: { reactions: boolean },
  ): DeliveryContext {
    const meta = (msg.transportMeta ?? {}) as Record<string, unknown>;
    const isDM = meta.channelType === "im";
    const channelExternal = isDM
      ? false
      : meta.channelExternal === undefined
        ? true
        : meta.channelExternal === true;
    return {
      addressed: session.source !== "cron",
      channelExternal,
      isDM,
      canReact: capabilities.reactions,
    };
  }

  /**
   * Handle a hook that arrived with no turn in flight (see
   * HookRegistry.setOrphanHandler). A Stop orphan carries the final message of
   * autonomous post-turn work — a background sub-agent or task that finished
   * AFTER the turn settled (or after a turn timeout/StopFailure). Without this,
   * that output was buffered 30s and dropped: the work completed but the reply
   * never reached the user. Deliver it to the session's conversation and notify
   * the parent session, mirroring the tail of runSession's delivery path.
   * Fire-and-forget; must never throw (hook endpoint calls into this).
   */
  async handleOrphanHook(sessionId: string, hook: { hook_event_name: string; last_assistant_message?: unknown; error?: unknown }): Promise<void> {
    try {
      if (this.config.sessions?.backgroundDelivery === false) return;
      const session = getSession(sessionId);
      if (!session) return;

      if (hook.hook_event_name === "StopFailure") {
        // Background continuation failed — record it for operators, but don't
        // post to the channel (nothing was promised; avoid error spam during
        // upstream incidents).
        const err = typeof hook.error === "string" ? hook.error : "unknown";
        logger.warn(`Orphan StopFailure for session ${sessionId}: ${err}`);
        updateSession(sessionId, { lastActivity: new Date().toISOString(), lastError: `Background turn failed: ${err}` });
        return;
      }
      if (hook.hook_event_name !== "Stop") return;

      const text = typeof hook.last_assistant_message === "string" ? hook.last_assistant_message.trim() : "";
      if (!text) return;

      // A turn may have started between the orphan arriving and this handler
      // running — its resolver owns delivery now; don't double-post.
      const engine = this.engines.get(session.engine) as (Engine & { isTurnRunning?: (id: string) => boolean }) | undefined;
      if (engine?.isTurnRunning?.(session.id)) return;

      // Dedupe: identical to the message we already delivered → nothing new.
      const history = getMessages(session.id);
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      if (lastAssistant?.content === text) return;

      insertMessage(session.id, "assistant", text);
      const updated = updateSession(session.id, {
        lastActivity: new Date().toISOString(),
        ...(session.status !== "running" ? { status: "idle" as const, lastError: null } : {}),
      }) ?? session;

      logger.info(`Delivering background completion for session ${sessionId} (${text.length} chars)`);

      const connector = session.connector ? this.connectorProvider().get(session.connector) : undefined;
      if (connector && session.replyContext) {
        const target = connector.reconstructTarget(session.replyContext);
        const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
        const isDM = meta.channelType === "im";
        const ctx: DeliveryContext = {
          // Unsolicited follow-up: never force a SAFE_ACK, just sanitize.
          addressed: false,
          channelExternal: isDM ? false : meta.channelExternal === undefined ? true : meta.channelExternal === true,
          isDM,
          canReact: connector.getCapabilities().reactions,
        };
        const { publicAction } = normalizeDelivery(text, ctx);
        await deliverPublic(connector, target, publicAction).catch((err) => {
          logger.warn(`Background completion delivery failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      // Child (sub-)session: this late completion IS the "完了通知" the parent
      // was waiting for.
      notifyParentSession(updated, { result: text });
    } catch (err) {
      logger.warn(`handleOrphanHook failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSession(
    session: Session,
    msg: IncomingMessage,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
    placement?: PlacementProfile,
  ): Promise<void> {
    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.replyMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }
    if (session.engine !== "claude" && /^\/goal(?:\s|$)/i.test(msg.text.trim())) {
      await connector.replyMessage(
        target,
        `/goal is only supported by the Claude engine. Current engine: ${session.engine}. Switch this session to Claude to use goal-mode execution.`,
      );
      return;
    }

    insertMessage(session.id, "user", msg.text);

    const capabilities = connector.getCapabilities();
    const decorateMessages = session.source !== "cron";

    if (decorateMessages && capabilities.reactions) {
      await connector.addReaction(target, "eyes").catch(() => {});
    }

    // Set native typing indicator (Slack assistant.threads.setStatus)
    const threadTs = target.thread || target.messageTs;
    if (decorateMessages && connector.setTypingStatus) {
      await connector.setTypingStatus(target.channel, threadTs, "入力中...").catch(() => {});
    }

    updateSession(session.id, {
      status: "running",
      replyContext: msg.replyContext,
      messageId: msg.messageId ?? null,
      transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
      lastActivity: new Date().toISOString(),
    });

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;

    let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
    try {
      const { scanOrg } = await import("../gateway/org.js");
      const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
      hierarchy = resolveOrgHierarchy(scanOrg());
    } catch { /* fallback to filesystem scan in context builder */ }

    try {
      const meta = msg.transportMeta ?? {};
      const systemPrompt = buildContext({
        source: session.source,
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        employee,
        placement,
        connectors: this.connectorNames,
        config: this.config,
        sessionId: session.id,
        channelName: (meta.channelName as string) || undefined,
        speakerName: (meta.speakerName as string) || undefined,
        speakerRealName: (meta.speakerRealName as string) || undefined,
        speakerDisplayName: (meta.speakerDisplayName as string) || undefined,
        speakerHandle: (meta.speakerHandle as string) || undefined,
        speakerSlackId: (meta.speakerSlackId as string) || undefined,
        speakerIsBot: (meta.speakerIsBot as boolean | null) ?? undefined,
        speakerTz: (meta.speakerTz as string) || undefined,
        hierarchy,
      });

      const engineConfig = session.engine === "codex"
        ? this.config.engines.codex
        : session.engine === "gemini"
          ? this.config.engines.gemini ?? this.config.engines.claude
          : this.config.engines.claude;
      if (session.engine === "claude") {
        const mcpConfig = resolveMcpServers(this.config.mcp, employee, {
          sessionId: session.id,
          connector: connector.name,
          channel: target.channel,
          thread: target.thread || target.messageTs,
          placementId: placement?.id,
          configRevision: placementConfigRevision(this.config.placements),
          allowedGatewayTools: placement ? (placement.capabilities?.gatewayTools ?? []) : undefined,
          allowedDeliveryTargets: placement ? placementDeliveryTargets(placement) : undefined,
        }, placement ? placementMcpServerNames(placement, this.config.mcp) : undefined);
        // A Placement must always receive an explicit config, including an
        // empty one, so --strict-mcp-config can exclude user/global MCPs.
        if (placement || Object.keys(mcpConfig.mcpServers).length > 0) {
          mcpConfigPath = writeMcpConfigFile(mcpConfig, session.id);
        }
      }

      // Placement browser access is supplied by its allowlisted MCP server.
      // Claude's separate Chrome integration is outside that allowlist.
      const effortLevel = resolveEffort(
        engineConfig,
        session,
        employee,
        effortLevelsForModel(this.config, session.engine, session.model ?? engineConfig.model),
      );

      // If we previously switched to GPT while Claude was rate-limited, inject a sync transcript
      // so Claude can resume with full context when it comes back online.
      const syncSinceIso = (session.transportMeta as any)?.claudeSyncSince;
      let promptToRun = msg.text;
      const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
      const syncRequested = session.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
      if (syncRequested) {
        const sinceMessages = getMessages(session.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        promptToRun =
          `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      }

      // Per-message speaker attribution for group conversations. The system
      // prompt names the speaker only at engine-spawn time — in a multi-user
      // thread (or a warm-PTY follow-up from a DIFFERENT person) the model has
      // no per-turn signal of who is talking and defaults to the conversation's
      // habitual addressee, which is how non-operators got addressed as the
      // operator. Skipped for DMs (1:1 is unambiguous), cron (no speaker), and
      // slash-command prompts (a prefix would break native-command detection).
      {
        const speakerMeta = (msg.transportMeta ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
        const prefixName = str(speakerMeta.speakerName);
        if (
          decorateMessages &&
          prefixName &&
          speakerMeta.channelType !== "im" &&
          !promptToRun.trimStart().startsWith("/")
        ) {
          const isOp = isOperatorSpeaker(
            [prefixName, str(speakerMeta.speakerRealName), str(speakerMeta.speakerDisplayName), str(speakerMeta.speakerHandle)],
            this.config.portal?.operatorName,
            this.config.portal?.operatorAliases,
          );
          const safeName = prefixName.replace(/[\[\]\r\n]/g, "").slice(0, 60);
          const operator = this.config.portal?.operatorName?.trim();
          const tag = operator
            ? isOp
              ? " (the operator)"
              : ` — NOT the operator; do not address this person as "${operator}"`
            : "";
          promptToRun = `[Speaker: ${safeName}${tag}]\n${promptToRun}`;
        }
      }

      // Budget enforcement — check BEFORE engine.run()
      if (session.employee) {
        const budgetConfig = (this.config as any).budgets?.employees as Record<string, number> | undefined;
        if (budgetConfig && session.employee in budgetConfig) {
          const budgetStatus = checkBudget(session.employee, budgetConfig);
          if (budgetStatus === 'paused') {
            logger.warn(`Session ${session.id} blocked: employee "${session.employee}" has exceeded their budget`);
            const pausedMsg = `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
            updateSession(session.id, {
              status: 'error',
              lastActivity: new Date().toISOString(),
              lastError: pausedMsg,
            });
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, '').catch(() => {});
            }
            await connector.replyMessage(target, `⛔ ${pausedMsg}`).catch(() => {});
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, 'eyes').catch(() => {});
            }
            return;
          }
        }
      }

      // Placement budget warning — 80% notifies once per month; the hard stop
      // at 100% happens fail-closed in resolveRouteOptions before routing.
      if (placement?.monthlyBudgetUsd !== undefined) {
        const placementBudget = getPlacementBudgetStatus(placement.id, placement.monthlyBudgetUsd);
        if (
          placementBudget.status === 'warning' &&
          shouldNotifyPlacementBudgetWarning(placement.id, placementBudget.spend, placementBudget.limit)
        ) {
          await connector.replyMessage(
            target,
            `⚠️ Placement "${placement.id}" has used ${placementBudget.percent}% of its monthly budget ($${placementBudget.spend.toFixed(2)} / $${placementBudget.limit}). It will be blocked at 100%.`,
          ).catch(() => {});
        }
      }

      // Heuristic preflight warning: Claude usage limits don't expose a precise "remaining" budget.
      // If we've hit the limit recently and this looks like a heavy turn, warn before we spend time.
      if (decorateMessages && session.engine === "claude" && isLikelyNearClaudeUsageLimit()) {
        const modelName = (session.model ?? engineConfig.model ?? "").toLowerCase();
        const heavyEffort = ["high", "xhigh", "max"].includes((effortLevel || "").toLowerCase());
        const heavyModel = modelName.includes("opus");
        const looksBig = attachments.length > 0 || msg.text.length > 6000;
        if ((heavyEffort || heavyModel) && looksBig) {
          const expectedResetAt = getClaudeExpectedResetAt();
          const resumeText = expectedResetAt
            ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;
          await connector.replyMessage(
            target,
            `⚠️ Heads up: Claude usage limits were hit recently, and this looks like a bigger task. If you're near the limit, it may pause${resumeText ? ` until ~${resumeText}` : ""}.`,
          ).catch(() => {});
        }
      }

      let result = await runPlacementBoundEngine(engine, placement, {
        prompt: promptToRun,
        resumeSessionId: session.engineSessionId ?? undefined,
        systemPrompt,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: session.model ?? engineConfig.model,
        effortLevel,
        cliFlags: employee?.cliFlags,
        sshHost: employee?.sshHost,
        remoteCwd: employee?.remoteCwd,
        mcpConfigPath,
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: session.id,
        keepWarmPty: false,
      }, this.config.placements, this.config.mcp);

      let wasInterrupted = result.error?.startsWith("Interrupted");

      // Poisoned transcript: the persisted engine history is corrupted (e.g.
      // collapsed extended-thinking blocks) so every --resume of this engine
      // session replays it and fails with the same 400. Clear the engine session
      // id so the NEXT message starts on a clean session, but deliberately do NOT
      // auto-replay the current prompt: the failed run may already have executed
      // tools with side effects, and a fresh rerun would duplicate them (a
      // resumed `claude -p` reports cumulative cost/turns, so "no work was done"
      // cannot be reliably detected here). Ask the user to resend instead.
      const isPoisoned = !wasInterrupted && isPoisonedTranscriptError(result);
      if (isPoisoned) {
        logger.warn(`Poisoned transcript for ${session.id} — clearing engine session id; not auto-retrying to avoid duplicate side effects`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, { engineSessionId: null, transportMeta: meta as any });
        session = { ...session, engineSessionId: null, transportMeta: meta as any };
        // Blank the returned sessionId so the post-run persistence below does not
        // re-attach the poisoned engine session id, drop any partial result text
        // and intermediate turns (otherwise the reply path would surface those
        // stale fragments instead of the reset notice), and replace the raw 400
        // with an actionable message for the user.
        result = {
          ...result,
          sessionId: "",
          result: "",
          turns: [],
          error:
            "⚠️ 直前の会話履歴が壊れていたため（thinking ブロックの破損）、このセッションをリセットしました。お手数ですが同じ内容をもう一度送ってください。次回からは正常に応答できます。",
        };
      }

      // Dead session detection: if the engine session ID is stale (expired/invalid),
      // clear cached engine sessions from transportMeta so the next attempt starts fresh.
      // Also sets a flag so we skip the rate-limit retry loop below (a dead session
      // error can contain text like "429" that would otherwise match RATE_LIMIT_ERROR_RE).
      // (Poisoned transcripts are handled above and excluded here — unlike a stale
      // resume id, they must not trigger an automatic prompt replay.)
      let isDead = !wasInterrupted && !isPoisoned && isDeadSessionError(result);
      if (isDead) {
        logger.warn(`Dead session detected for ${session.id} — clearing stale engine IDs`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, {
          engineSessionId: null,
          transportMeta: meta as any,
        });
        // Update local reference so subsequent code doesn't re-read stale IDs
        session = { ...session, engineSessionId: null, transportMeta: meta as any };

        // Auto-retry once with a fresh engine session. Without this, a user
        // message that happens to land on a stale resume ID is silently lost
        // (the raw engine error propagates back instead of a real answer).
        logger.info(`Retrying session ${session.id} with fresh engine session after dead-session`);
        result = await runPlacementBoundEngine(engine, placement, {
          prompt: promptToRun,
          resumeSessionId: undefined,
          systemPrompt,
          cwd: JINN_HOME,
          bin: engineConfig.bin,
          model: session.model ?? engineConfig.model,
          effortLevel,
          cliFlags: employee?.cliFlags,
          sshHost: employee?.sshHost,
          remoteCwd: employee?.remoteCwd,
          mcpConfigPath,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionId: session.id,
          keepWarmPty: false,
        }, this.config.placements, this.config.mcp);

        // Re-evaluate the flags against the retry result. If the retry also
        // comes back dead, something deeper is wrong — log and fall through to
        // normal error handling (which will post the error to the user).
        wasInterrupted = result.error?.startsWith("Interrupted");
        isDead = !wasInterrupted && isDeadSessionError(result);
        if (isDead) {
          logger.error(`Retry with fresh session for ${session.id} also reported dead-session; giving up`);
        }
      }

      // Transient Anthropic server error (5xx/529): the CLI already retried
      // in-process for minutes and gave up. The engine session's history is
      // intact, so wait out the incident with backoff and re-drive the SAME
      // session with a continuation prompt instead of surfacing a hard error.
      // Runs BEFORE rate-limit detection so a retry that ends rate-limited
      // still flows into the normal wait/fallback machinery below.
      if (!wasInterrupted && !isDead && !isPoisoned && isTransientServerError(result)) {
        const delays = this.config.sessions?.transientRetryDelaysMs ?? [30_000, 120_000, 300_000];
        if (delays.length > 0) {
          await connector.replyMessage(
            target,
            "⚠️ Anthropic API is temporarily unavailable (server error). I'll retry automatically — no action needed.",
          ).catch(() => {});
        }
        for (const [i, delayMs] of delays.entries()) {
          logger.warn(
            `Session ${session.id} hit a transient server error — retry ${i + 1}/${delays.length} in ${Math.round(delayMs / 1000)}s`,
          );
          // Chunked wait with a heartbeat: the status reconciler treats a
          // "running" session with a stale lastActivity and no live engine turn
          // as stuck — which is exactly what this backoff window looks like.
          // Refreshing lastActivity every 20s keeps it out of the sweep.
          for (let waited = 0; waited < delayMs; waited += 20_000) {
            updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
            await new Promise((r) => setTimeout(r, Math.min(20_000, delayMs - waited)));
          }
          const resumeId = result.sessionId?.trim() || session.engineSessionId || undefined;
          result = await runPlacementBoundEngine(engine, placement, {
            prompt:
              "The previous response was interrupted by a temporary Anthropic API server error. " +
              "The conversation history up to that point is intact. Continue and complete the original request now. " +
              "If the work was already finished, reply with the final result.",
            resumeSessionId: resumeId,
            systemPrompt,
            cwd: JINN_HOME,
            bin: engineConfig.bin,
            model: session.model ?? engineConfig.model,
            effortLevel,
            cliFlags: employee?.cliFlags,
            sshHost: employee?.sshHost,
            remoteCwd: employee?.remoteCwd,
            mcpConfigPath,
            sessionId: session.id,
            keepWarmPty: false,
          }, this.config.placements, this.config.mcp);
          wasInterrupted = result.error?.startsWith("Interrupted");
          if (wasInterrupted || !isTransientServerError(result)) break;
        }
        if (!wasInterrupted && isTransientServerError(result)) {
          logger.error(`Session ${session.id} still failing with server errors after ${delays.length} retries — giving up`);
        }
      }

      // Detect rate limit / usage limit errors and auto-retry.
      // Skip entirely for dead/poisoned sessions — they are not rate limits.
      const rateLimit = (!wasInterrupted && !isDead && !isPoisoned) ? detectRateLimit(result) : { limited: false as const };
      if (rateLimit.limited) {
        recordClaudeRateLimit(rateLimit.resetsAt);

        const strategy = this.config.sessions?.rateLimitStrategy ?? "fallback";

        // Optional fallback: switch to GPT (Codex) while Claude resets
        if (session.engine === "claude" && strategy === "fallback") {
          const fallbackName = this.config.sessions?.fallbackEngine ?? "codex";
          const fallbackEngine = this.engines.get(fallbackName);
          if (fallbackEngine && supportsPlacementEngine(fallbackEngine, placement)) {
            const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
            const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
            const syncSince = new Date().toISOString();
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} switching to GPT.`,
            );

            await connector.replyMessage(
              target,
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`,
            ).catch(() => {});

            const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
            const engineSessionsRaw = nextMeta.engineSessions;
            const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
              ? { ...(engineSessionsRaw as Record<string, unknown>) }
              : {};
            if (session.engineSessionId) {
              engineSessions.claude = session.engineSessionId;
            }
            nextMeta.engineSessions = engineSessions;
            nextMeta.engineOverride = { originalEngine: "claude", originalEngineSessionId: session.engineSessionId, until: until.toISOString(), syncSince };

            updateSession(session.id, {
              engine: fallbackName,
              // Keep Claude engine_session_id intact for later restore; Codex will return its own thread id.
              transportMeta: nextMeta as any,
              status: "running",
              lastActivity: new Date().toISOString(),
              lastError: resumeAt
                ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
                : "Claude usage limit — using GPT temporarily",
            });

            const fallbackConfig = this.config.engines.codex;
            const fallbackEffort = resolveEffort(
              fallbackConfig,
              session,
              employee,
              effortLevelsForModel(this.config, "codex", session.model ?? fallbackConfig.model),
            );
            const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
            const history = getMessages(session.id)
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
            const historyText = history.slice(-12).join("\n\n");
            const fallbackPrompt = codexResume
              ? msg.text
              : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;
            const fallbackResult = await runPlacementBoundEngine(fallbackEngine, placement, {
              prompt: fallbackPrompt,
              resumeSessionId: codexResume,
              systemPrompt,
              cwd: JINN_HOME,
              bin: fallbackConfig.bin,
              model: session.model ?? fallbackConfig.model,
              effortLevel: fallbackEffort,
              cliFlags: employee?.cliFlags,
              sshHost: employee?.sshHost,
              remoteCwd: employee?.remoteCwd,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
              keepWarmPty: false,
            }, this.config.placements, this.config.mcp);

            const fallbackText = fallbackResult.result?.trim()
              ? fallbackResult.result
              : fallbackResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", fallbackText);
            if (fallbackResult.cost || fallbackResult.numTurns) {
              accumulateSessionCost(session.id, fallbackResult.cost ?? 0, fallbackResult.numTurns ?? 1);
            }

            // Persist Codex thread id so future fallbacks can resume it
            const nextEngineSessions = { ...engineSessions };
            if (fallbackResult.sessionId) {
              nextEngineSessions.codex = fallbackResult.sessionId;
            }
            const metaAfter = { ...(getSessionBySessionKey(msg.sessionKey)?.transportMeta || nextMeta) } as Record<string, unknown>;
            metaAfter.engineSessions = nextEngineSessions;
            updateSession(session.id, { transportMeta: metaAfter as any });

            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            // Clear "eyes" before delivery so a react-only ":eyes:" reply survives.
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
            }
            {
              const { publicAction } = normalizeDelivery(fallbackText, this.buildDeliveryContext(session, msg, capabilities));
              await deliverPublic(connector, target, publicAction).catch(() => {});
            }

            const updated = updateSession(session.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
              lastActivity: new Date().toISOString(),
              lastError: fallbackResult.error ?? null,
              ...(typeof fallbackResult.contextTokens === "number" ? { lastContextTokens: fallbackResult.contextTokens } : {}),
            });
            if (updated) {
              notifyParentSession(updated, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            return;
          }
        }

        const waitEmoji = "hourglass_flowing_sand";

        const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
        const deadlineMs = computeRateLimitDeadlineMs(
          rateLimit.resetsAt,
          rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
        );

        const resumeText = resumeAt
          ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;

        logger.info(
          `Session ${session.id} hit Claude usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
        );

        // Send hardcoded Discord notification — does not depend on LLM
        notifyDiscordChannel(
          `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
        );

        // Clear "thinking" UI and show waiting state
        if (decorateMessages && connector.setTypingStatus) {
          await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
        }
        if (decorateMessages && capabilities.reactions) {
          await connector.removeReaction(target, "eyes").catch(() => {});
          await connector.addReaction(target, waitEmoji).catch(() => {});
        }

        const waitingSession = updateSession(session.id, {
          ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: resumeAt
            ? `Claude usage limit — resumes ${resumeAt.toISOString()}`
            : "Claude usage limit — waiting for reset",
        }) ?? session;

        notifyRateLimited(
          waitingSession,
          resumeAt
            ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : undefined,
        );

        await connector.replyMessage(
          target,
          `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`,
        ).catch(() => {});

        // Keep lastActivity fresh while waiting (UI / status endpoints)
        const heartbeat = setInterval(() => {
          updateSession(session.id, { status: "waiting", lastActivity: new Date().toISOString() });
        }, 60_000);

        try {
          let attempt = 0;
          let nextDelayMs = delayMs;

          while (Date.now() < deadlineMs) {
            await new Promise(r => setTimeout(r, nextDelayMs));
            attempt++;

            // Check if session was stopped while waiting
            const currentSession = getSessionBySessionKey(msg.sessionKey);
            if (!currentSession || currentSession.status === "error") {
              logger.info(`Session ${session.id} stopped while waiting for usage reset`);
              return;
            }

            // Show active processing again
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "入力中...").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, waitEmoji).catch(() => {});
              await connector.addReaction(target, "eyes").catch(() => {});
            }

            logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);
            const retryResult = await runPlacementBoundEngine(engine, placement, {
              prompt: msg.text,
              resumeSessionId: currentSession.engineSessionId ?? undefined,
              systemPrompt,
              cwd: JINN_HOME,
              bin: engineConfig.bin,
              model: currentSession.model ?? engineConfig.model,
              effortLevel,
              cliFlags: employee?.cliFlags,
              sshHost: employee?.sshHost,
              remoteCwd: employee?.remoteCwd,
              mcpConfigPath,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
              keepWarmPty: false,
            }, this.config.placements, this.config.mcp);

            const retryInterrupted = retryResult.error?.startsWith("Interrupted");
            const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };
            if (retryRateLimit.limited) {
              recordClaudeRateLimit(retryRateLimit.resetsAt);
              logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

              const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
              nextDelayMs = next.delayMs;

              // Return to waiting UI state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }

              updateSession(session.id, {
                ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
                status: "waiting",
                lastActivity: new Date().toISOString(),
                lastError: next.resumeAt
                  ? `Claude usage limit — resumes ${next.resumeAt.toISOString()}`
                  : "Claude usage limit — waiting for reset",
              });

              continue;
            }

            // Success or different error — handle normally
            const retryText = retryResult.result?.trim()
              ? retryResult.result
              : retryResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", retryText);
            if (retryResult.cost || retryResult.numTurns) {
              accumulateSessionCost(session.id, retryResult.cost ?? 0, retryResult.numTurns ?? 1);
            }

            // Clear typing indicator & reactions
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
              await connector.removeReaction(target, waitEmoji).catch(() => {});
            }

            {
              const { publicAction } = normalizeDelivery(retryText, this.buildDeliveryContext(session, msg, capabilities));
              await deliverPublic(connector, target, publicAction).catch(() => {});
            }
            const retryUpdated = updateSession(session.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: retryResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: msg.transportMeta ?? null,
              lastActivity: new Date().toISOString(),
              lastError: retryResult.error ?? null,
              ...(typeof retryResult.contextTokens === "number" ? { lastContextTokens: retryResult.contextTokens } : {}),
            });
            if (retryUpdated) {
              notifyRateLimitResumed(retryUpdated);
              notifyDiscordChannel(
                `✅ Claude usage limit cleared. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} resumed.`,
              );
              notifyParentSession(retryUpdated, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            logger.info(`Session ${session.id} resumed after usage reset`);
            return;
          }

          // Exhausted waiting window
          notifyDiscordChannel(
            `❌ Claude usage limit did not clear in time. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} has been stopped.`,
          );
          await connector.replyMessage(target, "Usage limit didn't reset in time. Please try again later.").catch(() => {});
          updateSession(session.id, {
            status: "error",
            lastActivity: new Date().toISOString(),
            lastError: "Claude usage limit did not clear in time",
          });

          // Clear reactions on failure
          if (decorateMessages && capabilities.reactions) {
            await connector.removeReaction(target, "eyes").catch(() => {});
            await connector.removeReaction(target, waitEmoji).catch(() => {});
          }
          return;
        } finally {
          clearInterval(heartbeat);
        }
      }

      const responseText = result.result?.trim()
        ? result.result
        : result.error || "(No response from engine)";

      insertMessage(session.id, "assistant", responseText);
      if (result.cost || result.numTurns) {
        accumulateSessionCost(session.id, result.cost ?? 0, result.numTurns ?? 1);
      }
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }
      // Clear the processing "eyes" BEFORE delivering, so a react-only reply of
      // ":eyes:" isn't removed by this cleanup right after it's added.
      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
      }
      if (!wasInterrupted) {
        // Sanitize engine output before posting: strip operator-facing notes
        // (reply-disposition trailer) so they never reach an external channel,
        // and enforce "addressed ⇒ never silent". See the 2026-06-18 design doc.
        const deliveryCtx = this.buildDeliveryContext(session, msg, capabilities);
        // Multi-turn sessions (driven by /goal) carry every intermediate turn in
        // `result.turns`. Batch-normalize so internal notes are stripped per turn
        // without ack multiplication; a single ack is added only if no turn was
        // public. The last entry equals `result.result`.
        const turns = result.turns ?? [];
        if (turns.length > 1) {
          const { actions } = normalizeTurns(turns, deliveryCtx);
          for (const action of actions) {
            await deliverPublic(connector, target, action);
          }
        } else {
          const { publicAction } = normalizeDelivery(responseText, deliveryCtx);
          await deliverPublic(connector, target, publicAction);
        }
      }
      const updatedSession = updateSession(session.id, {
        ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
        status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: (() => {
          const merged = mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta) as Record<string, unknown>;
          if (syncRequested && !rateLimit.limited && !wasInterrupted) {
            delete merged["claudeSyncSince"];
          }
          return merged as any;
        })(),
        lastActivity: new Date().toISOString(),
        lastError: wasInterrupted ? null : (result.error ?? null),
        ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      });
      if (updatedSession) {
        notifyParentSession(updatedSession, { result: result.result, error: wasInterrupted ? null : (result.error ?? null), cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
      }

      logger.info(
        `Session ${session.id} completed in ${result.durationMs ?? 0}ms` +
        (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
      }

      // Clear typing indicator on error
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }

      await connector.replyMessage(target, `Error: ${errMsg}`).catch(() => {});

      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
        await connector.removeReaction(target, "hourglass_flowing_sand").catch(() => {});
      }
    } finally {
      // Clean up temp attachment files downloaded from Slack
      for (const filePath of attachments) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Ignore cleanup errors — best effort
        }
      }

      if (mcpConfigPath) cleanupMcpConfigFile(session.id);
    }
  }

  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    if (text === "/new" || text.startsWith("/new ")) {
      this.resetSession(msg.sessionKey);
      await connector.replyMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${msg.sessionKey}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      const queueDepth = this.queue.getPendingCount(session.sessionKey);
      const transportState = this.queue.getTransportState(session.sessionKey, session.status);
      const info = [
        `Session: ${session.id}`,
        `Engine: ${session.engine}`,
        `Connector: ${session.connector || session.source}`,
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "gemini"]?.model || "default"}`,
        `State: ${transportState}`,
        `Queue depth: ${queueDepth}`,
        `Created: ${session.createdAt}`,
        `Last activity: ${session.lastActivity}`,
        session.lastError ? `Last error: ${session.lastError}` : null,
      ].filter(Boolean).join("\n");

      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/model")) {
      const nextModel = text.slice("/model".length).trim();
      if (!nextModel) {
        await connector.replyMessage(target, "Usage: /model <model-name>");
        return true;
      }

      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      updateSession(session.id, {
        model: nextModel,
        lastActivity: new Date().toISOString(),
      });
      await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor ")) {
      const connectors = Array.from(this.connectorProvider().values());
      const connectorLines = connectors.length > 0
        ? connectors.map((candidate) => {
            const health = candidate.getHealth();
            return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
          })
        : ["- none"];
      const info = [
        `Default engine: ${this.config.engines.default}`,
        `Claude: ${this.config.engines.claude.model}`,
        `Codex: ${this.config.engines.codex.model}`,
        ...(this.config.engines.gemini ? [`Gemini: ${this.config.engines.gemini.model}`] : []),
        "Connectors:",
        ...connectorLines,
      ].join("\n");
      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/cron")) {
      return this.handleCronCommand(text, connector, target);
    }

    if (text === "/develop" || text.startsWith("/develop ")) {
      if (connector.name !== "slack") return false;
      const request = text.slice("/develop".length).trim();
      const config = this.config.developmentRunner;
      if (!config?.enabled) {
        await connector.replyMessage(target, "Development runner is disabled.");
        return true;
      }
      if (!config.allowedSlackChannels?.includes(msg.channel)) {
        await connector.replyMessage(target, "Development tasks are not enabled in this channel.");
        return true;
      }
      if (!request) {
        await connector.replyMessage(target, "Usage: /vibepro <request>");
        return true;
      }
      if (this.developmentRunning) {
        await connector.replyMessage(target, "A development task is already running. Try again after it completes.");
        return true;
      }

      // Slash-command input is never posted to the channel by Slack itself,
      // so the acceptance message must quote the request or the thread has no
      // record of what was asked.
      const quotedRequest = request
        .slice(0, 1000)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      const requester = msg.userId ? `（依頼者: <@${msg.userId}>）` : "";
      const acceptanceTs = await connector.replyMessage(
        target,
        [`📥 開発依頼を受け付けました${requester}`, quotedRequest].join("\n"),
      );
      // Slack slash commands carry no message ts of their own (there is no
      // visible root message to thread under), so the acceptance reply's own
      // ts becomes the thread anchor for every subsequent post in this flow —
      // matching the same-thread experience mention conversations already get.
      const devTarget: Target = target.thread ? target : { ...target, thread: acceptanceTs || target.thread };
      this.runDevelopmentFlow(config, request, connector, devTarget);
      return true;
    }

    return false;
  }

  /**
   * Runs one development-runner invocation (new Story or resume) and
   * delivers the result to Slack. Shared by the native `/vibepro` command
   * and `resumeDevelopmentDecision` (the Human-in-the-Loop answer submit
   * path) so both go through the same single-flight lock and result
   * formatting/posting logic.
   */
  private runDevelopmentFlow(
    config: NonNullable<JinnConfig["developmentRunner"]>,
    request: string | { storyId: string; answers: DevelopmentAnswer[] } | DevelopmentContinueGatesRequest,
    connector: Connector,
    target: Target,
  ): void {
    this.developmentRunning = true;
    // The animated "typing" indicator itself is still useful (it's the only
    // signal Slack shows immediately, before the first progress snapshot
    // arrives), but varying its text no longer serves a purpose — Slack
    // overrides custom status text with a generic phrase of its own — so
    // this is now a single fixed set at the start and a clear at the end,
    // not a per-progress-tick call.
    if (connector.setTypingStatus && target.thread) {
      connector.setTypingStatus(target.channel, target.thread, "開発中…").catch(() => {});
    }

    // Record this run durably BEFORE spawning the runner: if the gateway
    // process dies mid-run (its own cgroup killed, etc.), the reconciler
    // needs this record to know a run was in flight and where to deliver
    // the result once the isolated runner's result spool shows up.
    //
    // `connectorName` (== connector.name) is NOT enough on its own to route
    // the eventual delivery back to this exact connector: every SlackConnector
    // instance reports `name: "slack"` regardless of which Slack workspace
    // it's bound to, so two connected workspaces are indistinguishable by
    // name alone. `connectorInstanceId` carries the actual registry key
    // (e.g. "slack-biz" for a named `connectors.instances[]` entry) whenever
    // the connector reports one, so development-reconciler.ts can resolve
    // strictly to the right instance instead of guessing by name.
    const instanceIdFields = connector.instanceId ? { connectorInstanceId: connector.instanceId } : {};
    const pendingRun: Omit<PendingDevelopmentRun, "runId"> = typeof request === "string"
      ? {
          storyId: null,
          requestDigest: createHash("sha256").update(request.trim()).digest("hex").slice(0, 8),
          connectorName: connector.name,
          ...instanceIdFields,
          channel: target.channel,
          ...(target.thread ? { thread: target.thread } : {}),
          startedAt: new Date().toISOString(),
          kind: "new",
        }
      : "continueGates" in request
        ? {
            storyId: request.storyId,
            connectorName: connector.name,
            ...instanceIdFields,
            channel: target.channel,
            ...(target.thread ? { thread: target.thread } : {}),
            startedAt: new Date().toISOString(),
            kind: "continue",
          }
        : {
            storyId: request.storyId,
            connectorName: connector.name,
            ...instanceIdFields,
            channel: target.channel,
            ...(target.thread ? { thread: target.thread } : {}),
            startedAt: new Date().toISOString(),
            kind: "resume",
          };
    const runId = recordPendingDevelopmentRun(pendingRun);
    this.inFlightDevelopmentRunId = runId;

    // Real progress (elapsed time, commit count, latest commit subject) is
    // shown via a message posted into the thread on the first snapshot and
    // then rewritten in place (`editMessage`) on every subsequent snapshot,
    // instead of the typing-status text Slack was found to ignore. Only
    // attempted when the connector actually supports rewriting a message
    // (Slack does; connectors without `messageEdits` just skip this and the
    // fixed "開発中…" typing indicator from above is all the user sees).
    const runStartedAt = Date.now();
    const supportsProgressMessage = connector.getCapabilities().messageEdits === true;
    let progressMessageTs: string | undefined;
    let lastProgressText: string | null = null;
    // Latest commit count seen from a progress snapshot, used as a fallback
    // for the final "⏱ 実行" rewrite when the delivered `DevelopmentResult`
    // itself carries no `commits` (e.g. a mid-run failure never reaches the
    // point where the runner reports commits on its result).
    let lastProgressCommits: number | undefined;
    // Serializes posts/edits so two progress ticks firing in the same
    // microtask (or a tick racing the final rewrite) can't both see "no
    // message posted yet" and post two separate messages, or land out of
    // order relative to each other.
    let progressChain: Promise<void> = Promise.resolve();

    const postOrUpdateProgressMessage = async (text: string): Promise<void> => {
      if (!target.thread) return;
      if (!progressMessageTs) {
        try {
          const ts = await connector.replyMessage(target, text);
          if (ts) progressMessageTs = ts;
        } catch (error) {
          logger.warn(`Failed to post development progress message: ${error instanceof Error ? error.message : error}`);
        }
        return;
      }
      try {
        await connector.editMessage({ ...target, messageTs: progressMessageTs }, text);
      } catch (error) {
        if (!isMessageNotFoundError(error)) {
          logger.warn(`Failed to update development progress message: ${error instanceof Error ? error.message : error}`);
          return;
        }
        // The tracked message is gone (e.g. deleted from the thread) — repost
        // once and track the new ts so later ticks resume editing in place.
        logger.warn(`Development progress message ${progressMessageTs} not found; reposting`);
        progressMessageTs = undefined;
        try {
          const ts = await connector.replyMessage(target, text);
          if (ts) progressMessageTs = ts;
        } catch (repostError) {
          logger.warn(`Failed to repost development progress message: ${repostError instanceof Error ? repostError.message : repostError}`);
        }
      }
    };

    // Deduped against the last text sent so a no-op tick (e.g. two
    // agent-phase snapshots in a row with the same commit count) doesn't
    // trigger a redundant Slack API call.
    const onProgress = (progress: DevelopmentProgress) => {
      if (!supportsProgressMessage || !target.thread) return;
      lastProgressCommits = progress.commits;
      const text = formatDevelopmentProgressMessage(progress);
      if (text === lastProgressText) return;
      lastProgressText = text;
      progressChain = progressChain.then(() => postOrUpdateProgressMessage(text));
    };

    // Rewrites the progress message one last time into its final "⏱ 実行"
    // form before the result card/message is delivered right after — a
    // no-op when no progress message was ever posted (e.g. the run finished
    // before the first snapshot, or the connector doesn't support edits).
    // Awaits any in-flight progress tick first so the last thing shown isn't
    // clobbered by a stale snapshot landing after it. Falls back to the last
    // progress snapshot's commit count when the result itself has none.
    const finalizeProgressMessage = async (commitCount?: number): Promise<void> => {
      await progressChain;
      if (!progressMessageTs) return;
      const resolvedCommitCount = commitCount ?? (lastProgressCommits && lastProgressCommits > 0 ? lastProgressCommits : undefined);
      const minutes = Math.max(0, Math.floor((Date.now() - runStartedAt) / 60000));
      await postOrUpdateProgressMessage(formatDevelopmentProgressFinal(minutes, resolvedCommitCount));
    };

    void runDevelopmentRequest(config, request, undefined, onProgress)
      .then(async (result) => {
        await finalizeProgressMessage(result.commits?.count);
        return this.deliverDevelopmentResult(result, connector, target);
      })
      .catch(async (error) => {
        logger.error(`Development runner failed: ${error instanceof Error ? error.message : "unknown error"}`);
        await finalizeProgressMessage(undefined);
        return connector.replyMessage(target, "Development task failed inside the isolated runner. No PR or deployment was performed.");
      })
      .finally(() => {
        // A successful delivery already reached Slack via the pipe above (or
        // the catch handler above posted the failure notice), so the pending
        // record is no longer needed either way — remove it after, never
        // before, delivery so a crash between "result received" and "record
        // removed" degrades toward the reconciler re-delivering (safe,
        // if occasionally duplicated) rather than losing the result.
        removePendingDevelopmentRun(runId);
        if (this.inFlightDevelopmentRunId === runId) this.inFlightDevelopmentRunId = null;
        this.developmentRunning = false;
        if (connector.setTypingStatus && target.thread) {
          connector.setTypingStatus(target.channel, target.thread, "").catch(() => {});
        }
      });
  }

  /**
   * One reconciliation sweep: delivers results for pending development runs
   * whose result already landed in the runner's spool, and posts an
   * interruption notice for runs that have been pending far longer than the
   * configured timeout with no spool and no in-flight owner. Called once at
   * gateway startup and on a periodic interval (see server.ts). No-ops when
   * `developmentRunner.resultsSpoolDir` is not configured.
   */
  async reconcileDevelopmentPending(): Promise<void> {
    if (!this.config.developmentRunner) return;
    await reconcilePendingDevelopmentRuns(this.config, {
      connectorProvider: this.connectorProvider,
      isInFlight: (run) => run.runId === this.inFlightDevelopmentRunId,
      deliverResult: (result, connector, target) => this.deliverDevelopmentResult(result, connector, target),
    });
  }

  private async deliverDevelopmentResult(result: DevelopmentResult, connector: Connector, target: Target): Promise<void> {
    if (result.status === "needs_decision" && result.storyId && result.questions && connector.postDecisionQuestions) {
      await connector.postDecisionQuestions(target, {
        storyId: result.storyId,
        questions: result.questions,
        summary: result.summary,
      });
      return;
    }
    if (result.status === "needs_input" && result.storyId && connector.postDevelopmentNeedsInput) {
      await connector.postDevelopmentNeedsInput(target, {
        storyId: result.storyId,
        summary: result.summary,
        gates: result.gates,
        commits: result.commits,
      });
      return;
    }
    await connector.replyMessage(target, formatDevelopmentResult(result));
  }

  /**
   * Resume a Story that previously stopped with `needs_decision`, after a
   * human answered the Slack question card/modal. This is the one allowed
   * round-trip of the Human-in-the-Loop loop — the resumed agent session is
   * instructed not to ask again.
   */
  resumeDevelopmentDecision(storyId: string, answers: DevelopmentAnswer[], connector: Connector, target: Target): boolean {
    const config = this.config.developmentRunner;
    if (!config?.enabled) return false;
    if (this.developmentRunning) return false;
    this.runDevelopmentFlow(config, { storyId, answers }, connector, target);
    return true;
  }

  /**
   * Continues a Story that previously stopped with `needs_input` because
   * VibePro gates were unresolved, after a human clicked the "続行してGateを
   * 解消させる" button on the needs_input result card. Re-runs the agent in
   * the same worktree and delivers the next result through the same
   * `deliverDevelopmentResult` path (which may again be a needs_input gate
   * card if some gates still require human judgment).
   */
  continueDevelopmentGates(storyId: string, connector: Connector, target: Target): boolean {
    const config = this.config.developmentRunner;
    if (!config?.enabled) return false;
    if (this.developmentRunning) return false;
    this.runDevelopmentFlow(config, { storyId, continueGates: true }, connector, target);
    return true;
  }

  resetSession(sessionKey: string): void {
    const session = getSessionBySessionKey(sessionKey);
    if (session) {
      deleteSession(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  private async handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
    const [_, subcommand = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (!subcommand || subcommand === "list") {
      const jobs = loadJobs();
      if (jobs.length === 0) {
        await connector.replyMessage(target, "No cron jobs configured.");
        return true;
      }

      const lines = jobs.map((job) =>
        `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
      );
      await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
      return true;
    }

    if (subcommand === "run") {
      if (!arg) {
        await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
        return true;
      }
      const job = await triggerCronJob(arg);
      await connector.replyMessage(
        target,
        job ? `Triggered cron job "${job.name}".` : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      if (!arg) {
        await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
        return true;
      }
      const job = setCronJobEnabled(arg, subcommand === "enable");
      await connector.replyMessage(
        target,
        job
          ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
          : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
    return true;
  }
}
