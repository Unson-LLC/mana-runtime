/**
 * Reconciles pending `/vibepro` development runs (see development-pending.ts)
 * against the isolated runner's result spool (run.mjs's `writeResultSpool`),
 * so a gateway restart that orphans the runner still delivers a Slack
 * result/card instead of leaving the request answered by silence forever.
 *
 * Called once at gateway startup and on a periodic sweep (see manager.ts's
 * `reconcileDevelopmentPending`). For each pending run not currently
 * in-flight in this process:
 *
 *  - resume/continue runs know their `storyId` up front, so the spool file
 *    is looked up directly at `<spoolDir>/<storyId>.json`.
 *  - brand new runs don't know their Story id (the runner picks it), so the
 *    spool is searched for a `story-slack-...-<requestDigest>.json` file —
 *    the same digest the runner embeds in the Story id it generates
 *    (`sha256(request.trim()).slice(0, 8)`), giving an exact match rather
 *    than a fuzzy one. If that ever fails to match (e.g. the runner's id
 *    format changes), it falls back to the newest spooled result whose
 *    `finishedAt` is at or after the run's `startedAt` — the single-flight
 *    lock makes this unambiguous in practice, but the digest match is tried
 *    first because it doesn't depend on that invariant.
 *  - a match delivers the result through the same `deliverDevelopmentResult`
 *    path pipe delivery already uses (needs_decision/needs_input/pr_ready
 *    cards included), then removes the pending record — but only once that
 *    delivery actually succeeds (see `handleDeliveryFailure`).
 *  - no match and `startedAt` is older than `timeoutMs` (the gateway's own
 *    development-runner timeout, plus a fixed grace period) posts a plain
 *    "run was interrupted" notice — the worktree itself is untouched, so a
 *    fresh `/vibepro` retry is safe once the record is eventually cleared.
 *
 * Every delivery (result post or interruption notice) is resolved to a
 * connector via `resolveTargetConnector` — never a bare `connectorName`
 * lookup, since that name is shared across every instance of a connector
 * type (e.g. two Slack workspaces both report `name: "slack"`) and could
 * misdeliver to the wrong one. A post that throws does NOT remove the
 * pending record: `handleDeliveryFailure` increments `deliveryAttempts` and
 * only gives up (removing the record, with a loud error log) once
 * `MAX_DELIVERY_ATTEMPTS` is reached, so a transient API error doesn't
 * silently burn the run's only chance at delivery.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../shared/logger.js";
import { parseDevelopmentResult, DEFAULT_DEVELOPMENT_TIMEOUT_MS, type DevelopmentResult } from "./development-runner.js";
import {
  listPendingDevelopmentRuns,
  removePendingDevelopmentRun,
  recordDeliveryFailure,
  type PendingDevelopmentRun,
} from "./development-pending.js";
import type { Connector, JinnConfig, Target } from "../shared/types.js";

/** Extra time beyond the configured runner timeout before an orphaned run
 * (no spool, no in-flight owner) is declared interrupted. Generous on
 * purpose: a false "interrupted" notice while the run is still legitimately
 * in flight is worse than a late one. */
const TIMEOUT_GRACE_MS = 10 * 60 * 1000;

/** After this many consecutive failed delivery attempts (result post or
 * interruption notice), the reconciler gives up on a pending run rather than
 * retrying it forever. Logged loudly since giving up means the request is
 * genuinely lost from the user's point of view. */
const MAX_DELIVERY_ATTEMPTS = 10;

const STORY_ID_RE = /^story-[a-z0-9-]+$/;
const INTERRUPTED_NOTICE =
  "⚠ 開発runが中断されました（gateway再起動の影響の可能性）。worktreeは保持されています。/vibepro で再依頼してください。";

/**
 * Reads a spool file and strips the two spool-only bookkeeping fields
 * (`finishedAt`, `runnerPid` — see run.mjs's `buildSpoolPayload`) that are
 * never part of the stdout result contract, then re-serializes so the
 * result can go through the exact same fail-closed `parseDevelopmentResult`
 * validator a live pipe result does. Disk content is untrusted the same way
 * pipe content is untrusted.
 */
