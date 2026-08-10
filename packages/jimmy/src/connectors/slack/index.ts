import * as SlackBoltNamespace from "@slack/bolt";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  DevelopmentAnswer,
  DevelopmentCommits,
  DevelopmentGate,
  DevelopmentQuestion,
  IncomingMessage,
  ReplyContext,
  SlackConnectorConfig,
  SlackRespondToConfig,
  Target,
  SlackGoalExtractionConfig,
} from "../../shared/types.js";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { normalizeSpeakerInfo, type SpeakerInfo } from "./speaker.js";
import { runTriage } from "./triage.js";
import { isShortAckCandidate } from "./triage-prompt.js";
import {
  evaluateRespondPolicy,
  hasMentionScope,
  respondPolicyNeedsTracking,
} from "./respond-policy.js";
import { isOperatorSpeaker } from "../../shared/operator-match.js";
import type { ChannelMembership } from "../../shared/placement-profile.js";
import type { PlacementProfile } from "../../shared/types.js";
import { ConversationTracker } from "./conversation-tracker.js";
import { AgentsCanvasUpdater } from "./agents-canvas.js";
import {
  TaskCanvasUpdater,
  placementProjectCodesForChannel,
  taskCanvasConfigsForPlacements,
} from "./task-canvas.js";
import { TaskReminderNotifier } from "./task-reminder.js";
import { MeetingTaskProposalNotifier } from "./meeting-task-proposal.js";
import {
  MeetingMinutesPipeline,
  type MeetingMinutesShareRequest,
  type MeetingMinutesUpdateRequest,
} from "./meeting-minutes-pipeline.js";
import { fitSlackOverview, splitForSlack } from "./meeting-minutes-generator.js";
import { VibeproDecisionNotifier } from "./vibepro-decision.js";
import { VibeproGateResultNotifier } from "./vibepro-gate-result.js";
import { extractGoalCondition, shouldExtractGoal } from "./goal-extractor.js";
import { startsWithSlashCommand } from "../../sessions/manager.js";
import type { SlackTriageConfig } from "../../shared/types.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import type { SlackChannelProbeSnapshot, SlackRuntimeSnapshot } from "../../gateway/settings-topology.js";
import {
  buildSettingsAppHomeBlocks,
  buildSettingsDmBlocks,
  buildSettingsTopologyUrl,
} from "./settings-deep-link.js";

// @slack/bolt is CommonJS. Node's ESM named-export detection does not expose
// SocketModeReceiver in production, even though TypeScript and Vitest accept a
// named import. Prefer the CommonJS default object at runtime while retaining
// the namespace fallback used by ESM test doubles.
const SlackBolt = (
  "default" in SlackBoltNamespace && SlackBoltNamespace.default
    ? SlackBoltNamespace.default
    : SlackBoltNamespace
) as typeof import("@slack/bolt");
const { App, SocketModeReceiver } = SlackBolt;

const SETTINGS_DM_COMMANDS = new Set(["設定", "mana設定", "ルーティング", "接続状態"]);

// Reaction-to-turn routing is intentionally off by default. Reactions do not
// communicate an unambiguous task, and the previous behavior could run a full
// turn using the reacted-to message without a clear user request. Keep the
// implementation below as a future extension; re-enable it only by changing
// this constant to true after its explicit interaction contract is decided.
const REACTION_TURN_TRIGGER_ENABLED = false;

export interface SlackConnectorContext {
  /** Placement SSOT used to scope channel projections to their project union. */
  placements?: PlacementProfile[];
  /** Display name of the Jinn instance (used as botName in triage) */
  portalName?: string;
  /** Configured operator name — used to identify operator vs third party */
  operatorName?: string;
  /** Additional operator names/handles (portal.operatorAliases) — see operator-match.ts. */
  operatorAliases?: string[];
  /** Whether this connector's routed sessions can consume Claude-only /goal prompts. */
  goalInjectionEnabled?: boolean;
  /** Whether the isolated development runner is enabled for this gateway. */
  developmentRunnerEnabled?: boolean;
  /** Slack channel IDs allowed to invoke the native development command. */
  developmentRunnerAllowedChannels?: string[];
  /**
   * Resumes a `/vibepro` Story that stopped with `needs_decision`, after a
   * human answered the question modal. Bound to
   * `SessionManager.resumeDevelopmentDecision` in the gateway. Returns false
   * when the runner is busy or disabled.
   */
  resumeDevelopmentDecision?: (
    storyId: string,
    answers: DevelopmentAnswer[],
    connector: Connector,
    target: Target,
  ) => boolean;
  /**
   * Fired when the BOT ITSELF is added to a channel (invite-driven placement
   * auto-provisioning). A returned string is posted to the channel as the
   * one-time greeting; undefined posts nothing.
   */
  onBotJoinedChannel?: (info: {
    channelId: string;
    workspaceId: string | null;
    inviterUserId: string | null;
  }) => Promise<string | undefined | void> | string | undefined | void;
  /** Fired when the bot leaves / is removed from a channel (placement disable). */
  onBotLeftChannel?: (info: { channelId: string; workspaceId: string | null }) => void;
  /** Resolves the live named Slack connector and performs an approved minutes copy. */
  shareMeetingMinutes?: (request: MeetingMinutesShareRequest) => Promise<{ parentTs: string }>;
  /** Resolves the exact live Slack connector and updates existing minutes in place. */
  updateMeetingMinutes?: (request: MeetingMinutesUpdateRequest) => Promise<{ parentTs: string; threadTs: string[] }>;
  /**
   * Continues a `/vibepro` Story that stopped with `needs_input` because
   * VibePro gates were unresolved, after a human clicked "続行してGateを
   * 解消させる" on the needs_input result card. Bound to
   * `SessionManager.continueDevelopmentGates` in the gateway. Returns false
   * when the runner is busy or disabled.
   */
  continueDevelopmentGates?: (
    storyId: string,
    connector: Connector,
    target: Target,
  ) => boolean;
}

