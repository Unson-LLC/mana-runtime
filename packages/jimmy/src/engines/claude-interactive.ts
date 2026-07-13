import fs from "node:fs";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, EngineRateLimitInfo, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { awaitFreshClaudeCredentials } from "../shared/claude-oauth-gate.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts } from "./pty-view-engine.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
import { SsePtyProxy, type SseDataEvent, type StreamCtx } from "./sse-pty-proxy.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";

export type { PtyControlEvent } from "./pty-view-engine.js";

interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
}

interface TranscriptUsage { inputTokens: number; outputTokens: number; cacheTokens: number; assistantTurns: number; }

// $/million tokens. Conservative defaults.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

function sumTranscriptUsage(content: string): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0 };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

/** Most recent turn's input-context size (input + cache-read + cache-creation
 *  tokens) from the transcript — how full the window is. Undefined if no usage. */
function lastTurnContextTokens(transcriptPath: string): number | undefined {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: number | undefined;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const u = msg?.message?.usage;
    if (!u) continue;
    last = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  }
  return last && last > 0 ? last : undefined;
}

function computeInteractiveCost(transcriptPath: string, model?: string): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content);
  if (u.assistantTurns === 0) return null;
  const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
  const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
  return { cost, turns: u.assistantTurns };
}

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed — left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  return { status: "rejected", rateLimitType: "interactive_detected" };
}

function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += "\n\nAttached files:\n" + o.attachments.map((a) => `- ${a}`).join("\n");
  }
  args.push(prompt); // positional — MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "AskUserQuestion", "ExitPlanMode");
  args.push("--settings", o.settingsPath);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}

/**
 * Translate one parsed Anthropic SSE `data:` event into StreamDeltas. This is the
 * live streaming source (replacing the old transcript tailer): word-by-word text
 * in true order, tool markers positioned correctly relative to text, and live
 * context tokens from message_start.usage.
 *  - message_start.usage         → `context` (input + cache_read + cache_creation)
 *  - content_block_start tool_use → `tool_use` marker (in-order with text)
 *  - content_block_delta text_delta → incremental `text` (word-by-word)
 * tool_result is NOT in the assistant SSE stream (tools run between messages); the
 * PostToolUse hook supplies that completion marker. input_json_delta / thinking
 * deltas are intentionally not surfaced to the chat pane.
 */
export function sseEventToDeltas(e: SseDataEvent): StreamDelta[] {
  switch (e.type) {
    case "message_start": {
      const u = (e as any).message?.usage;
      if (!u) return [];
      const ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      return ctx > 0 ? [{ type: "context", content: String(ctx) }] : [];
    }
    case "content_block_start": {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use") {
        return [{ type: "tool_use", content: String(cb.name ?? "tool"), toolName: String(cb.name ?? "tool"), toolId: String(cb.id ?? "") }];
      }
      return [];
    }
    case "content_block_delta": {
      const d = (e as any).delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        return [{ type: "text", content: d.text }];
      }
      return [];
    }
    default:
      return [];
  }
}

export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn (rate_limit, billing_error, …). Settle immediately
      // with an error — do NOT wait for SessionStart (an early failure may never
      // produce one). numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.settle({
        sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
        result: "",
        error: `Interactive turn failed: ${h.error ?? "unknown"}`,
        numTurns: 1,
      });
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    const text = String(this.stopPayload.last_assistant_message ?? "");
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(r);
  }
}

/** Cap for the per-session PTY scrollback ring buffer (xterm.js reconnect replay). */
const SCROLLBACK_CAP_BYTES = 262144;

/** Bracketed-paste `text` into a PTY then submit with CR after a 50ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. neutralizeForPaste() prepends a space for mentions,
 *  bash-mode, and jinn-skill slash commands, while letting engine-native commands
 *  (/compact, /clear, /model, …) pass through raw so the TUI actually runs them.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input). */
function pasteAndSubmit(proc: pty.IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  setTimeout(() => proc.write("\r"), 50);
}

