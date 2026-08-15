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
  /** Canonical Brainbase project codes used only for task integration. */
  taskProjectCodes?: string[];
  name: string;
  organization: { id: string; name: string };
  slackChannelId: string;
  github: { owner: string; repo: string; branch?: string; pathPrefix?: string };
}

export function meetingMinutesTaskProjectCodes(destination: MeetingMinutesDestination): string[] {
  return destination.taskProjectCodes ? [...destination.taskProjectCodes] : [destination.projectId];
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
}

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
    assigneePersonId?: string; assigneeDisplayName?: string }>;
    failure?: { index: number; stage?: "task_registration" | "task_board" | "task_card"; message: string; failedAt: string } };
  slack?: { selectionTs?: string; processingTs?: string; parentTs?: string; taskCardTs?: string; postedChunkIndexes: number[] };
  failure?: { stage: string; message: string };
  lifecycle?: {
    actionTs: string;
    deadlineAt: string;
    recoveredAt?: string;
    recoveryProjectedAt?: string;
  };
  /** Increments after each completed-run redo so external idempotency keys remain unique. */
  revision?: number;
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
