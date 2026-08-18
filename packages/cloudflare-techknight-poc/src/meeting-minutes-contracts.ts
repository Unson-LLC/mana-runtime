import type { SlackFileReference } from "./types.js";

export const MEETING_MINUTES_CHOOSE_ACTION_ID = "mana_meeting_minutes_choose_destination";
export const MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID = "mana_meeting_minutes_choose_organization";
export const MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID = "mana_meeting_minutes_back_to_organizations";
export const MEETING_MINUTES_TASK_EDIT_ACTION_ID = "mana_meeting_minutes_task_edit";
export const MEETING_MINUTES_TASK_CANCEL_ACTION_ID = "mana_meeting_minutes_task_cancel";
export const MEETING_MINUTES_TASK_EDIT_VIEW_ID = "mana_meeting_minutes_task_edit_submit";
export const MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID = "mana_meeting_minutes_task_assignee";
export const MEETING_MINUTES_REDO_ACTION_ID = "mana_meeting_minutes_redo";
export const MEETING_MINUTES_CONFIRM_REDO_ACTION_ID = "mana_meeting_minutes_confirm_redo";

export interface MeetingMinutesDestination {
  id: string;
  projectId: string;
  /** Canonical Brainbase project code used to resolve meeting context. */
  contextProjectCode: string;
  /** Canonical Brainbase project codes used only for task integration. */
  taskProjectCodes: string[];
  /** Exact task-board destination; never inferred from a Brainbase project code. */
  taskBoardTargetId: string;
  name: string;
  organization: { id: string; name: string };
  slackChannelId: string;
  github: { owner: string; repo: string; branch?: string; pathPrefix?: string };
}

export function meetingMinutesContextProjectCode(destination: MeetingMinutesDestination): string {
  return destination.contextProjectCode;
}

export function meetingMinutesTaskProjectCodes(destination: MeetingMinutesDestination): string[] {
  return [...destination.taskProjectCodes];
}

export interface GeneratedMeetingMinutes {
  title: string;
  overview: string;
  body: string;
  tasks?: MeetingMinutesTaskCandidate[];
  brainbase_context_receipt_id?: string;
  brainbase_context_checksum?: string;
  used_source_refs?: MeetingMinutesContextSourceRef[];
  decision_candidates?: Array<{ title: string; reason?: string; source_ref_ids?: string[] }>;
  brainbase_context_warnings?: Array<"unknown_source_ref_removed">;
  /** Worker-derived proof that the generation run actually read the canonical Brainbase Receipt. */
  brainbase_context_attestation?: MeetingMinutesContextAttestation;
  /** Safe, content-free execution metadata. The pipeline moves this into durable run diagnostics. */
  generationDiagnostics?: MeetingMinutesGenerationDiagnostics;
}

export interface MeetingMinutesGenerationDiagnostics {
  schemaVersion: "meeting_minutes_generation_diagnostics.v1";
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  model: string;
  timeoutMs: number;
  outcome?: "success" | "timeout" | "nonzero_exit" | "transport_failure";
  exitCode?: number;
  stderrCode?: "TIMEOUT" | "RATE_LIMITED" | "AUTHENTICATION_FAILED" | "HOOK_FAILED" | "CLI_ERROR" | "UNKNOWN";
  progress: {
    prompt_written: boolean;
    exec_started: boolean;
    stdout_observed?: boolean;
    hook_observed?: boolean;
    result_observed?: boolean;
  };
  stdoutBytes?: number;
  streamEventCount?: number;
}

export interface MeetingMinutesMcpContextAttestation {
  schema_version: "meeting_minutes_context_attestation.v1";
  tool_name: "mcp__brainbase__brainbase_get_meeting_minutes_context";
  receipt_id: string;
  checksum: string;
  run_id: string;
  project_code: string;
  transcript_sha256: string;
  session_id: string;
}

export interface MeetingMinutesReceiptContextAttestation {
  schema_version: "meeting_minutes_context_attestation.v2";
  source: "worker_context_receipt";
  receipt_id: string;
  checksum: string;
  run_id: string;
  project_code: string;
  transcript_sha256: string;
  session_id: string;
}

export type MeetingMinutesContextAttestation =
  | MeetingMinutesMcpContextAttestation
  | MeetingMinutesReceiptContextAttestation;

export type AuditedGeneratedMeetingMinutes = GeneratedMeetingMinutes & {
  brainbase_context_attestation: MeetingMinutesContextAttestation;
};

