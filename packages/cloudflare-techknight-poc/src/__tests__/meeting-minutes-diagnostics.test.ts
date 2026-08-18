import { classifyMeetingMinutesFailure, meetingMinutesFailureLog,
  meetingMinutesReceiptSnapshot } from "../meeting-minutes-diagnostics.js";
import type { MeetingMinutesContextReceipt, MeetingMinutesRun } from "../meeting-minutes-contracts.js";

describe("meeting minutes diagnostics", () => {
  it("bounds and sanitizes Receipt errors without persisting raw messages", () => {
    const receipt = { schema_version: "meeting_minutes_context_receipt.v1", receipt_id: "receipt-1",
      identity: { run_id: "run-1", project_code: "mana", transcript_sha256: "hash" }, status: "partial",
      checksum: "checksum", resolved_at: "2026-08-18T00:00:00.000Z", context: { source_refs: [], open_tasks: [] },
      errors: [
        { code: "graph_timeout", message: "Authorization: Bearer secret" },
        { code: "BEARER_SECRET_VALUE", message: "raw response" },
        ...Array.from({ length: 10 }, (_, index) => ({ code: `safe_${index}` })),
      ] } satisfies MeetingMinutesContextReceipt;

    const snapshot = meetingMinutesReceiptSnapshot(receipt);

    expect(snapshot).toMatchObject({ receiptId: "receipt-1", status: "partial" });
    expect(snapshot.errorCodes).toEqual(["GRAPH_TIMEOUT"]);
    expect(snapshot.errorCodes).not.toContain("BEARER_SECRET_VALUE");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(snapshot)).not.toContain("raw response");
  });

  it("classifies context HTTP failures into stable safe codes", () => {
    expect(classifyMeetingMinutesFailure("context_resolve",
      new Error("meeting_minutes_context_request_failed:401")))
      .toEqual({ stage: "context_resolve", code: "CONTEXT_AUTHENTICATION_FAILED", retryable: false });
    expect(classifyMeetingMinutesFailure("context_resolve", new Error("upstream body with token")))
      .toEqual({ stage: "context_resolve", code: "CONTEXT_RESOLVE_FAILED", retryable: true });
  });

  it.each([
    [new Error("meeting_minutes_context_request_failed:500"), "CONTEXT_UPSTREAM_FAILED", true],
    [new DOMException("timed out", "TimeoutError"), "CONTEXT_TIMEOUT", true],
    [new Error("meeting_minutes_context_redirect_rejected"), "CONTEXT_REDIRECT_REJECTED", false],
    [new Error("meeting_minutes_context_invalid_response"), "CONTEXT_INVALID_RESPONSE", true],
    [new Error("meeting_minutes_context_invalid_receipt"), "CONTEXT_INVALID_RECEIPT", false],
    [new Error("meeting_minutes_context_client_unconfigured"), "CONTEXT_CLIENT_UNCONFIGURED", false],
    [new Error("meeting_minutes_context_identity_mismatch"), "CONTEXT_IDENTITY_MISMATCH", false],
  ] as const)("classifies context boundary %s", (error, code, retryable) => {
    expect(classifyMeetingMinutesFailure("context_resolve", error))
      .toEqual({ stage: "context_resolve", code, retryable });
  });

  it.each([
    [Object.assign(new Error("raw 401 response"), { status: 401 }), "TASK_AUTHENTICATION_FAILED"],
    [Object.assign(new Error("raw 403 response"), { status: 403 }), "TASK_PROJECT_FORBIDDEN"],
    [Object.assign(new Error("raw config response"), { code: "project_code_not_allowed" }),
      "TASK_PROJECT_CODE_NOT_ALLOWED"],
    [Object.assign(new Error("raw config response"), { code: "task_scope_not_configured" }),
      "TASK_SCOPE_NOT_CONFIGURED"],
    [new Error("project_code_not_allowed"), "TASK_PROJECT_CODE_NOT_ALLOWED"],
    [new Error("task_scope_not_configured"), "TASK_SCOPE_NOT_CONFIGURED"],
  ])("classifies permanent Task API failure without exposing its message", (error, code) => {
    expect(classifyMeetingMinutesFailure("task_registration", error))
      .toEqual({ stage: "task_registration", code, retryable: false });
  });

  it("builds a same-run structured log without the raw failure message", () => {
    const run = { version: 1, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
      sourceThreadTs: "1", sourceMessageTs: "1", file: { id: "F1", name: "m.txt" }, status: "failed",
      failure: { stage: "routed", message: "Authorization: Bearer secret" }, diagnostics: {
        schemaVersion: "meeting_minutes_diagnostics.v1", stage: "generation", code: "GENERATION_FAILED",
        retryable: true, failedAt: "2026-08-18T00:00:00.000Z" },
      createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } as MeetingMinutesRun;

    const entry = meetingMinutesFailureLog(run);

    expect(entry).toMatchObject({ runId: "run-1", stage: "generation", code: "GENERATION_FAILED" });
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("logs safe Task API coordinates without exposing the upstream message", () => {
    const run = { version: 1, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
      sourceThreadTs: "1", sourceMessageTs: "1", file: { id: "F1", name: "m.txt" }, status: "completed",
      taskRegistration: { registered: [], failure: { index: 3, stage: "task_registration",
        status: 403, code: "project_code_not_allowed", message: "Authorization: Bearer secret",
        failedAt: "2026-08-18T00:00:00.000Z" } },
      diagnostics: { schemaVersion: "meeting_minutes_diagnostics.v1", stage: "task_registration",
        code: "TASK_PROJECT_CODE_NOT_ALLOWED", retryable: false, failedAt: "2026-08-18T00:00:00.000Z" },
      createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } as MeetingMinutesRun;

    const entry = meetingMinutesFailureLog(run);

    expect(entry).toMatchObject({ taskFailure: { index: 3, status: 403, code: "project_code_not_allowed" } });
    expect(JSON.stringify(entry)).not.toContain("secret");
  });
});
