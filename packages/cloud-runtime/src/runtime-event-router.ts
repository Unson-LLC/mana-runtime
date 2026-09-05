import {
  isMeetingTaskRequest,
  type MeetingTaskProcessResult,
} from "./meeting-task-pipeline.js";
import type { ReplyProcessResult } from "./reply-pipeline.js";
import type { SlackQueueEvent } from "./types.js";

export interface DisabledMeetingTaskResult {
  outcome: "meeting_tasks_disabled";
  responseTs: string;
}

export type RuntimeEventResult =
  | MeetingTaskProcessResult
  | ReplyProcessResult
  | DisabledMeetingTaskResult;

export interface RuntimeEventRouterOptions {
  meetingTasksEnabled: boolean;
  processMeetingTask(): Promise<MeetingTaskProcessResult>;
  processReply(): Promise<ReplyProcessResult>;
  processDisabledMeetingTask(): Promise<DisabledMeetingTaskResult>;
}

export async function routeRuntimeEvent(
  event: SlackQueueEvent,
  options: RuntimeEventRouterOptions,
): Promise<RuntimeEventResult> {
  if (!isMeetingTaskRequest(event)) return options.processReply();
  if (!options.meetingTasksEnabled) return options.processDisabledMeetingTask();
  return options.processMeetingTask();
}
