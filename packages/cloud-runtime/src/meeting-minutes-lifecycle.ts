import type { MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import type { MeetingMinutesRuntimeConfig } from "./meeting-minutes-entrypoints.js";
import { processMeetingMinutesSelection } from "./meeting-minutes-entrypoints.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { ResumeMeetingMinutesOptions } from "./meeting-minutes-pipeline.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { classifyMeetingMinutesFailure, meetingMinutesFailureLog } from "./meeting-minutes-diagnostics.js";
import { buildMeetingMinutesRunReceipt, classifyMeetingMinutesRunReceiptFailure,
  type ConfirmedRunReceiptDelivery, type RunReceiptV1 } from "./meeting-minutes-run-receipt.js";

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
  /** Source-owned delivery. Brainbase validates and projects receipts; Mana never closes an OutcomeCase. */
  emitRunReceipt?(receipt: RunReceiptV1): Promise<ConfirmedRunReceiptDelivery>;
}

/**
 * Builds the clean view used by the operator-only status repair command.
 *
 * A projection failure is not a processing failure: the generated minutes and
 * their delivery remain authoritative. Legacy runs may have copied that final
 * projection error into `failure`/`diagnostics`, so accept those only when the
 * durable output checkpoints prove that processing reached completion.
 */
export function meetingMinutesCompletedProjectionRepair(
  run: MeetingMinutesRun | undefined,
  source: { channelId: string; threadTs: string },
): MeetingMinutesRun | undefined {
  if (!run || run.sourceChannelId !== source.channelId || run.sourceThreadTs !== source.threadTs
    || !run.destination || !run.generated || !run.github || !run.slack?.processingTs || !run.slack.parentTs) return undefined;
  const legacyProjectionOnlyFailure = run.status === "failed"
    && run.failure?.stage === "completed"
    && run.diagnostics?.stage === "status_projection"
    && run.diagnostics.code === "STATUS_PROJECTION_FAILED";
  if (run.status !== "completed" && !legacyProjectionOnlyFailure) return undefined;
  if (run.taskRegistration?.pending || run.taskRegistration?.failure) return undefined;
  const repaired: MeetingMinutesRun = { ...run, status: "completed" };
  delete repaired.failure;
  delete repaired.diagnostics;
  const { generation, receiptSnapshot, checkpoint } = run.diagnostics ?? {};
  if (generation || receiptSnapshot || checkpoint) {
    repaired.diagnostics = { schemaVersion: "meeting_minutes_diagnostics.v1",
      ...(generation ? { generation: structuredClone(generation) } : {}),
      ...(receiptSnapshot ? { receiptSnapshot: structuredClone(receiptSnapshot) } : {}),
      ...(checkpoint ? { checkpoint: structuredClone(checkpoint) } : {}) };
  }
  delete repaired.projectionFailure;
  return repaired;
}

/**
 * Repairs the source status projection after the durable output checkpoints
 * prove completion. The external status update is attempted before the
 * repaired state is persisted, so a display or persistence failure leaves the
 * original durable run available for a safe retry.
 */
export async function repairMeetingMinutesCompletedProjection(
  fs: WorkspaceFs,
  run: MeetingMinutesRun | undefined,
  source: { channelId: string; threadTs: string },
  updateStatus: (run: MeetingMinutesRun) => Promise<void>,
): Promise<MeetingMinutesRun | undefined> {
  const repaired = meetingMinutesCompletedProjectionRepair(run, source);
  if (!repaired) return undefined;
  await updateStatus(repaired);
  await recordProjectionSuccess(fs, repaired, "completed");
  return repaired;
}

