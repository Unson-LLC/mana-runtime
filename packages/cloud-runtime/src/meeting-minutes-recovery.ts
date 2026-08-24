import type { MeetingMinutesRecovery, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { classifyMeetingMinutesFailure } from "./meeting-minutes-diagnostics.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { WorkspaceFs } from "./workspace-store.js";

export const MEETING_MINUTES_RECOVERY_DELAY_SECONDS = 20 * 60;

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
  if (run.lifecycle.recoveryProjectedAt || run.lifecycle.recoveryProjectionAttemptedAt) {
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
    run.lifecycle.recoveryProjectionAttemptedAt) return "terminal";
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
  try {
    await options.updateStatus(run, "failed");
  } catch (error) {
    const classified = classifyMeetingMinutesFailure("status_projection", error);
    const projectionFailedAt = new Date().toISOString();
    run.projectionFailure = { stage: "status_projection", code: classified.code!, retryable: classified.retryable!,
      failedAt: projectionFailedAt };
    // Claim the recovery projection before invoking the one-shot fallback. The
    // Durable Object serializes deliveries for this workspace, while this
    // persisted marker is the cross-delivery claim. If it cannot be written,
    // fail the delivery before invoking fallback so Queue retries instead of
    // creating an unclaimed Slack side effect.
    run.lifecycle.recoveryProjectionAttemptedAt = projectionFailedAt;
    run.updatedAt = run.projectionFailure.failedAt;
    try { await saveMeetingMinutesRun(fs, run); }
    catch {
      console.error(JSON.stringify({ event: "meeting_minutes_recovery_projection_marker_save_failed",
        runId: run.runId, stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true }));
      // Preserve the original projection failure as the Queue retry signal;
      // there is no fallback until the claim is durable.
      throw error;
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
    if (fallbackCompleted) run.lifecycle.recoveryProjectedAt = projectionFailedAt;
    run.updatedAt = new Date().toISOString();
    // The original processing/projection error remains the retry signal even
    // if this bookkeeping save cannot be completed.
    try { await saveMeetingMinutesRun(fs, run); }
    catch { console.error(JSON.stringify({ event: "meeting_minutes_recovery_projection_marker_save_failed",
      runId: run.runId, stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true })); }
    throw error;
  }
  run.lifecycle.recoveryProjectedAt = new Date(now).toISOString();
  run.updatedAt = new Date(now).toISOString();
  await saveMeetingMinutesRun(fs, run);
  return "recovered";
}
