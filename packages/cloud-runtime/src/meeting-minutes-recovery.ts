import type { MeetingMinutesRecovery, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { classifyMeetingMinutesFailure } from "./meeting-minutes-diagnostics.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { WorkspaceFs } from "./workspace-store.js";

export const MEETING_MINUTES_RECOVERY_DELAY_SECONDS = 20 * 60;
const MEETING_MINUTES_RECOVERY_OUTCOME_SAVE_ATTEMPTS = 2;

export class MeetingMinutesRecoveryOutcomePersistenceError extends Error {
  readonly code = "MEETING_MINUTES_RECOVERY_OUTCOME_PERSIST_FAILED";

  constructor() {
    super("meeting_minutes_recovery_outcome_persist_failed");
    this.name = "MeetingMinutesRecoveryOutcomePersistenceError";
  }
}

async function saveRecoveryOutcome(fs: WorkspaceFs, run: MeetingMinutesRun): Promise<void> {
  for (let attempt = 1; attempt <= MEETING_MINUTES_RECOVERY_OUTCOME_SAVE_ATTEMPTS; attempt += 1) {
    try {
      await saveMeetingMinutesRun(fs, run);
      return;
    } catch {
      // A single bounded retry covers a transient storage write failure without
      // re-running the already claimed Slack fallback.
    }
  }
  console.error(JSON.stringify({
    event: "meeting_minutes_recovery_outcome_save_failed",
    runId: run.runId,
    stage: "status_projection",
    code: "MEETING_MINUTES_RECOVERY_OUTCOME_PERSIST_FAILED",
    retryable: true,
    attempts: MEETING_MINUTES_RECOVERY_OUTCOME_SAVE_ATTEMPTS,
  }));
  throw new MeetingMinutesRecoveryOutcomePersistenceError();
}

export function isMeetingMinutesRecovery(value: unknown): value is MeetingMinutesRecovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MeetingMinutesRecovery>;
  return candidate.kind === "meeting_minutes_recovery" && typeof candidate.runId === "string" &&
    typeof candidate.workspaceId === "string" && typeof candidate.appId === "string" &&
    typeof candidate.channelId === "string" &&
    typeof candidate.threadTs === "string" && typeof candidate.userId === "string" &&
    typeof candidate.actionTs === "string";
}

