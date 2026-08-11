import {
  isMeetingTaskRequest,
  type MeetingTaskProcessResult,
} from "./meeting-task-pipeline.js";
import type { ReplyProcessResult } from "./reply-pipeline.js";
import type { SlackQueueEvent } from "./types.js";

export type RuntimeEventResult = MeetingTaskProcessResult | ReplyProcessResult;

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
  if (!options.meetingTasksEnabled) return { outcome: "ignored" };
  return options.processMeetingTask();
}
