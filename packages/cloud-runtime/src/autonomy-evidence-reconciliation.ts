import type { AutonomyRunEvidence } from "./autonomy-run-history.js";

export interface AutonomyCompletedWrite {
  callIndex: number;
  taskId: string;
  receiptId: string;
}

export interface AutonomyEvidenceInput {
  outcomeCode?: string;
  reportedEvidence?: readonly AutonomyRunEvidence[];
  completedWrites?: readonly AutonomyCompletedWrite[];
}

export interface AutonomyReconciledEvidence {
  outcomeCode: string;
  evidence: AutonomyRunEvidence[];
}

export class AutonomyEvidenceReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutonomyEvidenceReconciliationError";
  }
}

function fail(): never {
  throw new AutonomyEvidenceReconciliationError("autonomy_evidence_mismatch");
}

function boundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 500
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function reconcileAutonomyRunEvidence(
  input: AutonomyEvidenceInput,
): AutonomyReconciledEvidence {
  const outcomeCode = input.outcomeCode;
  if (!boundedId(outcomeCode)) fail();
  const reported = [...(input.reportedEvidence ?? [])];
  const completed = [...(input.completedWrites ?? [])];
  if (reported.length > 40 || completed.length > 3) fail();

  for (const item of reported) {
    if (!item || !["task", "receipt", "artifact", "run"].includes(item.kind)
      || !boundedId(item.id)) fail();
  }
  const callIndexes = completed.map((item) => item.callIndex);
  if (completed.some((item) => !Number.isInteger(item.callIndex)
    || item.callIndex < 1 || item.callIndex > 3
    || !boundedId(item.taskId) || !boundedId(item.receiptId))
    || new Set(callIndexes).size !== callIndexes.length) fail();

  const reportedTaskIds = uniqueSorted(
    reported.filter((item) => item.kind === "task").map((item) => item.id),
  );
  const completedTaskIds = uniqueSorted(completed.map((item) => item.taskId));
  const completedReceiptIds = uniqueSorted(completed.map((item) => item.receiptId));
  if (completedTaskIds.length !== completed.length || completedReceiptIds.length !== completed.length) fail();

  if (outcomeCode === "autonomy_task_written") {
    if (completed.length === 0 || !sameStrings(reportedTaskIds, completedTaskIds)) fail();
  } else if (outcomeCode === "autonomy_no_action" || outcomeCode === "autonomy_escalation_required") {
    if (completed.length !== 0 || reportedTaskIds.length !== 0) fail();
  } else {
    // Unknown outcome contracts never gain write success by fallback.
    if (completed.length !== 0 || reportedTaskIds.length !== 0) fail();
  }

  const nonWriteEvidence = reported.filter((item) => item.kind !== "task" && item.kind !== "receipt");
  const evidence: AutonomyRunEvidence[] = [
    ...completedTaskIds.map((id) => ({ kind: "task" as const, id })),
    ...completedReceiptIds.map((id) => ({ kind: "receipt" as const, id })),
    ...nonWriteEvidence,
  ];
  const seen = new Set<string>();
  return {
    outcomeCode,
    evidence: evidence.filter((item) => {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}
