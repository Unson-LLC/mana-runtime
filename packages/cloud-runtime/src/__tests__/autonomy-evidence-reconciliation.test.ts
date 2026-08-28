import { describe, expect, it } from "vitest";

import { reconcileAutonomyRunEvidence } from "../autonomy-evidence-reconciliation.js";

describe("autonomy evidence reconciliation", () => {
  it("accepts task_written only when completed write receipts exactly cover reported task IDs", () => {
    expect(reconcileAutonomyRunEvidence({
      outcomeCode: "autonomy_task_written",
      reportedEvidence: [{ kind: "task", id: "task-1" }],
      completedWrites: [{ callIndex: 1, taskId: "task-1", receiptId: "receipt-1" }],
    })).toEqual({
      outcomeCode: "autonomy_task_written",
      evidence: [
        { kind: "task", id: "task-1" },
        { kind: "receipt", id: "receipt-1" },
      ],
    });
  });

  it("fails closed on fabricated, missing, duplicate or extra task evidence", () => {
    const cases = [
      {
        reportedEvidence: [{ kind: "task" as const, id: "task-other" }],
        completedWrites: [{ callIndex: 1, taskId: "task-1", receiptId: "receipt-1" }],
      },
      {
        reportedEvidence: [],
        completedWrites: [{ callIndex: 1, taskId: "task-1", receiptId: "receipt-1" }],
      },
      {
        reportedEvidence: [{ kind: "task" as const, id: "task-1" }],
        completedWrites: [],
      },
      {
        reportedEvidence: [{ kind: "task" as const, id: "task-1" }],
        completedWrites: [
          { callIndex: 1, taskId: "task-1", receiptId: "receipt-1" },
          { callIndex: 2, taskId: "task-2", receiptId: "receipt-2" },
        ],
      },
    ];
    for (const value of cases) {
      expect(() => reconcileAutonomyRunEvidence({
        outcomeCode: "autonomy_task_written",
        ...value,
      })).toThrowError(expect.objectContaining({ code: "autonomy_evidence_mismatch" }));
    }
  });

  it("accepts no_action only when no completed write exists", () => {
    expect(reconcileAutonomyRunEvidence({
      outcomeCode: "autonomy_no_action",
      reportedEvidence: [],
      completedWrites: [],
    })).toEqual({ outcomeCode: "autonomy_no_action", evidence: [] });
    expect(() => reconcileAutonomyRunEvidence({
      outcomeCode: "autonomy_no_action",
      reportedEvidence: [],
      completedWrites: [{ callIndex: 1, taskId: "task-1", receiptId: "receipt-1" }],
    })).toThrowError(expect.objectContaining({ code: "autonomy_evidence_mismatch" }));
  });
});