export class SlackConnector implements Connector {
  name = "slack";
  // `name` is fixed across every instance (both the default workspace and any
  // named `connectors.instances[]` entry report "slack"), so it cannot
  // distinguish which Slack workspace a given instance is bound to.
  // `instanceId` carries the actual registry key (config.id, e.g. "slack-biz")
  // so callers that need to route back to this exact instance — the
  // development-reconciler in particular — don't misdeliver to whichever
  // Slack connector happens to be registered under the shared "slack" name.
  instanceId: string;
  private app: InstanceType<typeof App>;
  private readonly mode: "socket-mode" | "outbound-only";
  private readonly configuredWorkspaceId: string | null;
  private readonly outboundChannelAllowlist: Set<string>;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<string> | null;
  private readonly settingsHomeEnabled: boolean;
  private readonly settingsWebUrl: string | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private stopping = false;
  private lastError: string | null = null;
  private healthObservedAt: string | null = null;
  private channelNameCache = new Map<string, { name?: string; isExtShared: boolean; cachedAt: number }>();
  private channelMembersCache = new Map<string, { members: Set<string>; cachedAt: number }>();
  private userInfoCache = new Map<string, { info: SpeakerInfo; cachedAt: number }>();
  private botUserId: string | null = null;
  private workspaceId: string | null = null;
  private workspaceName: string | null = null;
  private topologyCheckedAt: string | null = null;
  private topologyChannels: Record<string, SlackChannelProbeSnapshot> = {};
  private topologyProbeGeneration = 0;
  private topologyProbeTargets: Array<{ channelId: string; workspaceId?: string }> = [];
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly triageConfig: SlackTriageConfig | undefined;
  private readonly respondTo: SlackRespondToConfig | undefined;
  private readonly goalExtractionConfig: SlackGoalExtractionConfig | undefined;
  private readonly portalName: string | undefined;
  private readonly operatorName: string | undefined;
  private readonly operatorAliases: string[] | undefined;
  private readonly goalInjectionEnabled: boolean;
  private readonly developmentRunnerEnabled: boolean;
  private readonly developmentRunnerAllowedChannels: Set<string>;
  private readonly onBotJoinedChannel: SlackConnectorContext["onBotJoinedChannel"];
  private readonly onBotLeftChannel: SlackConnectorContext["onBotLeftChannel"];
  private readonly shareMeetingMinutes: SlackConnectorContext["shareMeetingMinutes"];
  private readonly updateMeetingMinutes: SlackConnectorContext["updateMeetingMinutes"];
  private readonly conversations: ConversationTracker;
  private readonly agentsCanvas: AgentsCanvasUpdater | null;
  private readonly taskCanvases: TaskCanvasUpdater[];
  private readonly taskReminder: TaskReminderNotifier | null;
  private readonly meetingTaskProposal: MeetingTaskProposalNotifier | null;
  private readonly meetingMinutesPipeline: MeetingMinutesPipeline | null;
  private readonly vibeproDecision: VibeproDecisionNotifier | null;
  private readonly vibeproGateResult: VibeproGateResultNotifier | null;
  private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour
  private static USER_CACHE_TTL_MS = 3600_000; // 1 hour
  // Short TTL: membership gates authorization, so a removed member must lose
  // access quickly while normal traffic still avoids per-message API calls.
  private static MEMBERS_CACHE_TTL_MS = 300_000; // 5 minutes

  private readonly capabilities: ConnectorCapabilities = {
    threading: true,
    messageEdits: true,
    reactions: true,
    attachments: true,
  };

  private formatSlackError(err: unknown): string {
    if (err instanceof Error) {
      const data = (err as any).data;
      const slackError = data?.error ? ` (${data.error})` : "";
      const detail = data?.detail ? `: ${data.detail}` : "";
      return `${err.message}${slackError}${detail}`;
    }
    return String(err);
  }