async function stripSpoolOnlyFields(spoolFile: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(spoolFile, "utf8")) as Record<string, unknown>;
  const { finishedAt: _finishedAt, runnerPid: _runnerPid, ...result } = parsed;
  return JSON.stringify(result);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the spool file for one pending run, or `null` if none is available
 * yet. Never throws — any read/stat failure is treated as "not found".
 */
export async function findSpoolFile(spoolDir: string, run: PendingDevelopmentRun): Promise<string | null> {
  if (run.storyId) {
    if (!STORY_ID_RE.test(run.storyId)) return null;
    const direct = path.join(spoolDir, `${run.storyId}.json`);
    return (await fileExists(direct)) ? direct : null;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(spoolDir);
  } catch {
    return null;
  }
  const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));

  if (run.requestDigest) {
    const digestSuffix = `-${run.requestDigest}.json`;
    const digestMatch = jsonFiles.find((entry) => entry.startsWith("story-slack-") && entry.endsWith(digestSuffix));
    if (digestMatch) return path.join(spoolDir, digestMatch);
  }

  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  let best: { file: string; finishedAtMs: number } | null = null;
  for (const entry of jsonFiles) {
    const full = path.join(spoolDir, entry);
    try {
      const raw = JSON.parse(await fs.readFile(full, "utf8")) as { finishedAt?: unknown };
      const finishedAtMs = typeof raw.finishedAt === "string" ? Date.parse(raw.finishedAt) : Number.NaN;
      if (!Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) continue;
      if (!best || finishedAtMs > best.finishedAtMs) best = { file: full, finishedAtMs };
    } catch {
      // Unreadable/malformed spool entry: skip, don't let it block matching.
    }
  }
  return best?.file ?? null;
}

/**
 * Resolves the connector a pending run's result/notice must be delivered
 * through.
 *
 * The registry (`connectorProvider()`) is a `Map<string, Connector>` keyed by
 * the *instance* id each connector was registered under in
 * gateway/server.ts's `connectorMap` (e.g. "slack" for the default
 * workspace, "slack-biz" for a named `connectors.instances[]` entry) — NOT
 * by `Connector.name`, which multiple instances of the same connector type
 * share (every SlackConnector reports `name: "slack"` regardless of which
 * workspace it's bound to). Resolving by `name` alone can silently pick the
 * wrong workspace's connector and misdeliver a result — e.g. a `needs_input`
 * card meant for a client's private Slack workspace landing in an internal
 * one instead.
 *
 * - `run.connectorInstanceId` set (current record format): strict lookup by
 *   that exact key. No `name` fallback — if that instance isn't registered
 *   right now (removed from config, gateway restarted with a different
 *   instance set, etc.), the caller must hold the pending record rather than
 *   guess at a same-`name` substitute.
 * - `run.connectorInstanceId` absent (the record predates this field, or the
 *   connector type doesn't support named instances): the only safe move is a
 *   `name` match, and only when it is unambiguous. Zero or multiple
 *   registered connectors sharing that `name` both fail closed (`undefined`)
 *   rather than guessing.
 */
export function resolveTargetConnector(
  connectorMap: Map<string, Connector>,
  run: PendingDevelopmentRun,
): Connector | undefined {
  if (run.connectorInstanceId) {
    return connectorMap.get(run.connectorInstanceId);
  }
  const candidates = Array.from(connectorMap.values()).filter((candidate) => candidate.name === run.connectorName);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Records a failed delivery attempt for `run` and, once the configured
 * retry cap is reached, gives up on it (logs loudly and removes the
 * pending record). Kept pending in every other case — the next sweep will
 * retry. No-ops if the run was already removed by a racing sweep.
 */
function handleDeliveryFailure(run: PendingDevelopmentRun): void {
  const attempts = recordDeliveryFailure(run.runId);
  if (attempts === null) return;
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    logger.error(
      `[development-reconciler] giving up on ${run.runId} after ${attempts} failed delivery attempts; the request is lost`,
    );
    removePendingDevelopmentRun(run.runId);
  }
}

