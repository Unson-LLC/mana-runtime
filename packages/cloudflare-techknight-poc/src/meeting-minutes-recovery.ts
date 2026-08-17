import type { MeetingMinutesRecovery, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
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
}

export async function recoverStaleMeetingMinutesRun(fs: WorkspaceFs, event: MeetingMinutesRecovery,
  options: MeetingMinutesRecoveryOptions): Promise<"recovered" | "terminal" | "superseded" | "not_due"> {
  const run = await loadMeetingMinutesRun(fs, event.runId);
  if (!run) return "terminal";
  if (run.lifecycle?.actionTs !== event.actionTs) return "superseded";
  if (run.status === "completed" || run.lifecycle.recoveryProjectedAt) return "terminal";
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
  await options.updateStatus(run, "failed");
  run.lifecycle.recoveryProjectedAt = new Date(now).toISOString();
  run.updatedAt = new Date(now).toISOString();
  await saveMeetingMinutesRun(fs, run);
  return "recovered";
}
