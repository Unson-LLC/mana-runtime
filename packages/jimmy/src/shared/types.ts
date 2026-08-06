export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  /** Set when this delta belongs to a Task sub-agent (interactive PTY engine).
   *  The chat pane routes tagged deltas into a collapsible sub-agent card instead
   *  of the main transcript. Absent for main-agent deltas. */
  subAgent?: { id: string; label?: string };
}

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface InterruptibleEngine extends Engine {
  /** Kill a running engine process for a specific Jinn session. */
  kill(sessionId: string, reason?: string): void;
  /** Check if a live engine process is still running for this session. */
  isAlive(sessionId: string): boolean;
  /** Kill all live engine processes during gateway shutdown. */
  killAll(): void;
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  /** Restrict Claude Code to the per-session --mcp-config file. */
  strictMcpConfig?: boolean;
  /** Enable the separate Claude-in-Chrome integration (legacy default: true). */
  enableChrome?: boolean;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /**
   * Permission deny rules passed as --disallowedTools (e.g. "Write(//abs/path/**)").
   * Claude Code enforces deny rules in every permission mode, including
   * bypassPermissions — this is the hard boundary for Placement-protected paths.
   */
  disallowedTools?: string[];
  /**
   * Per-spawn tool allow rules passed as --allowedTools, derived from the
   * placement's capabilities (placementEngineBoundary). When set — always for a
   * placement session, even as an empty list — it REPLACES the engine's global
   * interactiveAllowedTools for that spawn, so a placement never inherits the
   * global list. Undefined (non-placement) keeps the global list in charge.
   * Deny rules always win over these (Claude Code evaluates deny → ask → allow).
   */
  allowedTools?: string[];
  /**
   * Register the placement Bash write guard (assets/placement-guard.mjs) as a
   * PreToolUse hook via --settings. Complements `disallowedTools`, which cannot
   * inspect paths inside shell commands: Bash deny rules are prefix-matched on
   * the command string only. The hook's permissionDecision:"deny" is enforced
   * by Claude Code in every permission mode, including bypassPermissions.
   */
  placementBashGuard?: boolean;
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
  /**
   * Keep a local interactive PTY warm after the turn completes.
   * Web UI root sessions opt in; connector, cron, and delegated sessions opt out
   * so completed autonomous work does not retain a Claude process.
   */
  keepWarmPty?: boolean;
  /** If set, run the engine binary on a remote host via SSH instead of locally. */
  sshHost?: string;
  /** Working directory on the remote host (only used when sshHost is set). */
  remoteCwd?: string;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  /**
   * Most recent turn's INPUT context size (input + cache-read + cache-creation
   * tokens) — i.e. how full the context window currently is. Undefined when the
   * engine doesn't surface usage. Powers the context meter in the UI.
   */
  contextTokens?: number;
  error?: string;
  /**
   * Optional rate limit metadata returned by an engine.
   * `resetsAt` is a Unix timestamp in seconds.
   */
  rateLimit?: EngineRateLimitInfo;
  /**
   * For sessions that span multiple assistant turns (e.g. when `/goal` keeps
   * Claude working until a completion condition holds), each turn's final
   * text in chronological order. `result` remains the LAST turn's text for
   * backward compatibility; callers that want to surface progress should
   * iterate `turns` instead.
   */
  turns?: string[];
}