export async function armMeetingMinutesRecovery(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  now = Date.now()): Promise<{ event: MeetingMinutesRecovery; delaySeconds: number; terminal: boolean }> {
  const run = await loadMeetingMinutesRun(fs, selection.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (!run.sourceAppId || run.workspaceId !== selection.workspaceId || run.sourceAppId !== selection.appId ||
    run.sourceChannelId !== selection.channelId || run.sourceThreadTs !== selection.threadTs) {
    throw new Error("meeting_minutes_recovery_boundary_mismatch");
  }
  if (run.status === "completed") {
    return { event: { kind: "meeting_minutes_recovery", runId: run.runId,
      workspaceId: run.workspaceId, appId: run.sourceAppId,
      channelId: selection.channelId, threadTs: selection.threadTs,
      userId: selection.userId, actionTs: selection.actionTs }, delaySeconds: 0, terminal: true };
  }
  if (run.lifecycle?.actionTs !== selection.actionTs) {
    run.lifecycle = { actionTs: selection.actionTs,
      deadlineAt: new Date(now + MEETING_MINUTES_RECOVERY_DELAY_SECONDS * 1_000).toISOString() };
    run.updatedAt = new Date(now).toISOString();
    await saveMeetingMinutesRun(fs, run);
  }
  if (run.lifecycle.recoveryProjectedAt || run.lifecycle.recoveryProjectionClaimedAt ||
    run.lifecycle.recoveryProjectionAttemptedAt) {
    return { event: { kind: "meeting_minutes_recovery", runId: run.runId,
      workspaceId: run.workspaceId, appId: run.sourceAppId,
      channelId: selection.channelId, threadTs: selection.threadTs,
      userId: selection.userId, actionTs: selection.actionTs }, delaySeconds: 0, terminal: true };
  }
  const deadline = Date.parse(run.lifecycle.deadlineAt);
  const delaySeconds = Math.max(1, Math.ceil((deadline - now) / 1_000));
  return { event: { kind: "meeting_minutes_recovery", runId: run.runId,
    workspaceId: run.workspaceId, appId: run.sourceAppId,
    channelId: selection.channelId, threadTs: selection.threadTs,
    userId: selection.userId, actionTs: selection.actionTs }, delaySeconds, terminal: false };
}

export interface MeetingMinutesRecoveryOptions {
  now?: () => number;
  updateStatus(run: MeetingMinutesRun, outcome: "failed"): Promise<void>;
  /** One-shot fallback; it must not call updateStatus or re-enter recovery. */
  fallbackStatus?(run: MeetingMinutesRun, outcome: "failed",
    failure: NonNullable<MeetingMinutesRun["projectionFailure"]>): Promise<void>;
}

export async function recoverStaleMeetingMinutesRun(fs: WorkspaceFs, event: MeetingMinutesRecovery,
  options: MeetingMinutesRecoveryOptions): Promise<"recovered" | "terminal" | "superseded" | "not_due"> {
  const run = await loadMeetingMinutesRun(fs, event.runId);
  if (!run) return "terminal";
  if (run.lifecycle?.actionTs !== event.actionTs) return "superseded";
  if (run.status === "completed" || run.lifecycle.recoveryProjectedAt ||
    run.lifecycle.recoveryProjectionClaimedAt || run.lifecycle.recoveryProjectionAttemptedAt) return "terminal";
  const now = options.now?.() ?? Date.now();
  if (Date.parse(run.lifecycle.deadlineAt) > now) return "not_due";
  if (run.status !== "failed") {
    const failedStage = run.status;
    run.status = "failed";
    run.failure = { stage: failedStage, message: "meeting_minutes_processing_interrupted" };
  }
  run.lifecycle.recoveredAt ??= new Date(now).toISOString();
  run.updatedAt = new Date(now).toISOString();
  await saveMeetingMinutesRun(fs, run);
  // Claim before the external Slack projection. If the final completion save
  // fails after Slack accepted the update, redelivery must not project again.
  const projectionClaimedAt = new Date(now).toISOString();
  run.lifecycle.recoveryProjectionClaimedAt = projectionClaimedAt;
  run.updatedAt = projectionClaimedAt;
  try { await saveMeetingMinutesRun(fs, run); }
  catch {
    console.error(JSON.stringify({ event: "meeting_minutes_recovery_projection_claim_save_failed",
      runId: run.runId, stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true }));
    throw new Error("meeting_minutes_recovery_projection_claim_save_failed");
  }
  try {
    await options.updateStatus(run, "failed");
  } catch (error) {
    const classified = classifyMeetingMinutesFailure("status_projection", error);
    const projectionFailedAt = new Date().toISOString();
    run.projectionFailure = { stage: "status_projection", code: classified.code!, retryable: classified.retryable!,
      failedAt: projectionFailedAt };
    // Retain the failed projection marker separately for the one-shot fallback
    // diagnostics. The pre-projection claim above is already durable.
    run.lifecycle.recoveryProjectionAttemptedAt = projectionFailedAt;
    run.updatedAt = run.projectionFailure.failedAt;
    try { await saveMeetingMinutesRun(fs, run); }
    catch {
      console.error(JSON.stringify({ event: "meeting_minutes_recovery_projection_marker_save_failed",
        runId: run.runId, stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true }));
      // The projection claim is already durable. Continue to the bounded
      // fallback in this delivery so a diagnostics write outage does not
      // strand the failed run without its one-shot user-visible result.
    }
    let fallbackCompleted = false;
    if (options.fallbackStatus) {
      try {
        await options.fallbackStatus(run, "failed", run.projectionFailure);
        fallbackCompleted = true;
      } catch {
        console.error(JSON.stringify({ event: "meeting_minutes_recovery_status_projection_fallback_failed",
          runId: run.runId, outcome: "failed", stage: "status_projection",
          code: "STATUS_PROJECTION_FAILED", retryable: true }));
      }
    }
    run.lifecycle.recoveryFallbackOutcome = fallbackCompleted ? "succeeded" : "failed";
    if (fallbackCompleted) run.lifecycle.recoveryProjectedAt = projectionFailedAt;
    run.updatedAt = new Date().toISOString();
    // The claim marker makes redelivery terminal, so the fallback result must
    // be durable before returning the original projection error. If storage is
    // still unavailable after the bounded retry, surface an operational error
    // rather than acknowledging an outcome that was not persisted.
    await saveRecoveryOutcome(fs, run);
    throw error;
  }
  run.lifecycle.recoveryProjectedAt = new Date(now).toISOString();
  run.updatedAt = new Date(now).toISOString();
  await saveMeetingMinutesRun(fs, run);
  return "recovered";
}