async function recordProjectionFailure(fs: WorkspaceFs, run: MeetingMinutesRun,
  outcome: "completed" | "failed", error: unknown, options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  const classified = classifyMeetingMinutesFailure("status_projection", error);
  delete run.statusProjection;
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

async function recordProjectionSuccess(fs: WorkspaceFs, run: MeetingMinutesRun,
  outcome: "completed" | "failed"): Promise<void> {
  delete run.projectionFailure;
  const projectedAt = new Date().toISOString();
  run.statusProjection = { outcome, projectedAt };
  run.updatedAt = projectedAt;
  await saveMeetingMinutesRun(fs, run);
}

async function recordRunReceiptFailure(fs: WorkspaceFs, run: MeetingMinutesRun, error: unknown): Promise<void> {
  if (!run.runReceipt) return;
  const failure = classifyMeetingMinutesRunReceiptFailure(error);
  const failedAt = new Date().toISOString();
  run.runReceipt = { ...run.runReceipt, failure: { ...failure, failedAt } };
  run.updatedAt = failedAt;
  await saveMeetingMinutesRun(fs, run);
}

/**
 * Retries only the immutable Brainbase RunReceipt boundary.  This deliberately
 * does not re-enter selection, generation, Slack, GitHub, or task-board work.
 * The caller must have already authorized the saved run and receipt identity.
 */
export async function retryMeetingMinutesRunReceipt(
  fs: WorkspaceFs,
  run: MeetingMinutesRun,
  emitRunReceipt: (receipt: RunReceiptV1) => Promise<ConfirmedRunReceiptDelivery>,
): Promise<MeetingMinutesRun | undefined> {
  const receipt = await buildMeetingMinutesRunReceipt(run);
  if (!receipt || run.runReceipt?.status !== "pending" ||
    run.runReceipt.idempotencyKey !== receipt.delivery.idempotency_key) return undefined;

  // Persist the exact retry identity before crossing the Brainbase boundary.
  // Keep the prior safe diagnostic until confirmed delivery replaces it.
  run.runReceipt = { ...run.runReceipt, caseId: run.outcomeCaseId,
    idempotencyKey: receipt.delivery.idempotency_key, status: "pending" };
  run.updatedAt = new Date().toISOString();
  await saveMeetingMinutesRun(fs, run);
  let delivered: ConfirmedRunReceiptDelivery;
  try {
    delivered = await emitRunReceipt(receipt);
  } catch (error) {
    await recordRunReceiptFailure(fs, run, error);
    throw error;
  }
  const deliveredAt = new Date().toISOString();
  run.runReceipt = { ...run.runReceipt, receiptId: delivered.receiptId, status: "delivered", deliveredAt };
  delete run.runReceipt.failure;
  run.updatedAt = deliveredAt;
  await saveMeetingMinutesRun(fs, run);
  return run;
}

async function projectCompleted(fs: WorkspaceFs, run: MeetingMinutesRun,
  options: MeetingMinutesStatusProjectionOptions): Promise<void> {
  // A previous terminal-display failure is retry metadata, not a current
  // processing failure. Render and read back the clean completed state; if
  // this attempt fails, recordProjectionFailure below replaces it with the
  // new failure before the run is persisted.
  delete run.projectionFailure;
  try {
    await options.updateStatus(run, "completed");
    await recordProjectionSuccess(fs, run, "completed");
  } catch (error) {
    await recordProjectionFailure(fs, run, "completed", error, options);
    if (error instanceof Error && error.message === "meeting_minutes_status_coordinates_missing") return;
    throw error;
  }

  // Receipt delivery is deliberately outside the status-projection catch. A
  // transient Brainbase ingest failure must leave the confirmed Slack status
  // intact so #708 retries only this terminal step rather than reclassifying a
  // completed run as a source-status failure.
  const receipt = await buildMeetingMinutesRunReceipt(run);
  if (!receipt || run.runReceipt?.status === "delivered") return;
  run.runReceipt = { caseId: run.outcomeCaseId, idempotencyKey: receipt.delivery.idempotency_key, status: "pending" };
  run.updatedAt = new Date().toISOString();
  await saveMeetingMinutesRun(fs, run);
  if (!options.emitRunReceipt) return;
  let delivered: ConfirmedRunReceiptDelivery;
  try {
    delivered = await options.emitRunReceipt(receipt);
  } catch (error) {
    const message = error instanceof Error && /^meeting_minutes_run_receipt_[a-z0-9_:.-]+$/u.test(error.message)
      ? error.message : "meeting_minutes_run_receipt_delivery_failed";
    console.error(JSON.stringify({ event: "meeting_minutes_run_receipt_delivery_failed",
      runId: run.runId, code: message }));
    await recordRunReceiptFailure(fs, run, error);
    throw error;
  }
  const deliveredAt = new Date().toISOString();
  run.runReceipt = { ...run.runReceipt, receiptId: delivered.receiptId, status: "delivered", deliveredAt };
  delete run.runReceipt.failure;
  run.updatedAt = deliveredAt;
  await saveMeetingMinutesRun(fs, run);
}

async function projectFailed(fs: WorkspaceFs, run: MeetingMinutesRun | undefined,
  options: MeetingMinutesStatusProjectionOptions): Promise<boolean> {
  if (!run) return false;
  try {
    await options.updateStatus(run, "failed");
    await recordProjectionSuccess(fs, run, "failed");
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
  const completedAt = new Date().toISOString();
  run.processing = { completedActionTs: selection.actionTs, completedAt };
  run.updatedAt = completedAt;
  await saveMeetingMinutesRun(fs, run);
  await projectCompleted(fs, run, projection);
  return run;
}