export interface EngineRateLimitInfo {
  status?: string;
  /** Unix timestamp in seconds */
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ConnectorCapabilities {
  threading: boolean;
  messageEdits: boolean;
  reactions: boolean;
  attachments: boolean;
}

export interface ConnectorHealth {
  status: "running" | "stopped" | "error" | "qr_pending";
  detail?: string;
  capabilities: ConnectorCapabilities;
}

export type ReplyContext = JsonObject;

/** One selectable option for a VibePro human-in-the-loop question. */
export interface DevelopmentQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/**
 * One question the isolated VibePro development runner asked because a
 * Slack `/vibepro` request was too ambiguous to implement safely. Rendered
 * as a Slack Block Kit card + modal by the Slack connector; other connectors
 * may ignore `postDecisionQuestions` and fall back to plain text.
 */
export interface DevelopmentQuestion {
  id: string;
  question: string;
  options: DevelopmentQuestionOption[];
  allow_free_text: boolean;
}

/** One human answer to a previously-asked DevelopmentQuestion. */
export interface DevelopmentAnswer {
  id: string;
  answer: string;
}

/**
 * One unresolved VibePro gate reported by `vibepro pr ship --dry-run` when a
 * `/vibepro` Story stops with `needs_input`. `critical` maps to a
 * `critical_gate` line, `evidence` to a `waiver_or_evidence` line.
 */
export interface DevelopmentGate {
  severity: "critical" | "evidence";
  text: string;
}

/**
 * Commits made in the isolated Story worktree since the run's baseline HEAD,
 * reported alongside `needs_input`/`pr_ready` results so Slack can show
 * "here is what was actually done" instead of a bare status. `subjects` is
 * newest-first and bounded to a handful of entries.
 */
export interface DevelopmentCommits {
  count: number;
  subjects: string[];
}

/**
 * One progress snapshot the isolated VibePro development runner reports
 * while a `/vibepro` request is in flight, parsed from a `PROGRESS <json>`
 * line on the runner's stderr. Used to refresh the Slack "typing" status
 * with real progress instead of a static "開発中…" string.
 */
export interface DevelopmentProgress {
  phase: "agent" | "gate";
  elapsedSec: number;
  commits: number;
  latest?: string;
}

export interface Connector {
  name: string;
  /**
   * The registry key this specific connector instance is registered under in
   * the gateway's connector map (see gateway/server.ts's `connectorMap`).
   * Distinct from `name` when multiple instances share one connector type —
   * every SlackConnector reports `name: "slack"` regardless of which Slack
   * workspace it's bound to, so two instances (e.g. the default workspace and
   * a named `connectors.instances[]` entry like "slack-biz") are otherwise
   * indistinguishable. Consumers that need to resolve back to the exact
   * running instance (e.g. development-reconciler.ts delivering a result to
   * the workspace the request actually came from) must key off `instanceId`,
   * not `name`. Optional and may equal `name` for connectors that don't
   * support named instances.
   */
  instanceId?: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getCapabilities(): ConnectorCapabilities;
  getHealth(): ConnectorHealth;
  reconstructTarget(replyContext: ReplyContext): Target;
  sendMessage(target: Target, text: string): Promise<string | void>;
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  setTypingStatus?(channelId: string, threadTs: string | undefined, status: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Return the bound employee name, if any */
  getEmployee?(): string | undefined;
  /**
   * Post a rich human-in-the-loop question card for a `/vibepro needs_decision`
   * result (e.g. Slack Block Kit + a modal to collect answers). Connectors
   * that don't implement this leave it undefined; callers must fall back to
   * a plain-text `replyMessage` in that case.
   */
  postDecisionQuestions?(
    target: Target,
    payload: { storyId: string; questions: DevelopmentQuestion[]; summary: string },
  ): Promise<void>;
  /**
   * Posts a "成果報告＋次の一手" card for a `/vibepro needs_input` result
   * whose VibePro gates are not yet resolved (e.g. a Slack Block Kit card
   * with resume/detail buttons). Connectors that don't implement this leave
   * it undefined; callers must fall back to a plain-text `replyMessage`.
   */
  postDevelopmentNeedsInput?(
    target: Target,
    payload: { storyId: string; summary: string; gates?: DevelopmentGate[]; commits?: DevelopmentCommits },
  ): Promise<void>;
}

export interface IncomingMessage {
  connector: string;
  source: string;
  sessionKey: string;
  replyContext: ReplyContext;
  messageId?: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
  transportMeta?: JsonObject;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  localPath?: string;
}

export interface Target {
  channel: string;
  thread?: string;
  messageTs?: string;
  replyContext?: ReplyContext;
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: ReplyContext | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  effortLevel: string | null;
  totalCost: number;
  totalTurns: number;
  /** Most recent turn's input context size (context-meter). Null when unknown. */
  lastContextTokens: number | null;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'at_risk' | 'completed';
  level: 'company' | 'department' | 'task';
  parentId: string | null;
  department: string | null;
  owner: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: CronDelivery;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Whether to notify the parent session when this employee's child session completes. Default: true */
  alwaysNotify?: boolean;
  /** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
  reportsTo?: string | string[];
  /** Services this employee provides to the org */
  provides?: ServiceDeclaration[];
  /** If set, run this employee's engine on a remote host via SSH. */
  sshHost?: string;
  /** Working directory on the remote host (only used together with sshHost). */
  remoteCwd?: string;
}

/** A service that an employee can provide to other employees/departments. */
export interface ServiceDeclaration {
  name: string;
  description: string;
}

/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["pravko-lead", "pravko-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}

/** Stdio-based MCP server (spawned as child process) */
export interface McpServerStdioConfig {
  /** Shell command to start the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

/** HTTP/SSE-based MCP server (remote URL) */
export interface McpServerUrlConfig {
  /** Transport type — Claude Code requires "sse" for URL-based servers */
  type?: "sse";
  /** URL of the MCP server (HTTP streamable or SSE transport) */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/** MCP server config — either stdio (command) or URL-based */
export type McpServerConfig = McpServerStdioConfig | McpServerUrlConfig;

export interface McpGlobalConfig {
  browser?: {
    enabled: boolean;
    provider?: "playwright" | "puppeteer";
  };
  search?: {
    enabled: boolean;
    provider?: "brave";
    apiKey?: string;
  };
  fetch?: {
    enabled: boolean;
  };
  gateway?: {
    enabled: boolean;
  };
  /** Custom MCP servers defined by the user */
  custom?: Record<string, (McpServerStdioConfig | McpServerUrlConfig) & { enabled?: boolean }>;
}

export interface WebConnectorConfig {}

export interface SlackTriageConfig {
  /** Enable the air-reading triage layer. Default: false (legacy behavior). */
  enabled?: boolean;
  /** CLI engine to invoke for triage. Default: "codex"; "claude" is supported. */
  engine?: "claude" | "codex";
  /** Binary to invoke for triage. Defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for triage calls. Defaults to claude-haiku-4-5 or gpt-5-nano. */
  model?: string;
  /** Soft timeout before falling back to "silent". Default: 30000ms. */
  timeoutMs?: number;
  /** How many recent thread messages to include as context. Default: 10. */
  threadContextLimit?: number;
  /** Optional persona override for the triage prompt. Defaults to the bot's configured persona. */
  persona?: string;
  /**
   * @deprecated No longer used. Conversation engagement is now tracked
   * permanently per-thread / per-(channel, user), invalidated only when a
   * third human joins. This field is accepted for backwards compatibility
   * with existing config files but has no effect.
   */
  activeThreadTtlMs?: number;
}

export interface SlackGoalExtractionConfig {
  /** Enable natural-language /goal injection. Default: false due to latency. */
  enabled?: boolean;
  /** CLI engine used for the extraction decision. Defaults to "codex". The injected /goal itself only works with Claude sessions. */
  engine?: "claude" | "codex";
  /** Binary to invoke. Defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for goal extraction. Defaults to claude-haiku-4-5 or gpt-5-nano. */
  model?: string;
  /** Hard timeout before skipping /goal injection. Default: 30000ms. */
  timeoutMs?: number;
}

/** Response mode for one Slack conversation scope. */
export type SlackRespondMode = "always" | "mention" | "never";

/**
 * Deterministic response gate, evaluated before the LLM triage layer.
 * Absent (or "always" in every scope) preserves the legacy respond-to-everything
 * behavior. "mention" scopes drop messages that don't @-mention the bot,
 * except inside threads the bot has already engaged (see `engagedThreads`).
 */
export interface SlackRespondToConfig {
  /** 1:1 DMs. Default: "always". */
  im?: SlackRespondMode;
  /** Group DMs (mpim). Default: "always". */
  mpim?: SlackRespondMode;
  /** Public and private channels. Default: "always". */
  channel?: SlackRespondMode;
  /**
   * In "mention" scopes, keep replying inside threads the bot has already
   * engaged (replied or reacted in) without requiring a re-mention on every
   * message. Default: true.
   */
  engagedThreads?: boolean;
}

export interface SlackConnectorConfig {
  /** Unique instance identifier (e.g. "slack-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  appToken: string;
  botToken: string;
  /**
   * For named instances only: env var names holding this instance's tokens.
   * Instances can't share the fixed OPENRYOKO_SLACK_* env vars (each Slack
   * workspace needs its own app install), and inline tokens would put
   * secrets in config.yaml — name per-instance env vars here instead.
   */
  appTokenEnv?: string;
  botTokenEnv?: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  /** Read-only Mana settings entry shown in Slack App Home and exact DM shortcuts. */
  settingsHome?: {
    /** Disabled by default. The settings entry also requires a non-empty allowFrom list. */
    enabled?: boolean;
    /** Fixed public HTTPS origin for the Mana Web UI (localhost is accepted for development). */
    webBaseUrl?: string;
  };
  /** Deterministic per-scope response gate (DM / group DM / channel). */
  respondTo?: SlackRespondToConfig;
  /** Air-reading triage: decide per-message whether to reply/react/stay silent */
  triage?: SlackTriageConfig;
  /** Natural-language autonomous goal detection. Off by default because it adds latency. */
  goalExtraction?: SlackGoalExtractionConfig;
  /** Deterministic gateway routing for high-risk work. Disabled when absent. */
  criticalRouting?: {
    enabled?: boolean;
    /** Employee YAML name. Its model and effort remain the org SSOT. */
    reviewerEmployee?: string;
  };
  /** Self-updating Slack Canvas mirroring OpenRyoko's current sessions (Agents View). */
  agentsCanvas?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /** Slack channel ID to host the canvas in. If unset, a standalone canvas is created. */
    channelId?: string;
    /** Canvas title. Default: "Ryoko Agents View". */
    title?: string;
    /** Refresh interval in ms (min 5000, default 30000). */
    pollIntervalMs?: number;
    /** Max sessions rendered per status group. Default 10. */
    maxPerGroup?: number;
  };
  /**
   * Self-updating Slack Canvas mirroring the canonical Brainbase task store
   * (read-only projection; requires BRAINBASE_TASK_API_BASE_URL / _TOKEN).
   */
  taskCanvas?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /** Slack channel ID to host the canvas in. If unset, a standalone canvas is created. */
    channelId?: string;
    /** Canvas title. Default: "タスクボード". */
    title?: string;
    /** Refresh interval in ms (min 30000, default 300000). */
    pollIntervalMs?: number;
    /** Max tasks rendered per status section. Default 50. */
    maxPerSection?: number;
  };
  /**
   * Due-date reminders sourced from the canonical Brainbase task store:
   * posts to a channel when an open task approaches or passes its due date
   * (requires BRAINBASE_TASK_API_BASE_URL / _TOKEN).
   */
  taskReminder?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /** Slack channel ID to post reminders into. Required. */
    channelId?: string;
    /** Polling interval in ms (min 60000, default 1800000). */
    checkIntervalMs?: number;
    /** Hours before due_at a task counts as "due soon". Default 24. */
    dueSoonHours?: number;
  };
  /**
   * Meeting minutes → task-candidate proposals with approve/reject buttons,
   * registering approved candidates into the canonical Brainbase task store
   * (requires BRAINBASE_TASK_API_BASE_URL / _TOKEN and Slack Interactivity).
   */
  meetingTaskProposal?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /** Channel IDs to watch for minutes. Required; empty keeps the feature off. */
    channels?: string[];
    /** User IDs allowed to approve/reject. Defaults to allowFrom. */
    approverUserIds?: string[];
    /** Minimum message length considered as minutes. Default 200. */
    minMessageChars?: number;
    /** Proposal lifetime in hours. Default 72. */
    ttlHours?: number;
    /** LLM extraction overrides. */
    engine?: "claude" | "codex";
    bin?: string;
    model?: string;
    timeoutMs?: number;
  };
  /**
   * Transcript (.txt) upload in a router channel → default routing → minutes
   * generation → expansion into the project channel → task-flow handoff
   * (docs/architecture/story-meeting-minutes-pipeline.md).
   */
  meetingMinutesPipeline?: {
    /** Master switch — defaults to false when the block is absent. */
    enabled?: boolean;
    /**
     * Router channel IDs to watch for .txt uploads. Required; empty = off.
     * Wildcards are forbidden; every router must be explicitly allowlisted.
     */
    routerChannels?: string[];
    /** Pre-post destinations. Legacy three-field entries remain source-local. */
    destinations?: {
      destinationId?: string;
      projectId: string;
      name: string;
      channelId: string;
      connectorInstanceId?: string;
      workspaceId?: string;
    }[];
    /** @deprecated Normalized into pre-post direct destinations for compatibility. */
    shareDestinations?: {
      shareId: string;
      projectId: string;
      name: string;
      connectorInstanceId: string;
      workspaceId: string;
      channelId: string;
    }[];
    /** User IDs allowed to reroute/retry. Defaults to allowFrom. */
    operatorUserIds?: string[];
    /** Max transcript file size in bytes. Default 1 MiB. */
    maxFileBytes?: number;
    /** Run context lifetime in days. Default 14. */
    ttlDays?: number;
    /** LLM overrides per stage. */
    routing?: { engine?: "claude" | "codex"; bin?: string; model?: string; timeoutMs?: number };
    generation?: { engine?: "claude" | "codex"; bin?: string; model?: string; timeoutMs?: number };
  };
}

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;       // Make optional — not needed in proxy mode
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** URL of the primary Jinn instance to proxy Discord I/O through (secondary/remote mode) */
  proxyVia?: string;
  /** Shared service credential for remote Discord proxy calls. Required when placements are configured. */
  proxyToken?: string;
}