  private async sendTypingStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    const payload = {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    };
    try {
      const client = this.app.client as any;
      if (client.assistant?.threads?.setStatus) {
        await client.assistant.threads.setStatus(payload);
      } else if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setStatus", payload);
      }
    } catch (err) {
      logger.warn(`Slack typing status failed: ${this.formatSlackError(err)}`);
    }
  }

  /**
   * Set the AI assistant typing status in a thread.
   * Uses Slack's assistant.threads.setStatus API for native animated indicator.
   */
  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    if (!threadTs) return;
    const key = `${channelId}:${threadTs}`;
    const existing = this.typingIntervals.get(key);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(key);
    }

    await this.sendTypingStatus(channelId, threadTs, status);
    if (!status) return;

    // Slack clears assistant status after roughly two minutes if no message is
    // sent, so refresh while long-running engine calls are still active.
    const interval = setInterval(() => {
      this.sendTypingStatus(channelId, threadTs, status).catch(() => {});
    }, 90_000);
    this.typingIntervals.set(key, interval);
  }

  constructor(config: SlackConnectorConfig, context: SlackConnectorContext = {}) {
    this.instanceId = config.id || "slack";
    this.mode = config.mode ?? "socket-mode";
    this.configuredWorkspaceId = config.workspaceId?.trim() || null;
    this.outboundChannelAllowlist = new Set(config.outboundChannelAllowlist ?? []);
    if (this.mode === "outbound-only") {
      // Bolt's default HTTP receiver requires a signing secret even when it is
      // never started. Supply an inert receiver so outbound-only instances
      // construct only the Web API client and cannot accept inbound traffic.
      const outboundReceiver = {
        init: async () => {},
        start: async () => {},
        stop: async () => {},
      };
      this.app = new App({ token: config.botToken, receiver: outboundReceiver as any });
    } else {
      if (!config.appToken) throw new Error("Socket-mode Slack connector requires appToken");
      const receiver = new SocketModeReceiver({ appToken: config.appToken });
      this.app = new App({ token: config.botToken, receiver });
      this.bindRuntimeHealthSignals(receiver.client);
    }
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    const allowFrom = Array.isArray(config.allowFrom)
      ? config.allowFrom
      : typeof config.allowFrom === "string"
        ? config.allowFrom.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
    this.allowedUsers = allowFrom.length > 0 ? new Set(allowFrom) : null;
    this.settingsHomeEnabled = config.settingsHome?.enabled === true;
    this.settingsWebUrl = buildSettingsTopologyUrl(config.settingsHome?.webBaseUrl);
    this.triageConfig = config.triage;
    this.respondTo = config.respondTo;
    this.goalExtractionConfig = config.goalExtraction;
    this.portalName = context.portalName;
    this.operatorName = context.operatorName;
    this.operatorAliases = context.operatorAliases;
    this.goalInjectionEnabled = context.goalInjectionEnabled === true;
    this.developmentRunnerEnabled = context.developmentRunnerEnabled === true;
    this.developmentRunnerAllowedChannels = new Set(
      context.developmentRunnerAllowedChannels?.filter(Boolean) ?? [],
    );
    this.onBotJoinedChannel = context.onBotJoinedChannel;
    this.onBotLeftChannel = context.onBotLeftChannel;
    this.shareMeetingMinutes = context.shareMeetingMinutes;
    this.updateMeetingMinutes = context.updateMeetingMinutes;
    this.conversations = new ConversationTracker();
    this.agentsCanvas = config.agentsCanvas?.enabled
      ? new AgentsCanvasUpdater(this.app, config.agentsCanvas)
      : null;
    const taskCanvasConfigs = config.taskCanvas?.enabled
      ? taskCanvasConfigsForPlacements(
          { ...config.taskCanvas, settingsWebBaseUrl: config.settingsHome?.webBaseUrl },
          context.placements,
          this.instanceId,
          this.configuredWorkspaceId,
        )
      : [];
    this.taskCanvases = taskCanvasConfigs.map((canvasConfig) => new TaskCanvasUpdater(this.app, canvasConfig));
    this.taskReminder = config.taskReminder?.enabled
      ? new TaskReminderNotifier(this.app, config.taskReminder)
      : null;
    this.meetingTaskProposal = config.meetingTaskProposal?.enabled
      ? new MeetingTaskProposalNotifier(this.app, config.meetingTaskProposal, allowFrom, {
          projectCodesForChannel: (channelId) =>
            placementProjectCodesForChannel(
              context.placements,
              this.instanceId,
              channelId,
              this.configuredWorkspaceId,
            ),
        })
      : null;
    this.meetingMinutesPipeline = config.meetingMinutesPipeline?.enabled
      ? new MeetingMinutesPipeline(this.app, config.meetingMinutesPipeline, allowFrom, {
          taskProposalNotifier: this.meetingTaskProposal,
          sourceConnectorInstanceId: this.instanceId,
          shareMinutes: this.shareMeetingMinutes,
          updateMinutes: this.updateMeetingMinutes,
          settingsWebBaseUrl: config.settingsHome?.webBaseUrl,
          getWorkspaceId: () => this.workspaceId,
        })
      : null;
    this.vibeproDecision = this.developmentRunnerEnabled
      ? new VibeproDecisionNotifier(this.app, allowFrom, {
          resumeDecision: (storyId, answers, target) =>
            context.resumeDevelopmentDecision?.(storyId, answers, this, target) ?? false,
        })
      : null;
    this.vibeproGateResult = this.developmentRunnerEnabled
      ? new VibeproGateResultNotifier(this.app, allowFrom, {
          continueGates: (storyId, target) =>
            context.continueDevelopmentGates?.(storyId, this, target) ?? false,
        })
      : null;
  }

  /**
   * Bolt does not project Socket Mode liveness into ConnectorHealth for us.
   * Bind the receiver's public EventEmitter contract so a dropped connection
   * immediately invalidates previously verified topology evidence. Keep the
   * stored and logged detail stable/redacted. Runtime errors can contain token
   * material, so raw/formatted error values must not cross the log boundary.
   */
  private bindRuntimeHealthSignals(socketClient: {
    on: (event: string, handler: (...args: any[]) => void) => unknown;
  }): void {
    const markUnavailable = (signal: string) => {
      if (this.stopping) return;
      this.lastError = "slack_runtime_unavailable";
      this.healthObservedAt = new Date().toISOString();
      this.invalidateSettingsTopologyProbe();
      logger.warn(`[slack] runtime ${signal} code=slack_runtime_unavailable connector=${this.instanceId}`);
    };
    const markConnected = () => {
      if (this.stopping) return;
      this.lastError = null;
      this.healthObservedAt = new Date().toISOString();
      const targets = this.topologyProbeTargets.map((target) => ({ ...target }));
      if (targets.length > 0) {
        void this.refreshSettingsTopologyProbe(targets).catch(() => {
          // refreshSettingsTopologyProbe classifies each target fail-closed.
        });
      }
    };

    socketClient.on("error", () => markUnavailable("error"));
    socketClient.on("reconnecting", () => markUnavailable("reconnecting"));
    socketClient.on("disconnected", () => markUnavailable("disconnected"));
    socketClient.on("connected", markConnected);

    this.app.error(async () => {
      // A Bolt handler error does not imply that Socket Mode is disconnected.
      // Keep transport health intact and emit only a stable, redacted signal.
      logger.warn(`[slack] runtime handler_error code=slack_handler_failed connector=${this.instanceId}`);
    });
  }

  /**
   * Conversation tracking feeds two consumers: triage DM-equivalence and the
   * respondTo engaged-thread exception. When neither is active, tracking is
   * skipped entirely — engaged entries can't be evicted, so tracking in the
   * default configuration would just leak memory.
   */
  private conversationTrackingEnabled(): boolean {
    return this.triageConfig?.enabled === true || respondPolicyNeedsTracking(this.respondTo);
  }

  private async resolveSpeakerInfo(userId: string | undefined): Promise<SpeakerInfo | null> {
    if (!userId) return null;
    const cached = this.userInfoCache.get(userId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.USER_CACHE_TTL_MS) {
      return cached.info;
    }
    try {
      const result = await this.app.client.users.info({ user: userId });
      const info = normalizeSpeakerInfo(result.user as any, userId);
      this.userInfoCache.set(userId, { info, cachedAt: Date.now() });
      return info;
    } catch (err) {
      logger.debug(`Failed to resolve speaker info for ${userId}: ${err}`);
      return null;
    }
  }

  private speakerTransportFields(speaker: SpeakerInfo | null, userId: string) {
    return {
      speakerName: speaker?.name ?? null,
      speakerRealName: speaker?.realName ?? null,
      speakerDisplayName: speaker?.displayName ?? null,
      speakerHandle: speaker?.handle ?? null,
      speakerSlackId: userId,
      speakerIsBot: speaker?.isBot ?? null,
      speakerTz: speaker?.tz ?? null,
    };
  }

  private async runSlackTriage(
    event: { channel: string; ts?: string; thread_ts?: string },
    ctx: {
      speaker: SpeakerInfo | null;
      channelType: string;
      channelName?: string;
      wasMentioned: boolean;
      messageText: string;
      /** Short-ack in an established 1:1 conversation — triage runs in react-vs-reply mode. */
      dmEquivalent?: boolean;
    },
  ): Promise<{ action: "silent" | "react" | "reply"; emoji?: string; reason?: string }> {
    const threadLimit = this.triageConfig?.threadContextLimit ?? 10;
    const recentThread = await this.fetchRecentThreadForTriage(
      event.channel,
      event.thread_ts,
      event.ts,
      threadLimit,
    );

    const speakerName = ctx.speaker?.name ?? "unknown";
    // Shared normalized matcher — the old exact `includes(operatorName)` never
    // matched a nickname operatorName against profile names, so triage saw the
    // operator as a third party (see operator-match.ts).
    const speakerIsOperator = !!ctx.speaker && isOperatorSpeaker(
      [ctx.speaker.name, ctx.speaker.realName, ctx.speaker.displayName, ctx.speaker.handle],
      this.operatorName,
      this.operatorAliases,
    );

    const channelDescription = ctx.channelName ? `#${ctx.channelName}` : event.channel;

    return runTriage(
      {
        botName: this.portalName || "Ryoko",
        persona: this.triageConfig?.persona,
        operatorName: this.operatorName,
        channelType: ctx.channelType,
        channelDescription,
        speakerName,
        speakerIsOperator,
        wasMentioned: ctx.wasMentioned,
        recentThread,
        messageText: ctx.messageText,
        dmEquivalent: ctx.dmEquivalent,
      },
      {
        bin: this.triageConfig?.bin,
        engine: this.triageConfig?.engine,
        model: this.triageConfig?.model,
        timeoutMs: this.triageConfig?.timeoutMs,
        // Ambient messages (not DM, not @-mention, not active thread): when we
        // know our own ID, a fail-open *reply* is a guaranteed barge-in, so stay
        // silent; the legacy reply fallback only covers the startup race where
        // auth.test never resolved our botUserId. DM-equivalent short-acks are
        // the opposite — the message IS addressed to us, so a triage failure
        // must fall back to the full reply, never to ghosting.
        failOpenAction: ctx.dmEquivalent || !this.botUserId ? "reply" : "silent",
      },
    );
  }

  private async fetchRecentThreadForTriage(
    channelId: string,
    threadTs: string | undefined,
    messageTs: string | undefined,
    limit: number,
  ): Promise<Array<{ speaker: string; text: string }>> {
    try {
      const messages = threadTs
        ? (await this.app.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: Math.max(1, limit),
          })).messages
        : (await this.app.client.conversations.history({
            channel: channelId,
            limit: Math.max(1, limit),
            latest: messageTs,
            inclusive: false,
          })).messages;

      if (!messages) return [];
      const chronological = threadTs ? messages : [...messages].reverse();
      const result: Array<{ speaker: string; text: string }> = [];
      for (const m of chronological) {
        const text = (m as any).text as string | undefined;
        if (!text) continue;
        const userId = (m as any).user as string | undefined;
        const botId = (m as any).bot_id as string | undefined;
        const speakerLabel = userId
          ? (await this.resolveSpeakerInfo(userId))?.name ?? userId
          : botId
            ? `bot:${botId}`
            : "unknown";
        result.push({ speaker: speakerLabel, text });
      }
      return result;
    } catch (err) {
      logger.debug(`[triage] failed to fetch recent thread: ${err}`);
      return [];
    }
  }

  /**
   * Resolve channel name and external-shared status in one cached call.
   * `isExtShared` is true for Slack Connect (externally/org shared) channels —
   * the delivery layer treats these (and unknowns) as "external" so the model's
   * operator-facing notes are never posted there. See reply-disposition.ts.
   */
  private async resolveChannelInfo(channelId: string): Promise<{ name?: string; isExtShared: boolean }> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
      return { name: cached.name, isExtShared: cached.isExtShared };
    }
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const channel = result.channel as { name?: string; is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean } | undefined;
      const name = channel?.name;
      const isExtShared = !!(channel?.is_ext_shared || channel?.is_org_shared || channel?.is_shared);
      this.channelNameCache.set(channelId, { name, isExtShared, cachedAt: Date.now() });
      return { name, isExtShared };
    } catch (err) {
      logger.debug(`Failed to resolve channel info for ${channelId}: ${err}`);
    }
    // Unknown → treat as external (safe): never assume a channel is private.
    return { name: undefined, isExtShared: true };
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    return (await this.resolveChannelInfo(channelId)).name;
  }

  /**
   * Membership verdict for "channel-members" placements. Backed by
   * conversations.members with a short TTL cache; any failure returns
   * "unknown", which resolvePlacement treats as a denial (fail-closed —
   * a Slack outage must never widen access).
   */
  async getChannelMembership(channelId: string, userId: string): Promise<ChannelMembership> {
    const cached = this.channelMembersCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.MEMBERS_CACHE_TTL_MS) {
      return cached.members.has(userId) ? "member" : "non-member";
    }
    try {
      const members = new Set<string>();
      let cursor: string | undefined;
      // Bounded pagination (25 × 200 = 5000 members) so a huge channel can't
      // make us loop forever; hitting the bound falls through to fail-closed.
      for (let page = 0; page < 25; page++) {
        const res = await this.app.client.conversations.members({
          channel: channelId,
          limit: 200,
          cursor,
        });
        for (const member of res.members ?? []) members.add(member);
        cursor = res.response_metadata?.next_cursor || undefined;
        if (!cursor) {
          this.channelMembersCache.set(channelId, { members, cachedAt: Date.now() });
          return members.has(userId) ? "member" : "non-member";
        }
      }
      logger.warn(`[slack] conversations.members pagination bound hit for ${channelId} — failing closed`);
      return "unknown";
    } catch (err) {
      logger.warn(`[slack] conversations.members failed for ${channelId}: ${this.formatSlackError(err)}`);
      return "unknown";
    }
  }

  async start() {
    if (this.mode === "outbound-only") {
      try {
        const authResult = await this.app.client.auth.test();
        if (!this.configuredWorkspaceId || authResult.team_id !== this.configuredWorkspaceId) {
          throw new Error("outbound-only workspace identity mismatch");
        }
        this.botUserId = authResult.user_id ?? null;
        this.workspaceId = authResult.team_id ?? null;
        this.workspaceName = typeof authResult.team === "string" ? authResult.team : null;
        await this.refreshSettingsTopologyProbe(
          [...this.outboundChannelAllowlist].map((channelId) => ({
            channelId,
            workspaceId: this.configuredWorkspaceId ?? undefined,
          })),
          true,
        );
        const snapshot = this.getSettingsTopologySnapshot();
        if ([...this.outboundChannelAllowlist].some((channelId) => snapshot.channels[channelId]?.status !== "verified")) {
          throw new Error("outbound-only channel readiness failed");
        }
        this.started = true;
        this.lastError = null;
        logger.info(`[slack] outbound-only connector ready connector=${this.instanceId}`);
        return;
      } catch (err) {
        this.started = false;
        this.lastError = "slack_outbound_readiness_failed";
        this.healthObservedAt = new Date().toISOString();
        throw err;
      }
    }
    // "/vibepro" is the primary command name; "/ryoko-develop" stays registered
    // so Slack apps whose installed manifest still declares the old command
    // keep working until they are re-installed with the updated manifest.
    for (const slashCommand of ["/vibepro", "/ryoko-develop"] as const) {
      this.app.command(slashCommand, async ({ command, ack, respond }) => {
        // Slack requires interactive payloads to be acknowledged within three
        // seconds. Do that before any lookup or development-runner work.
        await ack();

        // Development is privileged: unlike ordinary Slack conversation routing,
        // an absent allowFrom list must not mean "everyone" for this command.
        if (!this.allowedUsers?.has(command.user_id)) {
          logger.warn(`[slack] Ignoring unauthorized ${command.command} from ${command.user_id}`);
          await respond({
            response_type: "ephemeral",
            text: "You are not authorized to start development tasks.",
          });
          return;
        }
        if (!this.developmentRunnerEnabled) {
          await respond({
            response_type: "ephemeral",
            text: "The development runner is disabled.",
          });
          return;
        }
        if (!this.developmentRunnerAllowedChannels.has(command.channel_id)) {
          logger.warn(`[slack] Rejecting ${command.command} outside an allowed channel: ${command.channel_id}`);
          await respond({
            response_type: "ephemeral",
            text: "Development tasks are not enabled in this channel.",
          });
          return;
        }
        if (!this.handler) {
          logger.warn(`[slack] No handler registered for ${command.command}`);
          await respond({
            response_type: "ephemeral",
            text: "The development gateway is not ready. Try again shortly.",
          });
          return;
        }

        const channelId = command.channel_id;
        const userId = command.user_id;
        const request = command.text.trim();
        const [channelInfo, speaker] = await Promise.all([
          this.resolveChannelInfo(channelId),
          this.resolveSpeakerInfo(userId),
        ]);
        const channelType = command.channel_name === "directmessage" ? "im" : "channel";
        const msg: IncomingMessage = {
          connector: this.name,
          source: "slack",
          sessionKey: `slack:command:${channelId}:${userId}`,
          replyContext: { channel: channelId },
          channel: channelId,
          user: userId,
          userId,
          text: request ? `/develop ${request}` : "/develop",
          attachments: [],
          raw: command,
          transportMeta: {
            channelType,
            channelExternal: channelType !== "im" && channelInfo.isExtShared,
            team: command.team_id || null,
            channelName: channelInfo.name || command.channel_name || null,
            wasMentioned: false,
            ...this.speakerTransportFields(speaker, userId),
          },
        };

        this.handler(msg);
      });
    }

    this.app.event("app_home_opened", async ({ event }) => {
      const userId = (event as any).user as string | undefined;
      // Configuration discovery is fail-closed even though ordinary Slack
      // messages preserve their legacy open semantics when allowFrom is absent.
      if (!this.settingsHomeEnabled || !userId || !this.allowedUsers?.has(userId)) return;
      const blocks = buildSettingsAppHomeBlocks({
        webBaseUrl: this.settingsWebUrl ?? undefined,
        running: this.started && !this.lastError,
        instanceId: this.instanceId,
      });
      await this.app.client.views.publish({ user_id: userId, view: { type: "home", blocks } });
    });

    this.app.message(async ({ event, context }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} channel_type=${(event as any).channel_type ?? "-"} thread_ts=${(event as any).thread_ts ?? "-"} subtype=${(event as any).subtype ?? "-"} text="${((event as any).text || "").slice(0, 50)}"`);
      // Skip bot's own messages
      if ((event as any).bot_id) {
        logger.info(`[slack] Skipping bot message`);
        return;
      }
      // Skip ghost events from URL unfurls (user=undefined, text="")
      if (!(event as any).user) {
        logger.debug(`[slack] Skipping event with no user (likely URL unfurl)`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage((event as any).ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack message ${(event as any).ts}`);
        return;
      }
      if (this.allowedUsers && !this.allowedUsers.has((event as any).user)) {
        logger.debug(`Ignoring Slack message from unauthorized user ${(event as any).user}`);
        return;
      }

      const slackUserId = (event as any).user as string;
      const rawText = ((event as any).text || "") as string;
      const channelType = ((event as any).channel_type as string) || "channel";
      const threadTs = (event as any).thread_ts as string | undefined;
      const wasMentioned = !!this.botUserId && rawText.includes(`<@${this.botUserId}>`);

      if (
        channelType === "im" &&
        this.settingsHomeEnabled &&
        this.allowedUsers?.has(slackUserId) &&
        SETTINGS_DM_COMMANDS.has(rawText.trim())
      ) {
        const blocks = buildSettingsDmBlocks(this.settingsWebUrl ?? undefined);
        await this.app.client.chat.postMessage({
          channel: (event as any).channel,
          text: "Mana設定",
          blocks,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return;
      }

      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping message`);
        return;
      }

      const triageEnabled = this.triageConfig?.enabled === true;
      const conversationKey = {
        channel: (event as any).channel as string,
        threadTs,
        ts: (event as any).ts as string | undefined,
        userId: slackUserId,
      };
      // Record the human speaker even for messages the gates below drop:
      // a third human joining a thread must invalidate DM-equivalence
      // whether or not we end up responding to their message.
      if (this.conversationTrackingEnabled()) {
        this.conversations.recordHumanMessage(conversationKey);
      }

      // Deterministic respondTo gate — evaluated before any network fetches
      // and before LLM triage, so gated scopes cost nothing for dropped
      // messages. "mention" scopes drop un-mentioned messages outright,
      // except inside threads the bot has already engaged.
      const respondDecision = evaluateRespondPolicy({
        config: this.respondTo,
        channelType,
        wasMentioned,
        isEngagedThread:
          !!threadTs &&
          this.conversations.isBotEngagedThread((event as any).channel, threadTs),
      });
      if (!respondDecision.allow) {
        logger.info(
          `[slack] respondTo gate → silent (${respondDecision.reason}) for ts=${(event as any).ts}`,
        );
        return;
      }

      // Early silent for cross-bot / cross-user traffic in shared channels.
      // If the message @-mentions specific user(s), none of whom are us, and
      // it isn't a DM, stay silent — regardless of whether the thread was
      // previously marked "active" by an earlier reply. The activeThread
      // TTL exists for mid-conversation follow-ups, not for sibling mentions
      // directed at another bot or human in the same channel.
      if (!wasMentioned && this.botUserId && channelType !== "im") {
        const mentionedUsers = Array.from(
          rawText.matchAll(/<@([UW][A-Z0-9]+)>/g),
          (m) => m[1],
        );
        if (mentionedUsers.length > 0 && !mentionedUsers.includes(this.botUserId)) {
          logger.info(
            `[slack] message @-mentions ${mentionedUsers.join(",")} (not us) — staying silent for ts=${(event as any).ts}`,
          );
          return;
        }
      }

      const sessionKey = deriveSessionKey(event as any, {
        connectorInstanceId: this.instanceId,
        workspaceId: context.teamId || "unknown",
      });
      const replyContext = buildReplyContext(event as any);

      // Download attachments if present
      const attachments = [];
      if ((event as any).files) {
        for (const file of (event as any).files) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const [channelInfo, speaker] = await Promise.all([
        this.resolveChannelInfo((event as any).channel),
        this.resolveSpeakerInfo(slackUserId),
      ]);
      const channelName = channelInfo.name;

      // DM is never "external"; otherwise trust the Slack Connect flag.
      const channelExternal = channelType !== "im" && channelInfo.isExtShared;

      // A thread can first reach us on a reply, so its root may never have been
      // persisted by Mana. Hydrate that root once into the user turn. Broader
      // cross-thread context still comes from the scoped turn-preparation service.
      let parentContext = "";
      if (threadTs && threadTs !== (event as any).ts) {
        try {
          const parent = await this.app.client.conversations.replies({
            channel: (event as any).channel,
            ts: threadTs,
            inclusive: true,
            limit: 1,
          });
          const parentText = parent.messages?.[0]?.text?.trim();
          if (parentText) parentContext = `[Slack thread root]\n${parentText}\n\n`;
        } catch (err) {
          logger.warn(`[slack] Failed to hydrate thread root: ${this.formatSlackError(err)}`);
        }
      }
      const text = startsWithSlashCommand(rawText) ? rawText : `${parentContext}${rawText}`;

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: (event as any).ts,
        channel: (event as any).channel,
        thread: (event as any).thread_ts,
        user: (event as any).user,
        userId: (event as any).user,
        text,
        attachments,
        raw: event,
        transportMeta: {
          channelType,
          channelExternal,
          team: context.teamId || null,
          channelName: channelName || null,
          wasMentioned,
          ...this.speakerTransportFields(speaker, slackUserId),
        },
      };

      // Air-reading triage gate.
      // Fast paths that bypass the LLM triage entirely:
      //   - DMs: 1:1 context is implicitly addressed to the bot
      //   - Explicit @-mention: always reply
      //   - DM-equivalent conversation: bot has engaged AND only this user has
      //     spoken in the conversation (thread or channel-user scope). Permanent
      //     until a third human joins.
      const isDmEquivalent =
        triageEnabled && channelType !== "im" && !wasMentioned
          ? this.conversations.isDmEquivalent(conversationKey)
          : false;
      // Short-ack exception: the always-reply fast paths (real DMs and
      // DM-equivalent conversations) otherwise swallow the one situation
      // react-triage is FOR — "ありがとう"/"了解" right after the bot replied
      // (the bot having replied is what makes a conversation DM-equivalent).
      // Send lexical short-ack candidates through triage in a 1:1-aware mode
      // (react vs reply, never silent) so a bare thanks can get an emoji
      // instead of a full engine turn. Everything else keeps the fast-path
      // full reply. @-mentions always get a real reply, even short ones.
      const shortAckTriage =
        (channelType === "im" || isDmEquivalent) &&
        !wasMentioned &&
        attachments.length === 0 &&
        isShortAckCandidate(rawText);
      const skipTriage =
        !triageEnabled ||
        wasMentioned ||
        ((channelType === "im" || isDmEquivalent) && !shortAckTriage);

      if (triageEnabled && isDmEquivalent && !shortAckTriage) {
        logger.info(`[slack] skipping triage — DM-equivalent conversation in ${(event as any).channel}`);
      }

      if (!skipTriage) {
        const decision = await this.runSlackTriage(event as any, {
          speaker,
          channelType,
          channelName: channelName ?? undefined,
          wasMentioned,
          messageText: rawText,
          dmEquivalent: shortAckTriage,
        });

        if (decision.action === "silent") {
          if (shortAckTriage) {
            // 1:1 conversation — the message IS addressed to the bot; ghosting is
            // not acceptable. Treat a stray "silent" as the pre-exception behavior.
            logger.info(`[slack] triage → silent in DM-equivalent short-ack path — upgrading to reply for ts=${(event as any).ts}`);
          } else {
            logger.info(`[slack] triage → silent (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
            return;
          }
        }
        if (decision.action === "react") {
          const emoji = decision.emoji || "eyes";
          logger.info(`[slack] triage → react :${emoji}: (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
          try {
            await this.app.client.reactions.add({
              channel: (event as any).channel,
              timestamp: (event as any).ts,
              name: emoji,
            });
            this.conversations.recordBotEngaged(conversationKey);
          } catch (err) {
            logger.debug(`[slack] failed to add triage reaction: ${err}`);
          }
          return;
        }
        logger.info(`[slack] triage → reply (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
      }

      if (this.conversationTrackingEnabled()) {
        this.conversations.recordBotEngaged(conversationKey);
      }

      // Natural-language `/goal` injection.
      //
      // This is intentionally OUTSIDE the triage path. Triage decides
      // "should we even respond"; goal extraction decides "if we respond,
      // should the session run autonomously until a condition holds".
      // The two questions are independent — DM / @-mention / DM-equivalent
      // messages skip triage but still benefit from /goal — so we apply
      // the extractor here, at the single point every reply-bound message
      // passes through.
      //
      // The earlier keyword-regex approach missed natural Japanese phrasings
      // ("完了と書いたら止まる" without "最後までやって" etc.) so we now
      // always defer to a Haiku call gated only by a cheap length check.
      // Haiku returns null fast for non-goal messages; sanitisation in the
      // parser blocks slash-prefix injection and sentinel placeholders.
      if (this.goalInjectionEnabled && this.goalExtractionConfig?.enabled === true && shouldExtractGoal(msg.text)) {
        try {
          const condition = await extractGoalCondition(msg.text, this.goalExtractionConfig);
          if (condition) {
            logger.info(`[slack] /goal injected: ${condition.slice(0, 100)}`);
            msg.text = `/goal ${condition}\n\n${msg.text}`;
          }
        } catch (err) {
          // extractGoalCondition already catches its own errors; defensive.
          logger.debug(`[slack] goal-extractor unexpected error: ${err}`);
        }
      }

      this.handler(msg);
    });

    // Fetch bot's own user ID for filtering self-reactions
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id ?? null;
      this.workspaceId = authResult.team_id ?? null;
      this.workspaceName = typeof authResult.team === "string" ? authResult.team : null;
      this.topologyCheckedAt = new Date().toISOString();
      logger.info(`[slack] Bot user ID: ${this.botUserId}`);
    } catch {
      logger.warn(`[slack] runtime auth_test_failed code=slack_auth_test_failed connector=${this.instanceId}`);
    }
    // Fail closed: without our own user ID, mention detection is impossible,
    // so mention-gated scopes will drop everything (except engaged threads).
    // That honors "never barge in un-mentioned" at the cost of missed
    // mentions until the next successful start — surface it loudly.
    if (!this.botUserId && hasMentionScope(this.respondTo)) {
      logger.warn(
        "[slack] respondTo mention gate is configured but the bot user ID could not be resolved — un-mentioned messages in mention scopes will be dropped",
      );
    }

    this.app.event("reaction_added", async ({ event, context }) => {
      // Do this before every side effect, including the eyes acknowledgement.
      // See REACTION_TURN_TRIGGER_ENABLED above for the explicit re-enable path.
      if (!REACTION_TURN_TRIGGER_ENABLED) return;

      // Only handle reactions on messages (not files, etc.)
      if (event.item.type !== "message") return;

      // Skip bot's own reactions
      if (this.botUserId && event.user === this.botUserId) return;

      if (!this.handler) return;

      // Check allowed users
      if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
        return;
      }

      const channelId = event.item.channel;
      const messageTs = event.item.ts;
      const emoji = event.reaction;

      // Skip reactions that were replayed on boot. Gate on the REACTION's own event time
      // (event_ts), NOT the reacted-to message's age — a fresh reaction on an old message
      // (e.g. approving an approval card that has been waiting for hours) must still be honored.
      const reactionTs = (event as any).event_ts || messageTs;
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(reactionTs, this.bootTimeMs)) {
        logger.debug(`Ignoring old (replayed-on-boot) Slack reaction event ${reactionTs}`);
        return;
      }

      logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

      // Instant ack so the user can see the gateway heard the reaction.
      try {
        await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "eyes" });
      } catch (err) {
        logger.debug(`[slack] eyes ack skipped (likely already reacted): ${err}`);
      }

      // Fetch the reacted-to message text
      // Try conversations.history first (works for root messages),
      // fall back to conversations.replies (for threaded messages)
      let messageText = "";
      try {
        const histResult = await this.app.client.conversations.history({
          channel: channelId,
          latest: messageTs,
          oldest: messageTs,
          inclusive: true,
          limit: 1,
        });
        messageText = histResult.messages?.[0]?.text || "";

        // If not found in history, try as a threaded reply
        if (!messageText) {
          const replyResult = await this.app.client.conversations.replies({
            channel: channelId,
            ts: messageTs,
            limit: 1,
            inclusive: true,
          });
          messageText = replyResult.messages?.[0]?.text || "";
        }
      } catch (err) {
        logger.warn(`[slack] Failed to fetch reacted-to message: ${err}`);
        return;
      }

      if (!messageText) {
        logger.debug(`[slack] Reacted-to message has no text, skipping`);
        return;
      }

      // Resolve channel name/external status and reactor (speaker) in parallel
      const [channelInfo, speaker] = await Promise.all([
        this.resolveChannelInfo(channelId),
        this.resolveSpeakerInfo(event.user),
      ]);
      const channelName = channelInfo.name;
      const channelDisplay = channelName ? `#${channelName}` : channelId;

      // Build the prompt with reaction context
      const prompt = `[Reaction :${emoji}: on message in ${channelDisplay}]\n\nOriginal message:\n"${messageText}"\n\nThe user reacted with :${emoji}: to this message. Interpret and act on the reaction.`;

      const sessionKey = `slack:reaction:${channelId}:${messageTs}`;

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext: {
          channel: channelId,
          thread: messageTs,
          messageTs,
        },
        messageId: messageTs,
        channel: channelId,
        thread: messageTs,
        user: event.user,
        userId: event.user,
        text: prompt,
        attachments: [],
        raw: event,
        transportMeta: {
          channelType: "channel",
          channelExternal: channelInfo.isExtShared,
          team: context.teamId || null,
          channelName: channelName || null,
          ...this.speakerTransportFields(speaker, event.user),
        },
      };

      this.handler(msg);
    });

    // Invite-driven placement auto-provisioning: only the BOT'S OWN join
    // event provisions anything — another user joining a channel must never
    // trigger a config write. botUserId is resolved by the auth.test above;
    // if that failed we cannot prove the join is ours, so do nothing
    // (fail-closed no-op, same as every other error in this path).
    this.app.event("member_joined_channel", async ({ event, context }) => {
      if (!this.onBotJoinedChannel) return;
      if (!this.botUserId || (event as any).user !== this.botUserId) return;
      const channelId = (event as any).channel as string;
      const workspaceId = ((event as any).team as string | undefined) || context.teamId || null;
      const inviterUserId = ((event as any).inviter as string | undefined) || null;
      try {
        const greeting = await this.onBotJoinedChannel({ channelId, workspaceId, inviterUserId });
        if (typeof greeting === "string" && greeting.trim()) {
          await this.sendMessage({ channel: channelId }, greeting);
        }
      } catch (err) {
        logger.error(`[slack] auto-provision on join failed for ${channelId}: ${this.formatSlackError(err)}`);
      }
    });

    // channel_left / group_left fire for the bot itself when it leaves or is
    // removed from a public/private channel — the placement disable path.
    for (const leftEvent of ["channel_left", "group_left"] as const) {
      this.app.event(leftEvent, async ({ event, context }) => {
        if (!this.onBotLeftChannel) return;
        const channelId = (event as any).channel as string;
        const workspaceId = ((event as any).team as string | undefined) || context.teamId || null;
        try {
          this.onBotLeftChannel({ channelId, workspaceId });
        } catch (err) {
          logger.error(`[slack] placement disable on leave failed for ${channelId}: ${this.formatSlackError(err)}`);
        }
      });
    }

    // Bolt listeners must be registered before app.start().
    this.meetingTaskProposal?.register();
    this.meetingMinutesPipeline?.register();
    this.vibeproDecision?.register();
    this.vibeproGateResult?.register();

    await this.app.start();
    this.started = true;
    this.lastError = null;
    logger.info("Slack connector started (socket mode)");
    this.agentsCanvas?.start();
    for (const taskCanvas of this.taskCanvases) taskCanvas.start();
    this.taskReminder?.start();
  }

  async stop() {
    this.stopping = true;
    if (this.mode === "outbound-only") {
      this.invalidateSettingsTopologyProbe();
      this.started = false;
      this.lastError = null;
      this.workspaceId = null;
      this.workspaceName = null;
      this.botUserId = null;
      this.stopping = false;
      logger.info(`[slack] outbound-only connector stopped connector=${this.instanceId}`);
      return;
    }
    this.agentsCanvas?.stop();
    for (const taskCanvas of this.taskCanvases) taskCanvas.stop();
    this.taskReminder?.stop();
    this.meetingTaskProposal?.stop();
    this.meetingMinutesPipeline?.stop();
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    try {
      await this.app.stop();
    } finally {
      this.started = false;
      this.stopping = false;
    }
    logger.info("Slack connector stopped");
  }

  /**
   * Narrow cross-workspace delivery port. It revalidates the connector's live
   * Slack identity and channel membership on every approved share and never
   * falls back to another connector/token.
   */
  async postSharedMeetingMinutes(
    request: MeetingMinutesShareRequest,
  ): Promise<{ parentTs: string }> {
    if (!this.started) throw new Error(`target connector ${this.instanceId} is not running`);
    if (request.destination.connectorInstanceId !== this.instanceId) {
      throw new Error("target connector identity mismatch");
    }
    if (this.mode === "outbound-only") {
      if (request.destination.workspaceId !== this.configuredWorkspaceId) {
        throw new Error("target workspace identity mismatch");
      }
      if (!this.outboundChannelAllowlist.has(request.destination.channelId)) {
        throw new Error("target channel is not allowlisted");
      }
    }
    const client = this.app.client as unknown as {
      apiCall(method: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const auth = await client.apiCall("auth.test", {});
    if (auth.ok !== true) {
      throw new Error("target workspace identity could not be verified");
    }
    const actualWorkspaceId = auth.team_id;
    if (
      typeof actualWorkspaceId !== "string" ||
      actualWorkspaceId !== request.destination.workspaceId
    ) {
      throw new Error("target workspace identity mismatch");
    }
    const info = await client.apiCall("conversations.info", {
      channel: request.destination.channelId,
    });
    const channel = info.channel as Record<string, unknown> | undefined;
    if (
      !channel ||
      channel.id !== request.destination.channelId ||
      channel.is_archived === true ||
      channel.is_member !== true
    ) {
      throw new Error("target channel is unavailable, archived, or bot is not a member");
    }
    const parent = await client.apiCall("chat.postMessage", {
      channel: request.destination.channelId,
      text: fitSlackOverview(request.minutes.overview),
      unfurl_links: false,
    });
    const parentTs = parent.ts;
    if (typeof parentTs !== "string" || !parentTs) {
      throw new Error("target parent post returned no timestamp");
    }
    const threadTs: string[] = [];
    request.onProgress({ parentTs, threadTs });
    for (const chunk of splitForSlack(request.minutes.body)) {
      const child = await client.apiCall("chat.postMessage", {
        channel: request.destination.channelId,
        thread_ts: parentTs,
        text: chunk,
        unfurl_links: false,
      });
      if (typeof child.ts !== "string" || !child.ts) {
        throw new Error("target thread post returned no timestamp");
      }
      threadTs.push(child.ts);
      request.onProgress({ parentTs, threadTs });
    }
    return { parentTs };
  }

  /** Dedicated cross-workspace update port. Revalidates identity and membership on every call. */
  async updateSharedMeetingMinutes(
    request: MeetingMinutesUpdateRequest,
  ): Promise<{ parentTs: string; threadTs: string[] }> {
    if (!this.started) throw new Error(`target connector ${this.instanceId} is not running`);
    if (request.destination.connectorInstanceId !== this.instanceId) throw new Error("target connector identity mismatch");
    if (this.mode === "outbound-only") {
      if (request.destination.workspaceId !== this.configuredWorkspaceId) throw new Error("target workspace identity mismatch");
      if (!this.outboundChannelAllowlist.has(request.destination.channelId)) throw new Error("target channel is not allowlisted");
    }
    const client = this.app.client as unknown as {
      apiCall(method: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const auth = await client.apiCall("auth.test", {});
    if (auth.ok !== true || auth.team_id !== request.destination.workspaceId) {
      throw new Error("target workspace identity mismatch");
    }
    const info = await client.apiCall("conversations.info", { channel: request.destination.channelId });
    const channel = info.channel as Record<string, unknown> | undefined;
    if (!channel || channel.id !== request.destination.channelId || channel.is_archived === true || channel.is_member !== true) {
      throw new Error("target channel is unavailable, archived, or bot is not a member");
    }
    const desired = splitForSlack(request.minutes.body, 900);
    const threadTs = [...request.existing.threadTs];
    for (let i = 0; i < desired.length; i++) {
      if (threadTs[i]) {
        await client.apiCall("chat.update", {
          channel: request.destination.channelId, ts: threadTs[i], text: desired[i], blocks: [],
        });
      } else {
        const child = await client.apiCall("chat.postMessage", {
          channel: request.destination.channelId,
          thread_ts: request.existing.parentTs,
          text: desired[i],
          unfurl_links: false,
        });
        if (typeof child.ts !== "string" || !child.ts) throw new Error("target thread post returned no timestamp");
        threadTs.push(child.ts);
      }
      request.onProgress({ parentTs: request.existing.parentTs, threadTs });
    }
    for (let i = desired.length; i < threadTs.length; i++) {
      await client.apiCall("chat.update", {
        channel: request.destination.channelId, ts: threadTs[i], text: "（更新により置換済み）", blocks: [],
      });
      request.onProgress({ parentTs: request.existing.parentTs, threadTs });
    }
    await client.apiCall("chat.update", {
      channel: request.destination.channelId,
      ts: request.existing.parentTs,
      text: fitSlackOverview(request.minutes.overview),
      blocks: [],
    });
    return { parentTs: request.existing.parentTs, threadTs };
  }

  invalidateSettingsTopologyProbe(): void {
    this.topologyProbeGeneration += 1;
    this.topologyChannels = {};
    this.topologyCheckedAt = null;
  }

  /**
   * Refresh the bounded, redacted channel snapshot outside HTTP request paths.
   * A failed refresh replaces the prior success for that channel so stale
   * health can never masquerade as current verification.
   */
  async refreshSettingsTopologyProbe(
    targets: Array<{ channelId: string; workspaceId?: string }>,
    requireExactChannelId = false,
  ): Promise<void> {
    this.topologyProbeTargets = targets.map((target) => ({ ...target }));
    const generation = ++this.topologyProbeGeneration;
    const next: Record<string, SlackChannelProbeSnapshot> = {};
    for (const target of targets) {
      const checkedAt = new Date().toISOString();
      if (target.workspaceId && !this.workspaceId) {
        next[target.channelId] = { channelId: target.channelId, checkedAt, status: "unconfirmed", code: "workspace_identity_unavailable" };
        continue;
      }
      if (target.workspaceId && this.workspaceId && target.workspaceId !== this.workspaceId) {
        next[target.channelId] = { channelId: target.channelId, checkedAt, status: "error", code: "workspace_mismatch" };
        continue;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          this.app.client.conversations.info({ channel: target.channelId }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("slack topology probe timed out")), 5_000);
            timeout.unref?.();
          }),
        ]);
        const channel = response.channel as any;
        if (
          !channel ||
          (requireExactChannelId
            ? channel.id !== target.channelId
            : typeof channel.id === "string" && channel.id !== target.channelId)
        ) {
          next[target.channelId] = { channelId: target.channelId, checkedAt, status: "error", code: "channel_not_found" };
        } else if (channel.is_archived === true) {
          next[target.channelId] = { channelId: target.channelId, name: channel.name, checkedAt, status: "error", code: "channel_archived" };
        } else if (channel.is_member !== true) {
          next[target.channelId] = { channelId: target.channelId, name: channel.name, checkedAt, status: "error", code: "bot_not_member" };
        } else {
          next[target.channelId] = { channelId: target.channelId, name: channel.name, checkedAt, status: "verified", code: "channel_ready_by_static_checks" };
        }
      } catch (err) {
        const code = (err as any)?.data?.error;
        const classified = code === "missing_scope" || code === "not_allowed_token_type"
          ? "permission_denied"
          : code === "channel_not_found" || code === "invalid_channel"
            ? "channel_not_found"
            : "slack_probe_failed";
        next[target.channelId] = {
          channelId: target.channelId,
          checkedAt,
          status: classified === "slack_probe_failed" ? "unconfirmed" : "error",
          code: classified,
        };
        logger.warn(`[slack] topology probe ${classified} for connector=${this.instanceId}`);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    if (generation === this.topologyProbeGeneration) {
      this.topologyChannels = next;
      this.topologyCheckedAt = new Date().toISOString();
    }
  }

  getSettingsTopologySnapshot(): SlackRuntimeSnapshot {
    return {
      instanceId: this.instanceId,
      health: this.lastError ? "degraded" : this.started ? "healthy" : "stopped",
      ...(this.lastError ? { healthCode: "slack_runtime_unavailable" as const } : {}),
      ...(this.healthObservedAt ? { healthObservedAt: this.healthObservedAt } : {}),
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      ...(this.workspaceName ? { workspaceName: this.workspaceName } : {}),
      ...(this.topologyCheckedAt ? { checkedAt: this.topologyCheckedAt } : {}),
      channels: { ...this.topologyChannels },
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.lastError ? "error" : this.started ? "running" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.capabilities,
    };
  }

  /**
   * Enumerate channels the bot is a member of. Used by the settings UI to
   * populate the Agents View canvas channel picker.
   *
   * Public channels and private groups the bot has been invited to are both
   * included; DMs/MPIMs are filtered out (canvases live in channels, not
   * direct messages).
   */
  async listChannels(): Promise<Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>> {
    const out: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }> = [];
    let cursor: string | undefined;
    // Bound the loop so a misbehaving workspace can't make us iterate forever.
    for (let page = 0; page < 20; page++) {
      const res = await this.app.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const channels = (res.channels ?? []) as unknown as Array<Record<string, unknown>>;
      for (const c of channels) {
        const id = typeof c.id === "string" ? c.id : undefined;
        const name = typeof c.name === "string" ? c.name : undefined;
        if (!id || !name) continue;
        // bot must be a member to post a canvas in the channel
        if (c.is_member !== true) continue;
        out.push({
          id,
          name,
          isPrivate: c.is_private === true,
          isMember: true,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    return {
      channel: typeof replyContext.channel === "string" ? replyContext.channel : "",
      thread: typeof replyContext.thread === "string" ? replyContext.thread : undefined,
      messageTs: typeof replyContext.messageTs === "string" ? replyContext.messageTs : undefined,
      replyContext,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        text: chunk,
      });
      lastTs = res.ts;
    }
    // A newly-posted root message will be the thread_ts for any follow-up replies,
    // so mark its future thread as bot-engaged. Only relevant when tracking is on.
    if (lastTs && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, lastTs);
    }
    return lastTs;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const threadTs = target.thread || target.messageTs;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        thread_ts: threadTs,
        text: chunk,
      });
      lastTs = res.ts;
    }
    // Record the thread the bot just replied in. Subsequent user replies in
    // this same thread will carry thread_ts === threadTs and bypass triage
    // and the respondTo mention gate. Only relevant when tracking is on.
    if (threadTs && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, threadTs);
    }
    return lastTs;
  }

  /**
   * Posts a `/vibepro needs_decision` question card (Block Kit + a button
   * that opens an answer modal). Falls back to plain text when the
   * development runner isn't enabled for this connector instance.
   */
  async postDecisionQuestions(
    target: Target,
    payload: { storyId: string; questions: DevelopmentQuestion[]; summary: string },
  ): Promise<void> {
    if (!this.vibeproDecision) {
      await this.replyMessage(
        target,
        `Development: needs_decision\nStory: ${payload.storyId}\n質問${payload.questions.length}件\n${payload.summary}`,
      );
      return;
    }
    await this.vibeproDecision.postQuestions(target, payload.storyId, payload.questions, payload.summary);
  }

  /**
   * Posts a `/vibepro needs_input` "成果報告＋次の一手" card (Block Kit with
   * a continue/details button pair) when VibePro gates remain unresolved.
   * Falls back to a short Japanese plain-text notice when the development
   * runner isn't enabled for this connector instance, or when the result
   * carries no gates (e.g. an agent error before `pr ship --dry-run` ran).
   */
  async postDevelopmentNeedsInput(
    target: Target,
    payload: { storyId: string; summary: string; gates?: DevelopmentGate[]; commits?: DevelopmentCommits },
  ): Promise<void> {
    if (!this.vibeproGateResult || !payload.gates || payload.gates.length === 0) {
      await this.replyMessage(target, `⚠ 開発が中断しました: ${payload.summary}`);
      return;
    }
    await this.vibeproGateResult.postResult(target, payload.storyId, payload.gates, payload.commits);
  }

  async addReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.add({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to add reaction: ${err}`);
    }
    // A reaction on a message also counts as engagement; mark the target's
    // thread anchor so follow-ups in that thread are treated as bot-engaged.
    // Only relevant when tracking is on.
    const anchor = target.thread || target.messageTs;
    if (anchor && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, anchor);
    }
  }

  async removeReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.remove({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to remove reaction: ${err}`);
    }
  }

  async editMessage(target: Target, text: string) {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    await this.app.client.chat.update({
      channel: target.channel,
      ts: target.messageTs,
      text,
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.handler = handler;
  }
}
