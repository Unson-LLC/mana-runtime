import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee, IncomingMessage } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { invalidateModelRegistry } from "../shared/models.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, recoverStaleSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession, getSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import { GeminiEngine } from "../engines/gemini.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { HookRegistry } from "./hook-registry.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { writeGatewayInfo } from "./gateway-info.js";
import { cleanupSessionSettings, seedTrust } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, CLAUDE_SETTINGS_DIR, JINN_HOME } from "../shared/paths.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { webSocketUpgradeAuthorized } from "./operator-auth.js";
import { ensureFilesDir } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { SlackConnector, type SlackConnectorContext } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../connectors/discord/remote.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { TelegramConnector } from "../connectors/telegram/index.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, reloadScheduler, stopScheduler } from "../cron/scheduler.js";
import { scanOrg } from "./org.js";
import { resolveSlackRuntimeConfig, resolveSlackInstanceRuntimeConfig } from "../shared/slack-runtime-config.js";
import { resolvePlacement } from "../shared/placement-profile.js";
import { emitSecurityEvent, placementConfigRevision } from "../shared/security-events.js";
import { getPlacementBudgetStatus } from "./budgets.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Copy the hook-relay.mjs asset next to JINN_HOME so PTY-spawned Claude (running
 *  with our per-session --settings) can invoke it to POST turn hooks back to the
 *  gateway. Tries dev (src) and built (dist) layouts. Best-effort: a failure only
 *  degrades interactive turn resolution, which we log. */
