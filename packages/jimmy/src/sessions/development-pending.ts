/**
 * Durable bookkeeping for in-flight `/vibepro` development runs, so a
 * gateway restart that orphans the isolated runner process (the runner keeps
 * going under `systemd-run --scope`, or its own cgroup was killed with the
 * gateway's) does not silently lose the Slack result. Written just before
 * the runner is invoked and removed once its result has been delivered.
 *
 * Mirrors `connectors/slack/vibepro-decision.ts`'s persistence style: plain
 * synchronous fs + a JSON object keyed by an id, best-effort on write
 * (`saveState` never throws), fail-closed to "no pending runs" on read.
 *
 * Keyed by an internally-generated `runId`, not by `storyId`: a brand new
 * `/vibepro <request>` does not know its Story id until the runner picks one
 * (see run.mjs's `runNewStory`), so `storyId` is `null` and `requestDigest`
 * (the same `sha256(request.trim()).slice(0, 8)` the runner embeds in the
 * generated Story id) is recorded instead for later spool matching.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEVELOPMENT_PENDING_FILE } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface PendingDevelopmentRun {
  runId: string;
  /** Known once the runner has picked a Story id (resume/continue requests
   * always know it up front; new requests only learn it from the spool). */
  storyId: string | null;
  /** `sha256(request.trim()).slice(0, 8)` — only set for `kind: "new"`. */
  requestDigest?: string;
  /** `Connector.name` — kept for backwards compatibility with records
   * written before `connectorInstanceId` existed, and as the fallback key
   * for connector types that don't support named instances. NOT sufficient
   * on its own to resolve the right connector: every SlackConnector reports
   * `name: "slack"` regardless of which workspace it's bound to, so two
   * connected workspaces are indistinguishable by `connectorName` alone. */
  connectorName: string;
  /** The exact registry key (`Connector.instanceId`, e.g. "slack-biz") the
   * originating connector was registered under in the gateway's connector
   * map. Set whenever the connector reports one; absent for records written
   * before this field existed, or for connector types that don't support
   * named instances. The reconciler resolves strictly by this key when
   * present — never falls back to a `connectorName` match, since that could
   * silently pick the wrong workspace's connector. */
  connectorInstanceId?: string;
  channel: string;
  thread?: string;
  /** ISO timestamp of when this run was recorded (used as the reconciler's
   * timeout baseline and as the spool-matching lower bound for `new`). */
  startedAt: string;
  kind: "new" | "resume" | "continue";
  /** Count of consecutive failed delivery attempts (result delivery or the
   * timeout interruption notice), recorded via `recordDeliveryFailure`.
   * Absent/undefined is treated as 0. There is no successful-delivery
   * counter — a successful delivery always removes the record instead of
   * resetting this. */
  deliveryAttempts?: number;
}

type PersistedState = Record<string, PendingDevelopmentRun>;

function loadState(): PersistedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVELOPMENT_PENDING_FILE, "utf-8")) as PersistedState;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(DEVELOPMENT_PENDING_FILE), { recursive: true });
    fs.writeFileSync(DEVELOPMENT_PENDING_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[development-pending] failed to persist state: ${err}`);
  }
}

/** Records a new pending run and returns its `runId`. */
export function recordPendingDevelopmentRun(
  run: Omit<PendingDevelopmentRun, "runId">,
): string {
  const runId = randomUUID();
  const state = loadState();
  state[runId] = { ...run, runId };
  saveState(state);
  return runId;
}

/** Removes a pending run once its result has been delivered (or explicitly
 * given up on). No-op if it is already gone — callers don't need to guard. */
export function removePendingDevelopmentRun(runId: string): void {
  const state = loadState();
  if (!(runId in state)) return;
  delete state[runId];
  saveState(state);
}

/**
 * Increments and persists the failed-delivery counter for a pending run
 * whose result post or interruption notice threw (API error, connector
 * exception, etc.) — so a delivery failure keeps the record for the next
 * sweep to retry instead of the reconciler discarding it outright. Callers
 * are expected to give up (remove the record) once the returned count
 * reaches their retry cap.
 *
 * Returns the new attempt count, or `null` if the run is no longer pending
 * (e.g. delivered by a racing sweep in between) — callers should treat
 * `null` as "nothing to do".
 */
export function recordDeliveryFailure(runId: string): number | null {
  const state = loadState();
  const run = state[runId];
  if (!run) return null;
  const attempts = (run.deliveryAttempts ?? 0) + 1;
  state[runId] = { ...run, deliveryAttempts: attempts };
  saveState(state);
  return attempts;
}

/** All currently-pending runs, oldest first. Never throws — a corrupt or
 * missing state file just means there is nothing to reconcile. */
export function listPendingDevelopmentRuns(): PendingDevelopmentRun[] {
  return Object.values(loadState()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