export type MeetingMinutesContextStatus = "resolved" | "confirmed_empty" | "partial" | "unavailable";
export type MeetingMinutesContextMode = "observe" | "required";
export interface MeetingMinutesContextSourceRef { type: string; id: string; ref?: string }
export interface MeetingMinutesContextReceipt {
  schema_version: "meeting_minutes_context_receipt.v1";
  receipt_id: string;
  identity: { run_id: string; project_code: string; transcript_sha256: string };
  status: MeetingMinutesContextStatus;
  checksum: string;
  resolved_at: string;
  context: {
    source_refs: MeetingMinutesContextSourceRef[];
    open_tasks: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MeetingMinutesContextAudit {
  receiptId: string;
  checksum: string;
  status: MeetingMinutesContextStatus;
  mode: MeetingMinutesContextMode;
  sourceRefs: MeetingMinutesContextSourceRef[];
  resolvedAt: string;
}

export interface MeetingMinutesTaskCandidate {
  title: string;
  description?: string;
  assignee_name?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  due_at?: string;
}

export type MeetingMinutesRunStatus =
  | "awaiting_destination"
  | "routed"
  | "generated"
  | "github_saved"
  | "posting"
  | "completed"
  | "failed";

export type MeetingMinutesDiagnosticStage = "interaction_enqueue" | "transcript_download" | "context_resolve"
  | "context_gate" | "generation" | "github_save" | "slack_publish" | "task_registration" | "status_projection";

export interface MeetingMinutesDiagnostics {
  schemaVersion: "meeting_minutes_diagnostics.v1";
  stage?: MeetingMinutesDiagnosticStage;
  code?: string;
  retryable?: boolean;
  failedAt?: string;
  receiptSnapshot?: { receiptId?: string; status: MeetingMinutesContextStatus; errorCodes: string[] };
  checkpoint?: { hasGitHub: boolean; hasSlackParent: boolean; postedChunkCount: number };
  generation?: MeetingMinutesGenerationDiagnostics;
}

export interface MeetingMinutesRun {
  version: 1;
  runId: string;
  eventId: string;
  workspaceId: string;
  sourceChannelId: string;
  sourceThreadTs: string;
  sourceMessageTs: string;
  file: SlackFileReference;
  status: MeetingMinutesRunStatus;
  routing?: { evaluated: true; suggestedDestinationId?: string; reason?: string };
  destination?: MeetingMinutesDestination;
  approvedBy?: string;
  transcriptSha256?: string;
  context?: MeetingMinutesContextAudit;
  generated?: GeneratedMeetingMinutes;
  github?: { transcriptPath: string; minutesPath: string; transcriptUrl: string; minutesUrl: string };
  taskRegistration?: { registered: Array<{ index: number; title: string; taskId: string; status?: "registered" | "reused" | "needs_review" | "removed";
    /** Canonical Task project scope used when this item was created or last migrated. */
    projectCodes?: string[];
    assigneePersonId?: string; assigneeDisplayName?: string }>;
    /** Exact durable request saved before createTask. Retried byte-for-byte with the same idempotency key. */
    pending?: { index: number; idempotencyKey: string; input: import("@openryoko/task-runtime-core").CreateTaskInput };
    failure?: { index: number; stage?: "task_registration" | "task_board" | "task_card"; message: string;
      /** Stable Task API classification retained so Slack can distinguish configuration errors from retryable failures. */
      code?: string; status?: number; failedAt: string } };
  slack?: { selectionTs?: string; processingTs?: string; parentTs?: string; taskCardTs?: string; postedChunkIndexes: number[] };
  failure?: { stage: string; message: string };
  /** Sanitized diagnostics only; never store upstream bodies, transcript text, hashes, or credentials. */
  diagnostics?: MeetingMinutesDiagnostics;
  /** A projection failure is secondary and must not overwrite the processing failure or completed result. */
  projectionFailure?: Required<Pick<MeetingMinutesDiagnostics, "stage" | "code" | "retryable" | "failedAt">>;
  lifecycle?: {
    actionTs: string;
    deadlineAt: string;
    recoveredAt?: string;
    recoveryProjectedAt?: string;
  };
  /** Increments after each completed-run redo so external idempotency keys remain unique. */
  revision?: number;
  /** Durable checkpoints for a completed-run redo. Each external cleanup is performed at most once per revision. */
  redo?: {
    revision: number;
    requestedAt: string;
    githubDeletedAt?: string;
    deletedTaskIds: string[];
    sharedRetractedAt?: string;
    failure?: { message: string; failedAt: string };
  };
  createdAt: string;
  updatedAt: string;
}

export interface MeetingMinutesSelection {
  kind: "meeting_minutes_selection";
  runId: string;
  destinationId: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  actionTs: string;
}

export interface MeetingMinutesRedo {
  kind: "meeting_minutes_redo";
  runId: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  actionTs: string;
}

export interface MeetingMinutesRecovery {
  kind: "meeting_minutes_recovery";
  runId: string;
  workspaceId: string;
  actionTs: string;
}

export function meetingMinutesRunId(eventId: string, fileId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) {
    throw new Error("meeting_minutes_identity_invalid");
  }
  return `${eventId}_${fileId}`;
}

export function isMeetingMinutesFile(file: SlackFileReference): boolean {
  return /\.txt$/i.test(file.name) && (!file.mimetype || file.mimetype === "text/plain");
}
