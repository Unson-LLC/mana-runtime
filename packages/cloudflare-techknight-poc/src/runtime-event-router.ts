import {
  isMeetingTaskRequest,
  type MeetingTaskProcessResult,
} from "./meeting-task-pipeline.js";
import type { ReplyProcessResult } from "./reply-pipeline.js";
import type { SlackQueueEvent } from "./types.js";

export interface DisabledMeetingTaskResult {
  outcome: "meeting_tasks_disabled";
}

export type RuntimeEventResult =
  | MeetingTaskProcessResult
  | ReplyProcessResult
  | DisabledMeetingTaskResult;

export interface RuntimeEventRouterOptions {
  meetingTasksEnabled: boolean;
  processMeetingTask(): Promise<MeetingTaskProcessResult>;
  processReply(): Promise<ReplyProcessResult>;
}

export async function routeRuntimeEvent(
  event: SlackQueueEvent,
  options: RuntimeEventRouterOptions,
): Promise<RuntimeEventResult> {
  if (!isMeetingTaskRequest(event)) return options.processReply();
  if (!options.meetingTasksEnabled) return { outcome: "meeting_tasks_disabled" };
  return options.processMeetingTask();
}
