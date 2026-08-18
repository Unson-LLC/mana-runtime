import type { MeetingMinutesContextReceipt, MeetingMinutesDiagnosticStage, MeetingMinutesDiagnostics,
  MeetingMinutesRun } from "./meeting-minutes-contracts.js";

const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_ERROR_CODES = new Set([
  "GRAPH_TIMEOUT", "GRAPH_UNAVAILABLE", "SOURCE_UNAVAILABLE", "SOURCE_PARTIAL", "PROJECT_UNCONFIGURED",
  "IDENTITY_MISMATCH", "RATE_LIMITED", "AUTHENTICATION_FAILED",
]);

function normalizedCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.toUpperCase();
  return RECEIPT_ERROR_CODES.has(code) ? code : undefined;
}

export function meetingMinutesReceiptSnapshot(receipt: MeetingMinutesContextReceipt):
  NonNullable<MeetingMinutesDiagnostics["receiptSnapshot"]> {
  const errors = Array.isArray(receipt.errors) ? receipt.errors
    : Array.isArray(receipt.error_codes) ? receipt.error_codes : [];
  const errorCodes = [...new Set(errors.flatMap((item) => {
    const candidate = typeof item === "string" ? item
      : item && typeof item === "object" ? (item as { code?: unknown }).code : undefined;
    const safe = normalizedCode(candidate);
    return safe ? [safe] : [];
  }))].slice(0, 8);
  return { ...(SAFE_RECEIPT_ID.test(receipt.receipt_id) ? { receiptId: receipt.receipt_id } : {}),
    status: receipt.status, errorCodes };
}

export function classifyMeetingMinutesFailure(stage: MeetingMinutesDiagnosticStage, error: unknown):
  Pick<MeetingMinutesDiagnostics, "stage" | "code" | "retryable"> {
  const message = error instanceof Error ? error.message : "";
  const taskError = error && typeof error === "object" ? error as { status?: unknown; code?: unknown } : {};
  if (stage === "task_registration") {
    if (taskError.code === "project_code_not_allowed" || message === "project_code_not_allowed") {
      return { stage, code: "TASK_PROJECT_CODE_NOT_ALLOWED", retryable: false };
    }
    if (taskError.code === "task_scope_not_configured" || message === "task_scope_not_configured") {
      return { stage, code: "TASK_SCOPE_NOT_CONFIGURED", retryable: false };
    }
    if (taskError.status === 401) return { stage, code: "TASK_AUTHENTICATION_FAILED", retryable: false };
    if (taskError.status === 403) return { stage, code: "TASK_PROJECT_FORBIDDEN", retryable: false };
  }
  const exact: Record<string, [string, boolean]> = {
    meeting_minutes_context_partial: ["CONTEXT_PARTIAL", true],
    meeting_minutes_context_unavailable: ["CONTEXT_UNAVAILABLE", true],
    "meeting_minutes_context_request_failed:401": ["CONTEXT_AUTHENTICATION_FAILED", false],
    "meeting_minutes_context_request_failed:403": ["CONTEXT_PROJECT_FORBIDDEN", false],
    "meeting_minutes_context_request_failed:429": ["CONTEXT_RATE_LIMITED", true],
    meeting_minutes_context_redirect_rejected: ["CONTEXT_REDIRECT_REJECTED", false],
    meeting_minutes_context_invalid_response: ["CONTEXT_INVALID_RESPONSE", true],
    meeting_minutes_context_invalid_receipt: ["CONTEXT_INVALID_RECEIPT", false],
    meeting_minutes_context_client_unconfigured: ["CONTEXT_CLIENT_UNCONFIGURED", false],
    meeting_minutes_context_identity_mismatch: ["CONTEXT_IDENTITY_MISMATCH", false],
    meeting_minutes_context_project_unconfigured: ["CONTEXT_PROJECT_UNCONFIGURED", false],
    meeting_minutes_transcript_empty: ["TRANSCRIPT_EMPTY", false],
    meeting_minutes_transcript_changed: ["TRANSCRIPT_CHANGED", false],
  };
  const classified = exact[message];
  if (classified) return { stage, code: classified[0], retryable: classified[1] };
  if (error instanceof Error && error.name === "TimeoutError") {
    return { stage, code: "CONTEXT_TIMEOUT", retryable: true };
  }
  const httpStatus = message.match(/^meeting_minutes_context_request_failed:(\d{3})$/)?.[1];
  if (httpStatus && Number(httpStatus) >= 500) {
    return { stage, code: "CONTEXT_UPSTREAM_FAILED", retryable: true };
  }
  if (/^meeting_minutes_context_request_failed/.test(message)) {
    return { stage, code: "CONTEXT_REQUEST_FAILED", retryable: true };
  }
  const fallback: Record<MeetingMinutesDiagnosticStage, string> = {
    interaction_enqueue: "INTERACTION_ENQUEUE_FAILED", transcript_download: "TRANSCRIPT_DOWNLOAD_FAILED",
    context_resolve: "CONTEXT_RESOLVE_FAILED", context_gate: "CONTEXT_GATE_FAILED", generation: "GENERATION_FAILED",
    github_save: "GITHUB_SAVE_FAILED", slack_publish: "SLACK_PUBLISH_FAILED",
    task_registration: "TASK_REGISTRATION_FAILED", status_projection: "STATUS_PROJECTION_FAILED",
  };
  return { stage, code: fallback[stage] ?? "UNCLASSIFIED_FAILURE", retryable: true };
}

export interface MeetingMinutesFailureLog {
  runId: string;
  stage: string;
  code: string;
  retryable: boolean;
  receipt?: unknown;
  checkpoint?: unknown;
}

export function meetingMinutesFailureLog(run: MeetingMinutesRun): MeetingMinutesFailureLog {
  const failure = run.projectionFailure ?? run.diagnostics;
  return { runId: run.runId, stage: failure?.stage ?? "unknown",
    code: failure?.code ?? "UNCLASSIFIED_FAILURE", retryable: failure?.retryable ?? true,
    receipt: run.diagnostics?.receiptSnapshot,
    checkpoint: run.diagnostics?.checkpoint ?? { hasGitHub: Boolean(run.github),
      hasSlackParent: Boolean(run.slack?.parentTs), postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 } };
}
