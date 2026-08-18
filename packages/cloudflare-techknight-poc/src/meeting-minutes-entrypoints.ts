import type { MeetingMinutesDestination, MeetingMinutesRedo, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { redoMeetingMinutesRun, resumeMeetingMinutesRun, startMeetingMinutesRuns, validateMeetingMinutesDestinations,
  type RedoMeetingMinutesOptions, type ResumeMeetingMinutesOptions, type StartMeetingMinutesOptions } from "./meeting-minutes-pipeline.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";

export interface MeetingMinutesEnvironment {
  MEETING_MINUTES_ENABLED?: string;
  MEETING_MINUTES_ROUTER_CHANNEL_ID?: string;
  MEETING_MINUTES_DESTINATIONS_JSON?: string;
  MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON?: string;
  MEETING_MINUTES_OPERATOR_USER_IDS?: string;
}
export interface MeetingMinutesRuntimeConfig {
  enabled: boolean; routerChannelId: string; destinations: MeetingMinutesDestination[]; operatorUserIds: ReadonlySet<string>;
}

function parseDestinations(value: string): MeetingMinutesDestination[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("meeting_minutes_destinations_invalid"); }
  if (!Array.isArray(parsed)) throw new Error("meeting_minutes_destinations_invalid");
  const destinations = parsed as MeetingMinutesDestination[]; validateMeetingMinutesDestinations(destinations); return destinations;
}

export function meetingMinutesRuntimeConfig(env: MeetingMinutesEnvironment): MeetingMinutesRuntimeConfig {
  const enabled = env.MEETING_MINUTES_ENABLED === "true";
  const routerChannelId = env.MEETING_MINUTES_ROUTER_CHANNEL_ID?.trim() ?? "";
  const operatorUserIds = new Set((env.MEETING_MINUTES_OPERATOR_USER_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (!/^[A-Z0-9]+$/.test(routerChannelId) || !operatorUserIds.size || !env.MEETING_MINUTES_DESTINATIONS_JSON) {
    if (!enabled) return { enabled: false,
      routerChannelId: /^[A-Z0-9]+$/.test(routerChannelId) ? routerChannelId : "",
      destinations: [], operatorUserIds };
    throw new Error("meeting_minutes_config_incomplete");
  }
  const destinations = parseDestinations(env.MEETING_MINUTES_DESTINATIONS_JSON);
  if (env.MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON) {
    destinations.push(...parseDestinations(env.MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON));
    validateMeetingMinutesDestinations(destinations);
  }
  return { enabled, routerChannelId, destinations, operatorUserIds };
}

export function isMeetingMinutesSlackEvent(event: SlackQueueEvent, config: MeetingMinutesRuntimeConfig): boolean {
  return config.enabled && isMeetingMinutesRouterFileEvent(event, config.routerChannelId);
}

export function isMeetingMinutesRouterFileEvent(event: SlackQueueEvent, routerChannelId: string): boolean {
  return Boolean(routerChannelId) && event.channelId === routerChannelId && event.eventType === "message" &&
    event.subtype === "file_share" && (event.files?.some((file) => /\.txt$/i.test(file.name)) ?? false);
}

export function isMeetingMinutesSelection(value: unknown): value is MeetingMinutesSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<MeetingMinutesSelection>;
  return candidate.kind === "meeting_minutes_selection" &&
    typeof candidate.runId === "string" && /^[A-Za-z0-9_-]{3,260}$/.test(candidate.runId) &&
    typeof candidate.destinationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.destinationId) &&
    [candidate.workspaceId, candidate.channelId, candidate.userId].every((item) =>
      typeof item === "string" && /^[A-Z0-9]{2,64}$/.test(item)) &&
    typeof candidate.actionTs === "string" && /^\d{1,20}(?:\.\d{1,12})?$/.test(candidate.actionTs);
}
export function currentMeetingMinutesActionTs(nowMs = Date.now()): string {
  return (nowMs / 1_000).toFixed(6);
}
export function isMeetingMinutesRedo(value: unknown): value is MeetingMinutesRedo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<MeetingMinutesRedo>;
  return candidate.kind === "meeting_minutes_redo" &&
    typeof candidate.runId === "string" && /^[A-Za-z0-9_-]{3,260}$/.test(candidate.runId) &&
    [candidate.workspaceId, candidate.channelId, candidate.userId].every((item) =>
      typeof item === "string" && /^[A-Z0-9]{2,64}$/.test(item)) &&
    typeof candidate.actionTs === "string" && /^\d{1,20}(?:\.\d{1,12})?$/.test(candidate.actionTs);
}

export async function processMeetingMinutesSlackEvent(fs: WorkspaceFs, event: SlackQueueEvent,
  config: MeetingMinutesRuntimeConfig, options: Pick<StartMeetingMinutesOptions,
    "download" | "classifyDestination" | "requestDestination" | "now">) {
  if (!isMeetingMinutesSlackEvent(event, config)) return [];
  return startMeetingMinutesRuns(fs, event, { ...options, enabled: config.enabled, routerChannelId: config.routerChannelId,
    destinations: config.destinations });
}

export async function processMeetingMinutesSelection(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  config: MeetingMinutesRuntimeConfig, options: Omit<ResumeMeetingMinutesOptions, "destinations">) {
  if (!config.enabled) throw new Error("meeting_minutes_disabled");
  return resumeMeetingMinutesRun(fs, selection, { ...options, destinations: config.destinations });
}
export async function processMeetingMinutesRedo(fs: WorkspaceFs, command: MeetingMinutesRedo,
  config: MeetingMinutesRuntimeConfig, options: Omit<RedoMeetingMinutesOptions, "destinations">) {
  if (!config.enabled) throw new Error("meeting_minutes_disabled");
  return redoMeetingMinutesRun(fs, command, { ...options, destinations: config.destinations });
}
