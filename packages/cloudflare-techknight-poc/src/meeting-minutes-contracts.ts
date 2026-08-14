import type { SlackFileReference } from "./types.js";

export const MEETING_MINUTES_CHOOSE_ACTION_ID = "mana_meeting_minutes_choose_destination";
export const MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID = "mana_meeting_minutes_choose_organization";
export const MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID = "mana_meeting_minutes_back_to_organizations";

export interface MeetingMinutesDestination {
  id: string;
  projectId: string;
  name: string;
  organization: { id: string; name: string };
  slackChannelId: string;
  github: { owner: string; repo: string; branch?: string; pathPrefix?: string };
}

export interface GeneratedMeetingMinutes {
  title: string;
  overview: string;
  body: string;
  tasks?: MeetingMinutesTaskCandidate[];
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
  destination?: MeetingMinutesDestination;
  approvedBy?: string;
  transcriptSha256?: string;
  generated?: GeneratedMeetingMinutes;
  github?: { transcriptPath: string; minutesPath: string; transcriptUrl: string; minutesUrl: string };
  taskRegistration?: { registered: Array<{ index: number; title: string; taskId: string }> };
  slack?: { selectionTs?: string; processingTs?: string; parentTs?: string; postedChunkIndexes: number[] };
  failure?: { stage: string; message: string };
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

export function meetingMinutesRunId(eventId: string, fileId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) {
    throw new Error("meeting_minutes_identity_invalid");
  }
  return `${eventId}_${fileId}`;
}

export function isMeetingMinutesFile(file: SlackFileReference): boolean {
  return /\.txt$/i.test(file.name) && (!file.mimetype || file.mimetype === "text/plain");
}