export interface TelegramConnectorConfig {
  /** Unique instance identifier (e.g. "telegram-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken: string;
  allowFrom?: number[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface WhatsAppConnectorConfig {
  /** Unique instance identifier (e.g. "whatsapp-main") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface ConnectorInstance {
  /** Unique instance ID */
  id: string;
  /** Connector type */
  type: "discord" | "discord-remote" | "slack" | "whatsapp" | "telegram";
  /** Employee to bind to this connector */
  employee?: string;
  /** Type-specific configuration */
  [key: string]: unknown;
}

export interface PortalConfig {
  portalName?: string;
  operatorName?: string;
  /** Additional names/handles that identify the operator across chat platforms
   *  (e.g. ["泉水亮介", "Ryosuke Sensui", "rsensui"]). Checked alongside
   *  operatorName by the shared operator matcher — configure when the display
   *  nickname alone can't be matched to the operator's platform profile. */
  operatorAliases?: string[];
  language?: string;
  onboarded?: boolean;
}

// --- Model + capability registry ---
// Single source of truth for which engines/models exist and what they support.
// Shipping a NEW model is a config edit (`models:` block in config.yaml), zero
// code change. When the block is absent, the registry is synthesized from
// `engines.<name>.model` so existing configs keep working.

/** How an engine conveys reasoning-effort to its CLI. */
export type EffortMechanism = "claude-flag" | "codex-config" | "none";

