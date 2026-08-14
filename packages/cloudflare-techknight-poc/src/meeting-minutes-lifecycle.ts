import type { MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import type { MeetingMinutesRuntimeConfig } from "./meeting-minutes-entrypoints.js";
import { processMeetingMinutesSelection } from "./meeting-minutes-entrypoints.js";
import { loadMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { ResumeMeetingMinutesOptions } from "./meeting-minutes-pipeline.js";
import type { WorkspaceFs } from "./workspace-store.js";

export interface MeetingMinutesStatusProjectionOptions {
  updateStatus(run: MeetingMinutesRun, outcome: "completed" | "failed"): Promise<void>;
  logProjectionError?(entry: { runId: string; outcome: "completed" | "failed"; error: string }): void;
}

function logProjectionError(run: MeetingMinutesRun, outcome: "completed" | "failed", error: unknown,
  options: MeetingMinutesStatusProjectionOptions): void {
  options.logProjectionError?.({ runId: run.runId, outcome,
    error: error instanceof Error ? error.message : "unexpected_error" });
}

async function projectCompleted(run: MeetingMinutesRun, options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  try {
    await options.updateStatus(run, "completed");
  } catch (error) {
    logProjectionError(run, "completed", error, options);
    if (error instanceof Error && error.message === "meeting_minutes_status_coordinates_missing") return;
    throw error;
  }
}

async function projectFailed(run: MeetingMinutesRun | undefined, options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  if (!run) return;
  try {
    await options.updateStatus(run, "failed");
  } catch (error) {
    logProjectionError(run, "failed", error, options);
  }
}

export async function processMeetingMinutesSelectionWithStatus(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  config: MeetingMinutesRuntimeConfig, resume: Omit<ResumeMeetingMinutesOptions, "destinations">,
  projection: MeetingMinutesStatusProjectionOptions): Promise<MeetingMinutesRun> {
  let run: MeetingMinutesRun;
  try {
    run = await processMeetingMinutesSelection(fs, selection, config, resume);
  } catch (error) {
    await projectFailed(await loadMeetingMinutesRun(fs, selection.runId), projection);
    throw error;
  }
  await projectCompleted(run, projection);
  return run;
}