export interface ReconcileDeps {
  connectorProvider: () => Map<string, Connector>;
  /** True when `run.runId` is the run this process is currently awaiting a
   * pipe result for — excluded so the reconciler never races the normal
   * pipe-delivery path. */
  isInFlight: (run: PendingDevelopmentRun) => boolean;
  deliverResult: (result: DevelopmentResult, connector: Connector, target: Target) => Promise<void>;
  now?: () => number;
}

/**
 * Runs one reconciliation pass. No-ops entirely when
 * `config.developmentRunner.resultsSpoolDir` is not configured (back-compat:
 * the reconciler is opt-in).
 */
export async function reconcilePendingDevelopmentRuns(
  config: JinnConfig,
  deps: ReconcileDeps,
): Promise<void> {
  const devConfig = config.developmentRunner;
  const spoolDir = devConfig?.resultsSpoolDir;
  if (!spoolDir) return;

  const pending = listPendingDevelopmentRuns();
  if (pending.length === 0) return;

  const now = (deps.now ?? Date.now)();
  const timeoutMs = (devConfig?.timeoutMs ?? DEFAULT_DEVELOPMENT_TIMEOUT_MS) + TIMEOUT_GRACE_MS;

  for (const run of pending) {
    if (deps.isInFlight(run)) continue;
    const connector = resolveTargetConnector(deps.connectorProvider(), run);
    const target: Target = { channel: run.channel, ...(run.thread ? { thread: run.thread } : {}) };

    let spoolFile: string | null;
    try {
      spoolFile = await findSpoolFile(spoolDir, run);
    } catch (error) {
      logger.error(`[development-reconciler] spool lookup failed for ${run.runId}: ${error instanceof Error ? error.message : "unknown error"}`);
      spoolFile = null;
    }

    if (spoolFile) {
      let result: DevelopmentResult;
      try {
        result = parseDevelopmentResult(await stripSpoolOnlyFields(spoolFile));
      } catch (error) {
        // The spool file itself is untrusted disk content — it goes through
        // the same fail-closed validator as a live pipe result. A bad file
        // is left in place (and the pending record kept) for operator
        // inspection rather than silently discarded or half-delivered.
        logger.error(`[development-reconciler] invalid spool result for ${run.runId} (${spoolFile}): ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
      if (!connector) {
        // Fail-closed: no exact instance match (or an ambiguous legacy
        // name match) means we don't actually know where this belongs.
        // Keeping the record — never guessing — is what prevents a result
        // meant for one Slack workspace from landing in another.
        logger.warn(`[development-reconciler] no connector resolved for ${run.runId} (instanceId=${run.connectorInstanceId ?? "none"}, name=${run.connectorName}); keeping pending run`);
        continue;
      }
      try {
        await deps.deliverResult(result, connector, target);
        removePendingDevelopmentRun(run.runId);
      } catch (error) {
        logger.error(`[development-reconciler] failed to deliver result for ${run.runId}: ${error instanceof Error ? error.message : "unknown error"}`);
        handleDeliveryFailure(run);
      }
      continue;
    }

    const startedAtMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAtMs) || now - startedAtMs <= timeoutMs) continue;

    if (connector) {
      try {
        await connector.replyMessage(target, INTERRUPTED_NOTICE);
        // Only a successful post retires the record — a failed post below
        // keeps it pending for the next sweep instead of silently losing
        // the run's only remaining chance at a retry.
        removePendingDevelopmentRun(run.runId);
      } catch (error) {
        logger.error(`[development-reconciler] failed to post interruption notice for ${run.runId}: ${error instanceof Error ? error.message : "unknown error"}`);
        handleDeliveryFailure(run);
      }
    } else {
      logger.warn(`[development-reconciler] no connector resolved for timed-out run ${run.runId} (instanceId=${run.connectorInstanceId ?? "none"}, name=${run.connectorName}); keeping pending run`);
    }
  }
}