/** A single model and its capabilities, as exposed to the UI / validation. */
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  /** Valid effort levels for THIS model (empty when supportsEffort is false). */
  effortLevels: string[];
  /** Context window size in tokens (for the UI context meter). Omit if unknown. */
  contextWindow?: number;
}

/** Resolved per-engine registry entry. */
export interface EngineRegistryEntry {
  name: string;
  /** Engine is registered/usable in this build. */
  available: boolean;
  /** Default model id for new sessions on this engine. */
  defaultModel: string;
  effortMechanism: EffortMechanism;
  models: ModelInfo[];
}

/** Resolved registry, keyed by engine name. */
export type ModelRegistry = Record<string, EngineRegistryEntry>;

// --- config.yaml `models:` block shapes (all fields optional/forgiving) ---

export interface ModelConfigEntry {
  id: string;
  label?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
  contextWindow?: number;
}

export interface EngineModelsConfig {
  /** Default model id; falls back to the first listed model. */
  default?: string;
  effortMechanism?: EffortMechanism;
  models: ModelConfigEntry[];
}

/** `models:` block keyed by engine name (claude | codex | gemini). */
export type ModelsConfig = Record<string, EngineModelsConfig>;

export interface DevelopmentRunnerConfig {
  /** Explicit opt-in. The command is never available when false or absent. */
  enabled?: boolean;
  /** Absolute executable path. Use a root-owned sudo wrapper in production. */
  bin: string;
  /** Fixed arguments. The Slack request is supplied only over stdin. */
  args?: string[];
  /** Maximum wall time for one request. Default: 90 minutes. */
  timeoutMs?: number;
  /** Slack channel IDs allowed to start development. Empty or absent fails closed. */
  allowedSlackChannels?: string[];
  /**
   * Absolute path to the isolated runner's result spool directory (must
   * match the runner-side root-owned config's `resultsSpoolDir`). When set,
   * the gateway reconciles pending runs against this directory at startup
   * and every 60s so an orphaned run (e.g. a gateway restart that killed
   * the runner's cgroup) still gets its result and Slack card delivered.
   * Absent disables the reconciler entirely (back-compat).
   */
  resultsSpoolDir?: string;
}