export class InteractiveClaudeEngine implements InterruptibleEngine, PtyViewEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. `boundProc` is the specific
   *  PTY serving this turn (captured at spawn / warm-reuse). A PTY's onExit only
   *  interrupts the active resolver when it IS that bound proc — so a stale PTY
   *  released by a kill->respawn race can't poison the freshly-started turn.
   *  `onStream` is the current turn's delta callback; the per-PTY SSE proxy routes
   *  parsed events here (a PTY outlives its turn, so the proxy looks this up live). */
  private active = new Map<string, { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: pty.IPty }>();
  /** Sessions with an in-flight async idle-spawn (proxy.start awaited) — prevents
   *  a second ensureIdleSpawn from racing in a duplicate PTY during that gap. */
  private idleSpawning = new Set<string>();
  /** Per-session PTY output streams: scrollback ring buffer (chunk list + running byte total)
   *  + live subscribers. Survives PTY respawn. The chunk-list ring avoids the O(N) realloc
   *  that a `(buffer + d).slice(-CAP)` per data event would cause at hot output. */
  private streams = new Map<string, {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    /** Set to true the first time a PTY is wired to this stream entry. Subsequent
     *  wires (subscribers attached or not) are PTY respawns — clients need a reset
     *  so their xterm doesn't render the new alt-screen atop the old one's cells. */
    hasSeenPty: boolean;
  }>();
  /** Last terminal geometry reported by the client per session. Used to spawn
   *  follow-up PTYs at the correct dimensions when a turn comes in after the
   *  warm PTY was reaped — otherwise spawn() falls back to 120×40 and the TUI
   *  text body is locked in at the wrong width. */
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  /** Model/effort the live PTY was spawned with, per session. `--model`/`--effort`
   *  apply only at spawn, so a mid-chat switch must cold-respawn rather than reuse
   *  the warm PTY (which would keep running the old model). */
  private spawnParams = new Map<string, { model?: string; effortLevel?: string }>();

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    /** Headless `claude -p` engine used as a fallback for remote (sshHost) turns.
     *  A PTY runs Claude locally for the Max subsidy, so it cannot drive a remote
     *  engine over SSH; OpenRyoko's sshHost employees delegate to `-p` instead. */
    private remoteFallback?: InterruptibleEngine,
    /** Hard ceiling on a single turn. The Stop-hook resolution loop has no inherent
     *  timeout, and the proc-exit watchdog only catches a DEAD pty — a pty that hangs
     *  while still alive (e.g. a wedged upstream request, a boot-time race) would
     *  never resolve and would zombie the session as status:"running" forever. This
     *  deadline force-settles such a turn with an error so manager.ts runs its normal
     *  completion/recovery path. Default 15 min. */
    private turnTimeoutMs = 15 * 60 * 1000,
  ) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    // Remote (SSH) execution can't use a local PTY — delegate to headless `claude -p`,
    // which OpenRyoko runs over SSH. Falls through to local PTY when no fallback wired.
    if (opts.sshHost && this.remoteFallback) {
      return this.remoteFallback.run(opts);
    }
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      appendSystemPrompt: opts.systemPrompt,
    });

    let warm = this.lifecycle.getWarm(jinnSessionId);
    // Mid-chat model/effort switch: `--model`/`--effort` bind at spawn, so a warm
    // PTY would silently keep the OLD model. If the request differs from what this
    // PTY was spawned with, drop the warm PTY and cold-respawn (--resume keeps the
    // conversation) so the new model/effort actually takes effect.
    if (warm) {
      const prev = this.spawnParams.get(jinnSessionId);
      const norm = (v?: string) => (!v || v === "default" ? "" : v);
      if (prev && (norm(opts.model) !== norm(prev.model) || norm(opts.effortLevel) !== norm(prev.effortLevel))) {
        logger.info(`InteractiveClaudeEngine: model/effort changed for ${jinnSessionId} (model ${prev.model ?? "default"}→${opts.model ?? "default"}, effort ${prev.effortLevel ?? "default"}→${opts.effortLevel ?? "default"}) — cold respawn`);
        this.lifecycle.releaseSession(jinnSessionId);
        warm = undefined;
      }
    }
    const resolver = new TurnResolver({
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
    });
    const entry: { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: pty.IPty } = { resolver, onStream: opts.onStream };
    this.active.set(jinnSessionId, entry);

    // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
    this.hookRegistry.register(jinnSessionId, (h) => {
      resolver.onHook(h);
      // tool_use markers + intermediate text now stream from the per-PTY SSE proxy
      // (content_block_start / content_block_delta) in true order. The hook only
      // supplies tool_result — the assistant SSE stream has no tool_result event
      // (tools execute locally between assistant messages).
      if (h.hook_event_name === "PostToolUse" && opts.onStream) {
        opts.onStream({
          type: "tool_result",
          content: String(h.tool_name ?? ""),
          toolName: typeof h.tool_name === "string" ? h.tool_name : undefined,
        });
      }
    });

    if (warm) {
      // Mark the turn started BEFORE injecting so the sweep timer can't
      // theoretically release the PTY mid-paste if its grace window expired
      // between getWarm() above and the proc.write() inside injectPrompt.
      this.lifecycle.turnStarted(jinnSessionId);
      this.injectPrompt(warm, opts);
      entry.boundProc = (warm as any)._proc as pty.IPty | undefined;
    } else {
      const handle = await this.spawn(jinnSessionId, opts, settingsPath);
      this.lifecycle.adopt(jinnSessionId, handle);
      this.lifecycle.turnStarted(jinnSessionId);
      entry.boundProc = (handle as any)._proc as pty.IPty | undefined;
    }

    // Watchdog: if the bound PTY dies without the resolver settling (e.g. the
    // onExit identity-guard didn't match in a kill→respawn race), the turn would
    // hang forever — runWebSession's 5s heartbeat would zombie status:"running"
    // and the completion (session:completed + notifyParentSession parent callback)
    // would never fire. Both the stuck "in progress" badge and lost child-session
    // callbacks trace to this. Force-settle once the proc is provably dead so
    // run() always resolves and the normal completion path runs.
    const turnStartedAt = Date.now();
    const watchdog = setInterval(() => {
      const p = entry.boundProc as { _exitCode?: number | null } | undefined;
      if (p && p._exitCode != null) {
        resolver.interrupt("Interrupted: claude process exited");
        return;
      }
      // Turn-level deadline: a pty that hangs while still alive (no Stop hook, no
      // exit) would otherwise never resolve. Force-settle and release the pty so the
      // session can't zombie as status:"running".
      if (Date.now() - turnStartedAt > this.turnTimeoutMs) {
        logger.warn(`InteractiveClaudeEngine: turn for ${jinnSessionId} exceeded ${Math.round(this.turnTimeoutMs / 1000)}s — force-settling as timed out`);
        resolver.interrupt("Interrupted: interactive turn timed out");
        this.lifecycle.releaseSession(jinnSessionId);
      }
    }, 5000);
    watchdog.unref?.();

    let result: EngineResult;
    try {
      result = await resolver.promise;
    } finally {
      clearInterval(watchdog);
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const cost = computeInteractiveCost(transcriptPath, opts.model);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
      // Context-meter: most recent turn's input context (input + cache), mirroring
      // headless claude.ts so interactive/CLI-view turns also populate the meter.
      const ctx = lastTurnContextTokens(transcriptPath);
      if (ctx) result.contextTokens = ctx;
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn().
   *  When `proxyPort` is given, points ANTHROPIC_BASE_URL at the per-PTY SSE
   *  forward proxy on 127.0.0.1 — subscription OAuth token is passed separately
   *  by claude, so this stays cc_entrypoint=cli / subsidy-safe (verified Item A). */
  private buildPtyEnv(proxyPort?: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      // Belt-and-suspenders: a stray API key/token would flip the child to metered
      // API billing instead of the Max subscription. Strip both so the PTY session
      // always resolves to subscription auth (cc_entrypoint=cli).
      if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
      if (v !== undefined) env[k] = v;
    }
    // Use claude's main-screen renderer (NOT the alt-screen fullscreen one).
    // xterm.js's `scrollback` ring only applies to the main buffer — the alt
    // screen has no scrollback at all, so wheel-scroll in our CLI view is
    // impossible while NO_FLICKER is on. Trading mild flicker for usable scroll.
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999"; // suppress "resume from summary?" picker — always full-resume
    if (proxyPort) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
    return env;
  }

  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn. */
  private handleSseEvent(jinnSessionId: string, e: SseDataEvent, ctx: StreamCtx): void {
    const onStream = this.active.get(jinnSessionId)?.onStream;
    if (!onStream) return; // idle PTY / no turn in flight — nothing to stream
    // Tag sub-agent deltas so the chat pane routes them into a collapsible card
    // instead of the main transcript; main-agent deltas pass through untagged.
    for (const d of sseEventToDeltas(e)) onStream(ctx.subAgent ? { ...d, subAgent: ctx.subAgent } : d);
  }

  /** Allocate + start a per-PTY SSE forward proxy. Returns the proxy and its port,
   *  or {port:0} if it failed to bind — in which case the PTY is spawned WITHOUT
   *  ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works, only live
   *  word-by-word streaming degrades. */
  private async startProxy(jinnSessionId: string): Promise<{ proxy: SsePtyProxy; port: number }> {
    const proxy = new SsePtyProxy(jinnSessionId, (e, ctx) => this.handleSseEvent(jinnSessionId, e, ctx));
    try {
      const port = await proxy.start();
      return { proxy, port };
    } catch (err) {
      logger.warn(`SSE proxy failed to start for session ${jinnSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
      proxy.stop();
      return { proxy, port: 0 };
    }
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. On PTY exit, if this
   *  proc is the one bound to the active turn, the resolver is interrupted (a crash
   *  with no Stop hook); a stale proc replaced by a respawn is treated as benign.
   *  `proxy` (the per-PTY SSE forward proxy) is torn down when this PTY exits. */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, proxy?: SsePtyProxy): PtyHandle {
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    // Distinguish initial spawn from respawn via a per-stream flag rather than
    // subscriber count — CliTerminal opens its WS on mount (before the user
    // sends the first message that triggers spawn), so subscriber-count gating
    // would spuriously reset on the very first PTY for the session.
    // On respawn, only emit if there are subscribers (no one listens otherwise).
    if (!stream.hasSeenPty) {
      stream.hasSeenPty = true;
    } else if (stream.subscribers.size > 0) {
      for (const sub of stream.subscribers) {
        try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
      }
    }
    // node-pty's internal socket error handler (unixTerminal.js) throws synchronously when
    // proc.listeners('error').length < 2. Without this listener the count stays at 1 (the
    // internal handler), so any socket error (EIO on claude exit, EPIPE, etc.) propagates as
    // an uncaught exception and kills the daemon. Adding a handler here bumps the count to 2
    // and prevents the throw; we log it and let the onExit path handle cleanup.
    (proc as any).on?.("error", (err: Error) => {
      logger.warn(`PTY socket error for session ${jinnSessionId}: ${err.message}`);
    });

    proc.onData((d) => {
      // Convert string to Buffer once; push to ring; evict head until under cap.
      const chunk = Buffer.from(d, "utf-8");
      stream.chunks.push(chunk);
      stream.totalBytes += chunk.length;
      while (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length > 1) {
        const head = stream.chunks.shift()!;
        stream.totalBytes -= head.length;
      }
      // If a single chunk exceeds the cap, slice it down (rare; keeps invariant tight).
      if (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length === 1) {
        const only = stream.chunks[0]!;
        const sliced = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.chunks[0] = sliced;
        stream.totalBytes = sliced.length;
      }
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore subscriber errors */ }
      }
    });
    proc.onExit(() => {
      // Session-level cleanup MUST be identity-gated. In a kill->respawn race the
      // lifecycle/stream entries already point at the NEW PTY by the time THIS
      // (old, killed) PTY's exit fires. releaseSession is keyed by sessionId, so an
      // unguarded call here would kill the freshly-adopted PTY — whose own onExit
      // then fires the spurious second "claude process exited". Only this PTY being
      // the session's CURRENT warm handle means the cleanup is ours to do.
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        // Clear scrollback so a stale farewell (Claude's "Resume this session…" hint
        // printed on SIGHUP shutdown) doesn't persist into the next PTY incarnation.
        const s = this.streams.get(jinnSessionId);
        if (s) {
          s.chunks = [];
          s.totalBytes = 0;
          // If no WS subscribers are attached, the entry is dead weight — drop it so
          // the map doesn't leak entries for every session that ever ran. Subscribers,
          // when present, are kept so a future respawn can notify them via Task 4's
          // reset event; that path also clears the subscribers Set on full teardown.
          if (s.subscribers.size === 0) {
            this.streams.delete(jinnSessionId);
          }
        }
        // Release the lifecycle entry so the dead handle isn't picked up by a future
        // run() as "warm" — that would inject into a corpse.
        this.lifecycle.releaseSession(jinnSessionId);
      }
      // Tear down THIS PTY's SSE forward proxy (one proxy per PTY) regardless.
      proxy?.stop();
      // PTY exited without a Stop hook (crash / early exit) — settle the active turn
      // as interrupted so run()'s promise doesn't hang. BUT only if this dying proc is
      // the one bound to the active turn: after a kill->respawn race the active entry
      // holds the NEW turn's resolver+proc, and this (old, released) proc must not
      // poison it. Identity mismatch => benign cleanup, no interrupt.
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) {
        e.resolver.interrupt("Interrupted: claude process exited");
      }
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli).
   *  Allocates a per-PTY SSE forward proxy first and points the child at it. */
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): Promise<PtyHandle> {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
    });
    // Serialize the spawn herd across the shared-OAuth near-expiry window so only
    // one child triggers the (single-use) token refresh — others wait for it.
    await awaitFreshClaudeCredentials();
    const { proxy, port } = await this.startProxy(jinnSessionId);
    const env = this.buildPtyEnv(port || undefined);
    const bin = opts.bin || "claude";
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"}, sseProxy: ${port || "off"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel });
    return this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
  }

  /** Spawn an idle PTY for the CLI/xterm view. If an engineSessionId is provided,
   *  resumes that session; otherwise spawns a fresh `claude` so a brand-new CLI-mode
   *  session shows the TUI before the user types anything.
   *  Does NOTHING if a warm PTY already exists or a turn is starting.
   *  Fire-and-forget (void): allocating the per-PTY SSE proxy is async, so the
   *  actual spawn happens after a microtask; `idleSpawning` guards re-entrancy. */
  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    if (this.idleSpawning.has(jinnSessionId)) return; // an idle spawn is already in flight
    this.idleSpawning.add(jinnSessionId);

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
    });
    const args: string[] = [
      "--chrome",
      "--dangerously-skip-permissions",
      "--disallowedTools", "AskUserQuestion", "ExitPlanMode",
      "--settings", settingsPath,
    ];
    if (opts.engineSessionId) args.unshift("--resume", opts.engineSessionId);
    if (opts.model) args.push("--model", opts.model);
    const bin = opts.bin || "claude";
    // Caller (pty-ws) passes the client's current cols/rows. Cache them so a
    // future cold spawn through run() picks up the right geometry too.
    const cols = opts.cols ?? this.lastGeom.get(jinnSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(jinnSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) this.lastGeom.set(jinnSessionId, { cols: opts.cols, rows: opts.rows });

    void (async () => {
      try {
        await awaitFreshClaudeCredentials();
        const { proxy, port } = await this.startProxy(jinnSessionId);
        // Re-check after the async gap: a real turn (run) or another idle spawn may
        // have claimed the session while we awaited the proxy bind. If so, don't
        // adopt a duplicate PTY — drop our proxy and bail.
        if (this.lifecycle.getWarm(jinnSessionId) || this.active.has(jinnSessionId)) {
          proxy.stop();
          return;
        }
        const env = this.buildPtyEnv(port || undefined);
        logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows}, sseProxy: ${port || "off"})`);
        const proc = pty.spawn(bin, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd || JINN_HOME,
          env,
        });
        const handle = this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
        this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: undefined });
        this.lifecycle.adopt(jinnSessionId, handle);
      } catch (err) {
        logger.warn(`ensureIdleSpawn failed for session ${jinnSessionId}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.idleSpawning.delete(jinnSessionId);
      }
    })();
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    pasteAndSubmit(proc, text);
  }

  /** Lazily create (or fetch) the output stream entry for a Jinn session id. */
  private streamFor(sessionId: string): {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    hasSeenPty: boolean;
  } {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { chunks: [], totalBytes: 0, subscribers: new Set(), hasSeenPty: false };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for xterm.js reconnect replay).
   *  Returns a concatenated Buffer — pty-ws.ts forwards it directly without re-encoding. */
  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives PTY respawn within the session.
   *  Optional `onControl` receives out-of-band events (currently just `{type:"reset"}`
   *  when the PTY is replaced mid-session — the WS should forward this to the client xterm). */
  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    const stream = this.streamFor(sessionId);
    const sub = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      // If this was the last subscriber AND there's no warm PTY producing data,
      // the streams entry is dead weight — drop it. Mirrors the onExit cleanup
      // path for sessions whose WS outlived the PTY.
      if (stream.subscribers.size === 0 && !this.lifecycle.getWarm(sessionId)) {
        this.streams.delete(sessionId);
      }
    };
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  /** Resize the warm PTY + remember the geometry for the next cold spawn. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    this.lastGeom.set(sessionId, { cols, rows });
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
    // A remote (sshHost) turn ran on the headless fallback — kill it there too.
    this.remoteFallback?.kill(sessionId, reason);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
    this.remoteFallback?.killAll();
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Track viewing state from the frontend. Called by pty-ws on `viewing` messages
   *  from CliTerminal (mount/unmount + Page Visibility). Ref-counted so multiple tabs
   *  viewing the same session keep it warm until the last one leaves. */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists (or a
   *  remote fallback turn is live for this session). */
  isAlive(sessionId: string): boolean {
    return (
      this.active.has(sessionId) ||
      this.lifecycle.getWarm(sessionId) !== undefined ||
      this.remoteFallback?.isAlive(sessionId) === true
    );
  }
}