function copyHookRelayAsset(): void {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "assets", "hook-relay.mjs"), // dev: src/gateway → packages/jimmy/assets
    path.join(__dirname, "..", "..", "assets", "hook-relay.mjs"),       // built: dist/src/gateway → dist/assets
    path.join(__dirname, "..", "assets", "hook-relay.mjs"),
  ];
  try {
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      logger.warn("hook-relay.mjs asset not found in any candidate location; interactive Claude hooks may not work");
      return;
    }
    fs.copyFileSync(src, HOOK_RELAY_SCRIPT);
  } catch (err) {
    logger.warn(`Failed to copy hook-relay.mjs: ${err instanceof Error ? err.message : err}`);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function buildSlackConnectorContext(
  cfg: JinnConfig,
  goalInjectionEnabled: boolean,
  sessionManager?: SessionManager,
): SlackConnectorContext {
  return {
    portalName: cfg.portal?.portalName,
    operatorName: cfg.portal?.operatorName,
    operatorAliases: cfg.portal?.operatorAliases,
    goalInjectionEnabled,
    developmentRunnerEnabled: cfg.developmentRunner?.enabled === true,
    developmentRunnerAllowedChannels: cfg.developmentRunner?.allowedSlackChannels,
    resumeDevelopmentDecision: sessionManager
      ? (storyId, answers, connector, target) =>
          sessionManager.resumeDevelopmentDecision(storyId, answers, connector, target)
      : undefined,
  };
}

/**
 * Single routing gate for EVERY connector message. When `placements` are
 * configured this is fail-closed: a message that does not resolve to a unique,
 * enabled, audience-authorized placement returns undefined and must not be
 * routed. Non-Slack connectors go through here too — bypassing this function
 * reopens the placement-bypass hole recorded in
 * docs/discovery/gap-analysis-2026-07-30.md (A-1).
 * Exported for tests.
 */
export function resolveRouteOptions(
  cfg: JinnConfig,
  msg: IncomingMessage,
  employees: Map<string, Employee>,
  fallbackEmployee?: string,
  criticalRouting?: RouteOptions["criticalRouting"],
): RouteOptions | undefined {
  const resolution = resolvePlacement(cfg.placements, msg);
  if (resolution.status === "denied") {
    const reason = resolution.reason === "unauthorized_user" ? "unauthorized_actor"
      : resolution.reason === "invalid_config" ? "placement_missing_after_config_change"
      : resolution.reason === "disabled" ? "placement_disabled"
      : resolution.reason!;
    emitSecurityEvent({
      event: "placement_resolution", reason, placementId: resolution.placementId, connector: msg.connector,
      workspaceId: String((msg.transportMeta as Record<string, unknown> | undefined)?.team ?? "") || undefined,
      channelId: msg.channel, actorId: msg.user, configRevision: placementConfigRevision(cfg.placements),
    });
    return undefined;
  }

  const opts: RouteOptions = { criticalRouting };
  if (resolution.status === "matched") {
    const placement = resolution.placement!;
    // Monthly placement budget: an exceeded placement fails closed at the same
    // gate as the kill switch, so no connector path can spend past the cap.
    if (placement.monthlyBudgetUsd !== undefined) {
      const budget = getPlacementBudgetStatus(placement.id, placement.monthlyBudgetUsd);
      if (budget.status === "paused") {
        emitSecurityEvent({
          event: "placement_resolution", reason: "placement_budget_exceeded", placementId: placement.id,
          connector: msg.connector, channelId: msg.channel, actorId: msg.user,
          configRevision: placementConfigRevision(cfg.placements),
        });
        logger.warn(`Placement ${placement.id} blocked: monthly budget exceeded ($${budget.spend.toFixed(2)} / $${budget.limit})`);
        return undefined;
      }
    }
    opts.placement = placement;
    opts.model = placement.agent?.defaultModel;
    const employeeName = placement.agent?.employee;
    if (employeeName) {
      const employee = employees.get(employeeName);
      if (!employee) {
        emitSecurityEvent({ event: "derived_session", reason: "employee_denied", placementId: placement.id,
          connector: msg.connector, channelId: msg.channel, actorId: msg.user,
          target: employeeName, configRevision: placementConfigRevision(cfg.placements) });
        logger.error(`Placement ${placement.id} denied: employee "${employeeName}" is not configured`);
        return undefined;
      }
      opts.employee = employee;
    }
    if (placement.agent?.escalationEmployee) {
      opts.criticalRouting = {
        enabled: true,
        reviewerEmployee: placement.agent.escalationEmployee,
      };
    }
    return opts;
  }

  if (fallbackEmployee) {
    const employee = employees.get(fallbackEmployee);
    if (employee) opts.employee = employee;
  }
  return opts;
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  // Strip query string before resolving file path
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    // Next.js static export produces /chat.html, /sessions.html, etc.
    // Try appending .html before falling back to index.html
    const htmlPath = resolved.endsWith("/")
      ? path.join(resolved, "index.html")
      : resolved + ".html";
    if (fs.existsSync(htmlPath) && !fs.statSync(htmlPath).isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }

    // SPA fallback: serve index.html for non-API, non-WS routes
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export type GatewayCleanup = () => Promise<void>;

export async function startGateway(
  config: JinnConfig,
): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  const gatewayName = config.portal?.portalName || "Ryoko";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  // Initialize database and recover any sessions stuck from a previous run
  initDb();
  ensureFilesDir();
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }

  // Log resumable sessions so operators know what can be picked up
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }

  // Set up engines
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const geminiEngine = new GeminiEngine();

  // Interactive Claude (PTY) engine — opt-in via config.engines.claude.interactive.
  // When enabled it REPLACES the headless `claude -p` engine under the "claude" key,
  // so all existing engine-config / fallback / rate-limit logic keys on "claude"
  // unchanged. It runs the genuine `claude` CLI in a PTY (no -p → cc_entrypoint=cli),
  // which bills against the Max subscription instead of metered API usage. Turns are
  // resolved via Claude Code Stop hooks relayed back through /api/internal/hook.
  const useInteractiveClaude = config.engines?.claude?.interactive === true;
  const hookSecret = randomBytes(24).toString("hex");
  let hookRegistry: HookRegistry | undefined;
  let claudeLifecycle: PtyLifecycleManager | undefined;
  let interactiveClaudeEngine: InteractiveClaudeEngine | undefined;
  if (useInteractiveClaude) {
    hookRegistry = new HookRegistry();
    claudeLifecycle = new PtyLifecycleManager({
      maxLivePtys: config.engines?.claude?.maxLivePtys ?? 8,
      onCleanup: (id) => {
        hookRegistry?.unregister(id);
        cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      },
      // Never reap/evict a PTY whose claude is mid-API-call (background
      // sub-agents keep streaming after the managed turn settles). Lazily bound:
      // the engine is constructed a few lines below.
      isBusy: (id) => interactiveClaudeEngine?.isEngineBusy(id) ?? false,
      isActivelyBusy: (id) => interactiveClaudeEngine?.isEngineActivelyBusy(id) ?? false,
    });
    // Pass the headless engine as a remote fallback so sshHost employees still run
    // over SSH (the local PTY can't), while local turns get the Max-subsidized PTY.
    interactiveClaudeEngine = new InteractiveClaudeEngine(
      claudeLifecycle,
      hookRegistry,
      claudeEngine,
      config.engines?.claude?.interactiveTurnTimeoutMs ?? 90 * 60 * 1000,
      config.engines?.claude?.interactivePermissionMode ?? "default",
      config.engines?.claude?.interactiveAllowedTools ?? [],
    );
    copyHookRelayAsset();
    // Pre-trust JINN_HOME in the real ~/.claude.json so PTY-spawned Claude (cwd =
    // JINN_HOME) doesn't block every turn on the interactive "trust this folder?"
    // dialog — which has no Stop hook, so the turn would hang forever.
    try {
      seedTrust(path.join(os.homedir(), ".claude.json"), JINN_HOME);
    } catch (err) {
      logger.warn(`seedTrust failed for ${JINN_HOME}: ${err instanceof Error ? err.message : err}`);
    }
    logger.info("Interactive Claude (PTY) engine enabled — Claude work turns run via PTY (Max-subsidized cc_entrypoint=cli)");
  }

  const engines = new Map<string, InstanceType<typeof ClaudeEngine> | InstanceType<typeof CodexEngine> | InstanceType<typeof GeminiEngine> | InteractiveClaudeEngine>();
  engines.set("claude", interactiveClaudeEngine ?? claudeEngine);
  engines.set("codex", codexEngine);
  engines.set("gemini", geminiEngine);

  // PTY-capable engines keyed by engine name — the /ws/pty/:sessionId handler
  // routes by session.engine so the live xterm CLI view attaches to the right one.
  // Only the interactive Claude engine exposes a PTY; absent when interactive is off.
  const ptyViewEngines: Record<string, PtyViewEngine> = {};
  if (interactiveClaudeEngine) ptyViewEngines["claude"] = interactiveClaudeEngine;

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (resolveSlackRuntimeConfig(config.connectors?.slack)) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
  }
  if (config.connectors?.telegram?.botToken) {
    connectorNames.push("telegram");
  }
  if (config.connectors?.whatsapp) {
    connectorNames.push("whatsapp");
  }

  // Session manager
  const sessionManager = new SessionManager(config, engines, connectorNames);

  // Orphan hooks = engine activity AFTER a turn settled (background sub-agents /
  // tasks still running in the PTY). Any orphan event keeps the PTY alive; a
  // terminal Stop orphan is the final output of that background work and gets
  // delivered to the session's conversation instead of being dropped.
  hookRegistry?.setOrphanHandler((sid, hook) => {
    interactiveClaudeEngine?.noteBackgroundActivity(sid);
    void sessionManager.handleOrphanHook(sid, hook);
  });

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  // ---- Top-level connector start/stop helpers (closure over employeeRegistry, connectors, etc.) ----
  // These are defined here so they can be reused by both initial startup AND
  // reloadAllConnectors() when config.yaml changes (e.g. user saves new Slack
  // tokens via the WebUI).

  async function stopTopLevelConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      // Instance-based connectors are handled by reloadConnectorInstances()
      if (instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let reload recreate.
        connectorMap.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped top-level connector "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Don't drop the reference: the underlying client
        // (Slack websocket, Discord gateway, etc.) may still be live. If we
        // recreated it now, we'd have two live clients processing the same
        // events and sending duplicate replies. Better to surface a loud
        // error and require a daemon restart for recovery.
        const message = `stop() failed for top-level connector "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startTopLevelConnectorsFromConfig(
    cfg: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];

    const slackConfig = resolveSlackRuntimeConfig(cfg.connectors?.slack);
    if (slackConfig && !connectorMap.has("slack")) {
      try {
        const slack = new SlackConnector(
          {
            ...slackConfig,
          },
          buildSlackConnectorContext(
            cfg,
            (slackConfig.employee
              ? employeeRegistry.get(slackConfig.employee)?.engine
              : cfg.engines.default) === "claude",
            sessionManager,
          ),
        );
        slack.onMessage((msg) => {
          const routeOpts = resolveRouteOptions(cfg, msg, employeeRegistry, cfg.connectors.slack?.employee, cfg.connectors.slack?.criticalRouting);
          if (!routeOpts) return;
          sessionManager.route(msg, slack, routeOpts).catch((err) => {
            logger.error(`Slack route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await slack.start();
        connectors.push(slack);
        connectorMap.set("slack", slack);
        started.push("slack");
      } catch (err) {
        const msg = `Failed to start Slack connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.discord?.proxyVia && !connectorMap.has("discord")) {
      try {
        const discord = new RemoteDiscordConnector({
          proxyVia: cfg.connectors.discord.proxyVia,
          channelId: cfg.connectors.discord.channelId,
          proxyToken: cfg.connectors.discord.proxyToken,
        });
        discord.onMessage((msg) => {
          const routeOpts = resolveRouteOptions(cfg, msg, employeeRegistry, cfg.connectors.discord?.employee);
          if (!routeOpts) return;
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord remote connector started");
      } catch (err) {
        const msg = `Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    } else if (cfg.connectors?.discord?.botToken && !connectorMap.has("discord")) {
      try {
        const discord = new DiscordConnector(cfg.connectors.discord as DiscordConnectorConfig);
        discord.onMessage((msg) => {
          const routeOpts = resolveRouteOptions(cfg, msg, employeeRegistry, cfg.connectors.discord?.employee);
          if (!routeOpts) return;
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord connector started");
      } catch (err) {
        const msg = `Failed to start Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.telegram?.botToken && !connectorMap.has("telegram")) {
      try {
        const telegram = new TelegramConnector({
          botToken: cfg.connectors.telegram.botToken,
          allowFrom: cfg.connectors.telegram.allowFrom,
          ignoreOldMessagesOnBoot: cfg.connectors.telegram.ignoreOldMessagesOnBoot,
        });
        telegram.onMessage((msg) => {
          const routeOpts = resolveRouteOptions(cfg, msg, employeeRegistry, cfg.connectors.telegram?.employee);
          if (!routeOpts) return;
          sessionManager.route(msg, telegram, routeOpts).catch((err) => {
            logger.error(`Telegram route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await telegram.start();
        connectors.push(telegram);
        connectorMap.set("telegram", telegram);
        started.push("telegram");
      } catch (err) {
        const msg = `Failed to start Telegram connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.whatsapp && !connectorMap.has("whatsapp")) {
      try {
        const whatsapp = new WhatsAppConnector(cfg.connectors.whatsapp ?? {});
        whatsapp.onMessage((msg) => {
          const routeOpts = resolveRouteOptions(cfg, msg, employeeRegistry, cfg.connectors.whatsapp?.employee);
          if (!routeOpts) return;
          sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
            logger.error(`WhatsApp route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await whatsapp.start();
        connectors.push(whatsapp);
        connectorMap.set("whatsapp", whatsapp);
        started.push("whatsapp");
        logger.info("WhatsApp connector started (scan QR code if first run)");
      } catch (err) {
        const msg = `Failed to start WhatsApp connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    return { started, errors };
  }

  // Initial top-level connector startup
  await startTopLevelConnectorsFromConfig(config);

  // Process named connector instances (allows multiple connectors of the same type)
  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
      const { id, type, employee, ...typeConfig } = instance;
      if (!id || !type) {
        logger.warn(`Skipping connector instance without id or type`);
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }

      try {
        let connector: Connector;
        switch (type) {
          case "discord": {
            const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
            const discord = new DiscordConnector(discordConfig);
            discord.onMessage((msg) => {
              const routeOpts = resolveRouteOptions(config, msg, employeeRegistry, employee);
              if (!routeOpts) return;
              sessionManager.route(msg, discord, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await discord.start();
            connector = discord;
            break;
          }
          case "slack": {
            const slackConfig = resolveSlackInstanceRuntimeConfig({ ...typeConfig, id } as any);
            const slack = new SlackConnector(
              slackConfig,
              buildSlackConnectorContext(
                config,
                (employee ? employeeRegistry.get(employee)?.engine : config.engines.default) === "claude",
                sessionManager,
              ),
            );
            slack.onMessage((msg) => {
              const routeOpts = resolveRouteOptions(config, msg, employeeRegistry, employee);
              if (!routeOpts) return;
              sessionManager.route(msg, slack, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await slack.start();
            connector = slack;
            break;
          }
          case "whatsapp": {
            const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
            whatsapp.onMessage((msg) => {
              const routeOpts = resolveRouteOptions(config, msg, employeeRegistry, employee);
              if (!routeOpts) return;
              sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await whatsapp.start();
            connector = whatsapp;
            break;
          }
          case "telegram": {
            const telegramConfig = { ...typeConfig, id } as any;
            const tg = new TelegramConnector(telegramConfig);
            tg.onMessage((msg) => {
              const routeOpts = resolveRouteOptions(config, msg, employeeRegistry, employee);
              if (!routeOpts) return;
              sessionManager.route(msg, tg, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await tg.start();
            connector = tg;
            break;
          }
          default:
            logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
        }
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  sessionManager.setConnectorProvider(() => connectorMap);

  // Reload connector instances from config (stop old instances, start new ones)
  /**
   * Stop only the instance-based connectors. Split out from the legacy
   * combined reload so reloadAllConnectors() can interleave: stop top-level
   * + stop instances → start top-level → start instances. That order
   * preserves boot-time precedence (top-level wins for duplicate ids).
   */
  async function stopInstanceConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let restart create afresh.
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Same reasoning as stopTopLevelConnectors: leave
        // the reference in place rather than risk duplicate live clients.
        const message = `stop() failed for instance "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startConfiguredInstances(
    freshConfig: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];
    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee, ...typeConfig } = instance;
        if (!id || !type) continue;
        if (connectorMap.has(id)) continue;

        try {
          let connector: Connector;
          switch (type) {
            case "discord": {
              const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
              const discord = new DiscordConnector(discordConfig);
              discord.onMessage((msg) => {
                const routeOpts = resolveRouteOptions(freshConfig, msg, employeeRegistry, employee);
                if (!routeOpts) return;
                sessionManager.route(msg, discord, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await discord.start();
              connector = discord;
              break;
            }
            case "slack": {
              const slackConfig = resolveSlackInstanceRuntimeConfig({ ...typeConfig, id } as any);
              // Use freshConfig.portal (not the closure-captured boot-time
              // `config`) so renamed portals show up after a hot-reload.
              const slack = new SlackConnector(
                slackConfig,
                buildSlackConnectorContext(
                  freshConfig,
                  (employee ? employeeRegistry.get(employee)?.engine : freshConfig.engines.default) === "claude",
                  sessionManager,
                ),
              );
              slack.onMessage((msg) => {
                const routeOpts = resolveRouteOptions(freshConfig, msg, employeeRegistry, employee);
                if (!routeOpts) return;
                sessionManager.route(msg, slack, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await slack.start();
              connector = slack;
              break;
            }
            case "whatsapp": {
              const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
              whatsapp.onMessage((msg) => {
                const routeOpts = resolveRouteOptions(freshConfig, msg, employeeRegistry, employee);
                if (!routeOpts) return;
                sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await whatsapp.start();
              connector = whatsapp;
              break;
            }
            case "telegram": {
              const telegramConfig = { ...typeConfig, id } as any;
              const tg = new TelegramConnector(telegramConfig);
              tg.onMessage((msg) => {
                const routeOpts = resolveRouteOptions(freshConfig, msg, employeeRegistry, employee);
                if (!routeOpts) return;
                sessionManager.route(msg, tg, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await tg.start();
              connector = tg;
              break;
            }
            default:
              errors.push(`Unknown connector type "${type}" for instance "${id}"`);
              continue;
          }
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, errors };
  }

  /**
   * Backwards-compatible wrapper: stop+start instances in one call. Used by
   * the `POST /api/connectors/reload` endpoint and exposed via ApiContext
   * for any external consumer that still calls reloadConnectorInstances().
   */
  async function reloadConnectorInstances(
    preloadedConfig?: JinnConfig,
  ): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = preloadedConfig ?? loadConfig();
    const stopRes = await stopInstanceConnectors();
    const startRes = await startConfiguredInstances(fresh);
    return {
      started: startRes.started,
      stopped: stopRes.stopped,
      errors: [...stopRes.errors, ...startRes.errors],
    };
  }

  /**
   * Stop and re-initialize ALL connectors (top-level + instance-based) from
   * the on-disk config. Called automatically when ~/.ryoko/config.yaml
   * changes via the chokidar watcher, and via POST /api/connectors/reload.
   *
   * This is what makes "save Slack tokens in WebUI → bot reconnects" work
   * without a daemon restart. Previously only instance-based connectors
   * were reloaded, so editing top-level slack tokens required `ryoko stop`
   * + `ryoko start`.
   */
  async function doReloadOnce(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = loadConfig();
    // Push fresh config into the SessionManager so new sessions see new
    // engines.default / portal.* / bin paths. Callers (watcher / API) are
    // responsible for updating apiContext.config too.
    currentConfig = fresh;
    invalidateModelRegistry(); // rebuild the model/capability registry from the new config
    sessionManager.setConfig(fresh);

    // Order:
    //   1. Stop old top-level + old instance connectors (clear the map).
    //   2. Start top-level FIRST (matches boot precedence: if a duplicate
    //      id exists in both forms, the legacy top-level wins).
    //   3. Start instances last — same `!connectorMap.has(...)` guard as
    //      boot, so duplicate-id instances are skipped, not the top-level.
    const stopTopRes = await stopTopLevelConnectors();
    const stopInstRes = await stopInstanceConnectors();
    const startTopRes = await startTopLevelConnectorsFromConfig(fresh);
    const startInstRes = await startConfiguredInstances(fresh);
    // Refresh the connector names baked into engine system prompts.
    sessionManager.setConnectorNames(Array.from(connectorMap.keys()));

    const result = {
      started: [...startTopRes.started, ...startInstRes.started],
      stopped: [...stopTopRes.stopped, ...stopInstRes.stopped],
      errors: [
        ...stopTopRes.errors,
        ...stopInstRes.errors,
        ...startTopRes.errors,
        ...startInstRes.errors,
      ],
    };

    // Only mark this config as "successfully applied" when no errors arose.
    // Otherwise the watcher's next event (after clearSuppressNextConnectorReload
    // in the API failure path) would diff fresh-vs-fresh and skip the retry.
    if (result.errors.length === 0) {
      lastConnectorReloadConfig = fresh;
    }
    return result;
  }

  async function reloadAllConnectors(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    // Coalesce concurrent callers: if a reload is in flight, mark a follow-up
    // so newer config (the second caller's intent) gets picked up after the
    // current one completes — and return the in-flight promise's result.
    // Without this, two overlapping reloads can both observe an empty map
    // after their respective stop pass and start duplicate live clients.
    if (reloadInFlight) {
      pendingReload = true;
      return reloadInFlight;
    }
    reloadInFlight = (async () => {
      try {
        let result = await doReloadOnce();
        // Drain any reload requests that arrived during this run, with
        // the most recent on-disk config. Keep going until quiet.
        while (pendingReload) {
          pendingReload = false;
          result = await doReloadOnce();
        }
        return result;
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  }

  // Start cron scheduler
  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Mutable config reference for hot-reload
  let currentConfig = config;
  // Tracks the config version that was last successfully applied to connectors.
  // The watcher diffs against THIS (not currentConfig) so that a failed reload
  // does not poison the next chokidar event into thinking "nothing changed".
  let lastConnectorReloadConfig = config;

  // Single-flight gate for connector reloads: any caller that arrives while
  // one is in flight is coalesced (no duplicate clients), and any reload
  // request received during a run schedules a single follow-up so newer
  // config doesn't get lost.
  let reloadInFlight: Promise<{ started: string[]; stopped: string[]; errors: string[] }> | null = null;
  let pendingReload = false;

  // Coordination flag between the API config-save path and the file watcher.
  // PUT /api/config eagerly reloads connectors for snappy UX, then sets this
  // flag so the chokidar event for the same file write doesn't double-reload
  // and race against the in-flight reload.
  let suppressNextWatcherConnectorReload = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  function suppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    // Auto-clear after 3s in case the watcher event never arrives (the file
    // write was rolled back, chokidar missed it, etc.) — we don't want to
    // permanently suppress legitimate future reloads.
    suppressTimer = setTimeout(() => {
      suppressNextWatcherConnectorReload = false;
      suppressTimer = null;
    }, 3000);
  }
  function clearSuppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = false;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  const startTime = Date.now();

  // Broadcast function (defined early so apiContext can reference it)
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
  };

  // Backstop for lost completion events: unstick sessions stuck at
  // status:"running" with no live turn (see status-reconciler.ts).
  const stopStatusReconciler = startStatusReconciler({ engines, emit });

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    reloadAllConnectors,
    suppressNextConnectorReload,
    clearSuppressNextConnectorReload,
    hookRegistry,
    hookSecret: useInteractiveClaude ? hookSecret : undefined,
  };

  // NOTE: replaying pending web queue items is deferred until AFTER the server is
  // listening and gateway.json (port + hook secret) has been written — otherwise an
  // interactive (PTY) recovery turn could spawn before hook-relay.mjs can discover
  // the gateway, leaving its Stop hook undeliverable and the turn hung.

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Loopback Host header guard.
  //
  // The gateway binds to 127.0.0.1 by default but every API route is
  // unauthenticated, which makes the daemon vulnerable to classic DNS
  // rebinding from any browser tab on the same machine: an attacker page
  // can resolve a hostile DNS name to 127.0.0.1 and then `fetch()` against
  // our endpoints. We reject any request whose `Host` header isn't a
  // loopback / explicit-bind value the operator has configured.
  const configuredHost = config.gateway.host || "127.0.0.1";
  const LOOPBACK_HOSTNAMES = new Set([
    "127.0.0.1",
    "[::1]",
    "::1",
    "localhost",
  ]);
  function hostIsAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    // Strip port for comparison; "host:port" or "[::1]:port".
    const lastColon = hostHeader.lastIndexOf(":");
    const closingBracket = hostHeader.lastIndexOf("]");
    const hostname = lastColon > closingBracket
      ? hostHeader.slice(0, lastColon)
      : hostHeader;
    if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
    if (hostname === configuredHost) return true;
    // Bare-IP case where the operator pinned to a LAN address.
    if (configuredHost === "0.0.0.0") return true; // explicit opt-in: any host
    return false;
  }

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // Host header check before anything else — applies to both API and
    // static asset paths so a malicious cross-origin browser tab can't
    // pull session JSON either.
    if (!hostIsAllowed(req.headers.host)) {
      res.writeHead(421, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "host_not_allowed" }));
      return;
    }

    // CORS: restrict to localhost-style origins by default. The operator
    // can broaden via `gateway.host = 0.0.0.0`, in which case we mirror
    // the request's Origin header (still safer than a blanket `*`).
    const origin = req.headers.origin as string | undefined;
    if (origin && configuredHost !== "0.0.0.0") {
      try {
        const u = new URL(origin);
        if (LOOPBACK_HOSTNAMES.has(u.hostname)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      } catch { /* invalid Origin header — leave CORS unset */ }
    } else if (origin && configuredHost === "0.0.0.0") {
      // explicit opt-in: reflect the origin (subject to operator policy)
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-OpenRyoko-Operator-Token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  // Dedicated WS server for per-session PTY streams (/ws/pty/:sessionId) — kept
  // separate from the global broadcast `wss` so its sockets aren't added to the
  // broadcast client set.
  const ptyWss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  // Origin guard for WS upgrades. WebSocket isn't covered by CORS preflight, so a
  // cross-site browser page could otherwise open /ws/pty and inject stdin into the
  // Claude PTY. Allow only same-host / loopback / configured-host origins; a non-
  // browser client (no Origin header) is allowed. Mirrors the HTTP CORS intent.
  function wsOriginAllowed(originHeader: string | undefined, hostHeader: string | undefined): boolean {
    if (!originHeader) return true; // non-browser client
    let originHost: string;
    try { originHost = new URL(originHeader).hostname; } catch { return false; }
    if (LOOPBACK_HOSTNAMES.has(originHost)) return true;
    if (originHost === configuredHost) return true;
    // Same-origin as the request's Host (strip port) — the gateway-served UI.
    if (hostHeader) {
      const lastColon = hostHeader.lastIndexOf(":");
      const closingBracket = hostHeader.lastIndexOf("]");
      const hostname = lastColon > closingBracket ? hostHeader.slice(0, lastColon) : hostHeader;
      if (originHost === hostname) return true;
    }
    return false;
  }

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    // DNS-rebinding / cross-host guard — mirror the HTTP request path so a WS
    // upgrade can't bypass it. Applies to both /ws and /ws/pty.
    if (!hostIsAllowed(req.headers.host)) { socket.destroy(); return; }
    const placementsEnabled = Boolean(currentConfig.placements?.length);
    if (!webSocketUpgradeAuthorized(placementsEnabled, req.headers["sec-websocket-protocol"])) {
      socket.destroy();
      return;
    }
    if (reqUrl === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Dedicated per-session PTY channel for the live xterm CLI view. Routes to the
    // session's OWN engine — no claude fallback (codex/gemini have no PTY view, and
    // the FE hides the CLI toggle for them, so this only refuses stragglers).
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      // /ws/pty forwards stdin to the PTY — reject cross-site browser origins.
      if (!wsOriginAllowed(req.headers.origin, req.headers.host)) { socket.destroy(); return; }
      let sessionId: string;
      try { sessionId = decodeURIComponent(ptyMatch[1]); } catch { socket.destroy(); return; }
      const ptySession = getSession(sessionId);
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine] : undefined;
      if (!ptyEngine) { socket.destroy(); return; }
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        attachPtyWebSocket(ws, sessionId, ptyEngine);
      });
      return;
    }
    socket.destroy();
  });


  // Sync skill symlinks to .claude/skills/ and .agents/skills/
  syncSkillSymlinks();

  // Initialize STT model symlinks
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers({
    onConfigReload: () => {
      try {
        const previous = currentConfig;
        currentConfig = loadConfig();
        invalidateModelRegistry(); // rebuild the model/capability registry from the reloaded config
        apiContext.config = currentConfig;
        // Propagate the fresh config into SessionManager so new sessions
        // pick up edits to engines.default / portal.* / engine bin paths
        // even when the connectors block didn't change.
        sessionManager.setConfig(currentConfig);
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});

        // If the API just wrote this file (PUT /api/config) it has already
        // triggered reloadAllConnectors itself and may still be mid-reconnect.
        // Skip our reload to avoid stop→start→stop→start churn and the
        // race that comes with two overlapping reloads.
        if (suppressNextWatcherConnectorReload) {
          suppressNextWatcherConnectorReload = false;
          if (suppressTimer) {
            clearTimeout(suppressTimer);
            suppressTimer = null;
          }
          logger.debug("Skipping watcher-triggered connector reload (API just wrote config and reloaded)");
          return;
        }

        // External edits to ~/.ryoko/config.yaml (vim, ryoko CLI, etc.) need
        // a connector refresh when either:
        //   (a) the connectors block changed, OR
        //   (b) portal.portalName/operatorName changed — Slack connectors
        //       capture those at construction so the live ones would keep
        //       triaging with the old portal identity until restart.
        //
        // Diff against lastConnectorReloadConfig (NOT `previous`) so that a
        // failed previous reload doesn't poison this comparison: if the
        // last successful reload was config v1 and we've since written v2
        // unsuccessfully, comparing v2-vs-v2 would skip the retry.
        const baseline = lastConnectorReloadConfig;
        const portalNamesChanged =
          baseline.portal?.portalName !== currentConfig.portal?.portalName ||
          baseline.portal?.operatorName !== currentConfig.portal?.operatorName;
        const connectorsChanged =
          JSON.stringify(baseline.connectors ?? null) !==
          JSON.stringify(currentConfig.connectors ?? null);
        if (connectorsChanged || portalNamesChanged) {
          reloadAllConnectors()
            .then((result) => {
              logger.info(
                `Connectors reloaded after config change — started=[${result.started.join(",")}] stopped=[${result.stopped.join(",")}] errors=${result.errors.length}`,
              );
              emit("connectors:reloaded", result);
            })
            .catch((err) => {
              logger.error(
                `reloadAllConnectors failed: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: () => {
      employeeRegistry = scanOrg();
      logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Port ${port} is already in use.`;
        logger.error(msg);
        console.error(`\nError: ${msg}`);
        console.error(`\nTry: ryoko start -p ${port + 1}`);
        console.error(`Or update the port in config.yaml\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      logger.info(`${gatewayName} gateway listening on http://${host}:${port} (boot ${bootId})`);
      resolve();
    });
  });

  // Publish gateway connection info (port + hook secret + pid) so hook-relay.mjs —
  // spawned by the interactive Claude PTY — can discover where to POST turn hooks.
  if (useInteractiveClaude) {
    try {
      writeGatewayInfo(GATEWAY_INFO_FILE, { port, pid: process.pid, secret: hookSecret });
    } catch (err) {
      logger.warn(`Failed to write ${GATEWAY_INFO_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Replay any pending web queue items (e.g. gateway restart mid-run). Deferred to
  // here so the server is listening and gateway.json exists before any interactive
  // recovery turn spawns — so hook-relay.mjs can deliver its Stop hook.
  resumePendingWebQueueItems(apiContext);

  // Notify connected WebSocket clients about interrupted sessions available for resume
  if (resumable.length > 0) {
    // Small delay to let WebSocket clients connect after server starts
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Prevent macOS from sleeping while the gateway is running
  let caffeinate: ChildProcess | null = null;
  if (process.platform === "darwin") {
    caffeinate = spawn("caffeinate", ["-s"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinate.unref();
    caffeinate.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      caffeinate = null;
    });
    logger.info("caffeinate started — macOS sleep prevention active");
  }

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    const runningSessions = listSessions({ status: "running" });
    for (const session of runningSessions) {
      updateSession(session.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    // Terminate live engine subprocesses after marking sessions. When interactive
    // is active, interactiveClaudeEngine.killAll() also kills its headless fallback
    // (the same claudeEngine), so call only one to avoid a redundant double-kill.
    if (interactiveClaudeEngine) {
      interactiveClaudeEngine.killAll();
      claudeLifecycle?.dispose();
      try { stopStatusReconciler(); } catch { /* best effort */ }
      try { hookRegistry?.dispose(); } catch { /* best effort */ }
      try { fs.rmSync(GATEWAY_INFO_FILE, { force: true }); } catch { /* best effort */ }
    } else {
      claudeEngine.killAll();
    }
    codexEngine.killAll();

    // Stop cron scheduler
    stopScheduler();

    // Stop connectors
    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Close WebSocket connections
    for (const client of wsClients) {
      client.close(1001, "Server shutting down");
    }
    wsClients.clear();

    // Close the per-session PTY WS sockets + server too (separate from `wss`).
    for (const client of ptyWss.clients) {
      try { client.close(1001, "Server shutting down"); } catch { /* already closing */ }
    }

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