export interface PlacementDeliveryTarget {
  connector: string;
  channel: string;
}

/** Logical trust boundary for one connector/channel placement. */
export interface PlacementProfile {
  id: string;
  connector: string;
  workspaceId: string;
  channelId: string;
  /** Agent ledger: owner/sponsor (Slack user ID or name). Optional for backward compat. */
  owner?: string;
  /** Agent ledger: what this placement exists for. Optional for backward compat. */
  purpose?: string;
  /**
   * Agent ledger: placement kill switch. `false` fail-closes the channel at
   * resolve/delivery/derived-session boundaries. Absent means enabled.
   */
  enabled?: boolean;
  audience: {
    type: "operator" | "executive" | "project-team" | "client" | "channel-members";
    /**
     * Static allowlist for the legacy audience types. "channel-members"
     * delegates membership to the connector (Slack conversations.members) and
     * ignores this list; static types without a list fail closed (deny all).
     */
    allowedUsers?: string[];
  };
  agent?: {
    employee?: string;
    defaultModel?: string;
    escalationEmployee?: string;
  };
  /**
   * Agent ledger: monthly spend ceiling (USD) for this placement. When the
   * placement's month-to-date session cost reaches this limit, routing fails
   * closed (same effect as `enabled: false`). Absent means no placement cap.
   */
  monthlyBudgetUsd?: number;
  projects?: string[];
  capabilities?: {
    mcp?: false | string[];
    gatewayTools?: string[];
    allowedDelivery?: PlacementDeliveryTarget[];
  };
  /** Optional placement-specific checkout used as the session working directory. */
  workspace?: {
    /** Absolute, non-symlinked directory path on the gateway host. */
    path: string;
    /** Placement sessions may inspect the checkout but cannot mutate or execute it. */
    access: "read-only";
  };
  dataScopes?: Record<string, unknown>;
}

