import type { MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import type { MeetingMinutesRuntimeConfig } from "./meeting-minutes-entrypoints.js";
import { processMeetingMinutesSelection } from "./meeting-minutes-entrypoints.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { ResumeMeetingMinutesOptions } from "./meeting-minutes-pipeline.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { classifyMeetingMinutesFailure, meetingMinutesFailureLog } from "./meeting-minutes-diagnostics.js";

export interface MeetingMinutesStatusProjectionOptions {
  updateStatus(run: MeetingMinutesRun, outcome: "completed" | "failed"): Promise<void>;
  /**
   * One-shot fallback for the original status message. Implementations must not
   * call updateStatus again; a rejected fallback is recorded and never retried
   * recursively by this lifecycle helper.
   */
  fallbackStatus?(run: MeetingMinutesRun, outcome: "completed" | "failed",
    failure: NonNullable<MeetingMinutesRun["projectionFailure"]>): Promise<void>;
  logProjectionError?(entry: { runId: string; outcome: "completed" | "failed"; stage: string;
    code: string; retryable: boolean; receipt?: unknown; checkpoint?: unknown }): void;
}

async function recordProjectionFailure(fs: WorkspaceFs, run: MeetingMinutesRun,
  outcome: "completed" | "failed", error: unknown, options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  const classified = classifyMeetingMinutesFailure("status_projection", error);
  run.projectionFailure = { stage: "status_projection", code: classified.code!, retryable: classified.retryable!,
    failedAt: new Date().toISOString() };
  run.updatedAt = run.projectionFailure.failedAt;
  await saveMeetingMinutesRun(fs, run);
  options.logProjectionError?.({ outcome, ...meetingMinutesFailureLog(run) });
  if (options.fallbackStatus) {
    try {
      await options.fallbackStatus(run, outcome, run.projectionFailure);
    } catch {
      console.error(JSON.stringify({ event: "meeting_minutes_status_projection_fallback_failed", runId: run.runId,
        outcome, stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true }));
    }
  }
}

async function clearProjectionFailure(fs: WorkspaceFs, run: MeetingMinutesRun): Promise<void> {
  if (!run.projectionFailure) return;
  delete run.projectionFailure;
  run.updatedAt = new Date().toISOString();
  await saveMeetingMinutesRun(fs, run);
}

async function projectCompleted(fs: WorkspaceFs, run: MeetingMinutesRun,
  options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  try {
    await options.updateStatus(run, "completed");
    await clearProjectionFailure(fs, run);
  } catch (error) {
    await recordProjectionFailure(fs, run, "completed", error, options);
    if (error instanceof Error && error.message === "meeting_minutes_status_coordinates_missing") return;
    throw error;
  }
}

async function projectFailed(fs: WorkspaceFs, run: MeetingMinutesRun | undefined,
  options: MeetingMinutesStatusProjectionOptions): Promise<boolean> {
  if (!run) return false;
  try {
    await options.updateStatus(run, "failed");
    await clearProjectionFailure(fs, run);
    return true;
  } catch (error) {
    await recordProjectionFailure(fs, run, "failed", error, options);
    return false;
  }
}

export async function processMeetingMinutesSelectionWithStatus(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  config: MeetingMinutesRuntimeConfig, resume: Omit<ResumeMeetingMinutesOptions, "destinations">,
  projection: MeetingMinutesStatusProjectionOptions): Promise<MeetingMinutesRun> {
  let run: MeetingMinutesRun;
  try {
    run = await processMeetingMinutesSelection(fs, selection, config, resume);
  } catch (error) {
    const failed = await loadMeetingMinutesRun(fs, selection.runId);
    if (await projectFailed(fs, failed, projection) && failed?.lifecycle) {
      failed.lifecycle.recoveryProjectedAt = new Date().toISOString();
      failed.updatedAt = failed.lifecycle.recoveryProjectedAt;
      await saveMeetingMinutesRun(fs, failed);
    }
    throw error;
  }
  await projectCompleted(fs, run, projection);
  return run;
}