/**
 * Template overrides for invite-driven placement auto-provisioning
 * (config.yaml `placementDefaults`). The standard profile lives in code
 * (shared/placement-autoprovision.ts); each field here replaces the
 * corresponding standard value wholesale when set.
 */
export interface PlacementDefaultsConfig {
  /** Kill switch for invite-driven auto-provisioning. Absent means enabled (in placement mode). */
  autoProvision?: boolean;
  agent?: PlacementProfile["agent"];
  capabilities?: PlacementProfile["capabilities"];
  dataScopes?: Record<string, unknown>;
  monthlyBudgetUsd?: number;
}

export interface JinnConfig {
  jinn?: { version?: string };
  gateway: { port: number; host: string; streaming?: boolean };
  engines: {
    default: "claude" | "codex" | "gemini";
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      /** Opt-in: run Claude as an interactive PTY (cc_entrypoint=cli → Max-subscription
       *  billing) instead of headless `claude -p`. Replaces the engine under the "claude"
       *  key when true. Default false (headless `-p`). */
      interactive?: boolean;
      /** Claude Code permission mode for local interactive PTYs. Defaults to
       *  default, which honors settings allow/deny rules without requiring the
       *  unattended gateway to approve an ExitPlanMode prompt. */
      interactivePermissionMode?: "bypassPermissions" | "default" | "dontAsk" | "plan";
      /** Exact Claude Code tool permission rules that unattended local PTYs may
       *  use without prompting. Keep this narrowly scoped (for example, named
       *  read-only MCP tools); an empty/absent list grants nothing extra. */
      interactiveAllowedTools?: string[];
      /** Max simultaneously-live PTYs for the interactive engine (LRU-evicted). Default 8. */
      maxLivePtys?: number;
      /** Hard ceiling (ms) on a single interactive turn before it is force-settled
       *  as timed out. Guards against a hung-but-alive PTY zombying a session.
       *  Default 5400000 (90 min) — accommodates long autonomous batch runs that
       *  legitimately occupy one turn (e.g. the seminar-demo generator). */
      interactiveTurnTimeoutMs?: number;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
    gemini?: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
  };
  /** Optional model/capability registry override. Absent → synthesized from
   *  `engines.<name>.model`. See shared/models.ts. */
  models?: ModelsConfig;
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    telegram?: TelegramConnectorConfig;
    discord?: DiscordConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    /** Named connector instances — allows multiple connectors of the same type */
    instances?: ConnectorInstance[];
  };
  logging: { file: boolean; stdout: boolean; level: string };
  /** Optional isolated development runner used by the /develop command. */
  developmentRunner?: DevelopmentRunnerConfig;
  /** Connector/channel-specific policy. When present, unmatched input fails closed. */
  placements?: PlacementProfile[];
  /** Invite-driven auto-provisioning template overrides. See PlacementDefaultsConfig. */
  placementDefaults?: PlacementDefaultsConfig;
  mcp?: McpGlobalConfig;
  sessions?: {
    maxDurationMinutes?: number;
    maxCostUsd?: number;
    interruptOnNewMessage?: boolean;
    /** What to do when Claude hits a usage/rate limit. Default: "fallback" */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
    /** Backoff delays (ms) between automatic retries after a transient Anthropic
     *  server error (5xx/529) ended a turn. One retry per entry, resuming the
     *  same engine session with a continuation prompt. Default: [30s, 120s, 300s].
     *  Set to [] to disable. */
    transientRetryDelaysMs?: number[];
    /** Deliver late/background engine output (a Stop hook that fires after the
     *  turn already settled — e.g. a background sub-agent finishing) back to the
     *  session's conversation. Default: true. */
    backgroundDelivery?: boolean;
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
  };
  notifications?: {
    connector?: string;  // defaults to "discord"
    channel?: string;    // Discord channel ID for admin notifications
  };
  portal?: PortalConfig;
  context?: {
    /** Max characters for the built system prompt. Defaults to 100000. */
    maxChars?: number;
  };
  stt?: {
    enabled?: boolean;
    model?: string;
    /** @deprecated Use `languages` instead. Kept for backwards compat. */
    language?: string;
    languages?: string[];
  };
  remotes?: Record<string, { url: string; label?: string }>;
}
