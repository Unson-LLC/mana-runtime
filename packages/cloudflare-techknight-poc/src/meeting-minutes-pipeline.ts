import { isMeetingMinutesFile, meetingMinutesRunId, type GeneratedMeetingMinutes,
  type MeetingMinutesDestination, type MeetingMinutesRun, type MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { splitMeetingMinutesForSlack } from "./meeting-minutes-generator.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { SavedMeetingMinutesRecords } from "./meeting-minutes-github.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";

export interface StartMeetingMinutesOptions {
  enabled: boolean; routerChannelId: string; destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  requestDestination(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string>;
}
export interface ResumeMeetingMinutesOptions {
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  download(fileId: string): Promise<string>;
  generate(transcript: string, destination: MeetingMinutesDestination): Promise<GeneratedMeetingMinutes>;
  saveGitHub(input: { destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
    sourceFileName: string; sourceTs: string }): Promise<SavedMeetingMinutesRecords>;
  postParent(channelId: string, text: string, clientMsgId: string): Promise<string>;
  postThreadChunk(channelId: string, threadTs: string, text: string, clientMsgId: string): Promise<string>;
}

function now(options: { now?: () => Date }): string { return (options.now?.() ?? new Date()).toISOString(); }
function destinationIsValid(value: MeetingMinutesDestination): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value.id) && !!value.projectId.trim() && !!value.name.trim() &&
    /^[A-Z0-9]+$/.test(value.slackChannelId) && !!value.github.owner.trim() && !!value.github.repo.trim();
}
export function validateMeetingMinutesDestinations(destinations: readonly MeetingMinutesDestination[]): void {
  if (!destinations.length || destinations.length > 25 || destinations.some((item) => !destinationIsValid(item)) ||
    new Set(destinations.map((item) => item.id)).size !== destinations.length) {
    throw new Error("meeting_minutes_destinations_invalid");
  }
}

function sameDestination(left: MeetingMinutesDestination, right: MeetingMinutesDestination): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.name === right.name &&
    left.slackChannelId === right.slackChannelId && left.github.owner === right.github.owner &&
    left.github.repo === right.github.repo && (left.github.branch ?? "main") === (right.github.branch ?? "main") &&
    (left.github.pathPrefix ?? "") === (right.github.pathPrefix ?? "");
}

export async function startMeetingMinutesRuns(fs: WorkspaceFs, event: SlackQueueEvent,
  options: StartMeetingMinutesOptions): Promise<MeetingMinutesRun[]> {
  if (!options.enabled) return [];
  if (event.workspaceId.trim() === "" || event.channelId !== options.routerChannelId) throw new Error("meeting_minutes_boundary_mismatch");
  validateMeetingMinutesDestinations(options.destinations);
  const files = (event.files ?? []).filter(isMeetingMinutesFile);
  const runs: MeetingMinutesRun[] = [];
  for (const file of files) {
    const runId = meetingMinutesRunId(event.eventId, file.id); const existing = await loadMeetingMinutesRun(fs, runId);
    if (existing) {
      if (!existing.slack?.selectionTs) {
        existing.slack ??= { postedChunkIndexes: [] };
        existing.slack.selectionTs = await options.requestDestination(existing, options.destinations);
        existing.updatedAt = now(options); await saveMeetingMinutesRun(fs, existing);
      }
      runs.push(existing); continue;
    }
    const timestamp = now(options); const run: MeetingMinutesRun = { version: 1, runId, eventId: event.eventId,
      workspaceId: event.workspaceId, sourceChannelId: event.channelId, sourceThreadTs: event.threadTs,
      sourceMessageTs: event.messageTs, file, status: "awaiting_destination", slack: { postedChunkIndexes: [] },
      createdAt: timestamp, updatedAt: timestamp };
    await saveMeetingMinutesRun(fs, run);
    run.slack!.selectionTs = await options.requestDestination(run, options.destinations);
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    runs.push(run);
  }
  return runs;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resumeMeetingMinutesRun(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  options: ResumeMeetingMinutesOptions): Promise<MeetingMinutesRun> {
  validateMeetingMinutesDestinations(options.destinations);
  const run = await loadMeetingMinutesRun(fs, selection.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (run.workspaceId !== selection.workspaceId || run.sourceChannelId !== selection.channelId) {
    throw new Error("meeting_minutes_selection_boundary_mismatch");
  }
  if (run.status === "completed") return run;
  const configured = options.destinations.find((item) => item.id === selection.destinationId);
  if (!configured) throw new Error("meeting_minutes_destination_forbidden");
  if (run.destination && !sameDestination(run.destination, configured)) {
    throw new Error("meeting_minutes_destination_changed");
  }
  if (run.approvedBy && run.approvedBy !== selection.userId) throw new Error("meeting_minutes_approver_changed");
  run.destination ??= structuredClone(configured); run.approvedBy ??= selection.userId;
  run.status = run.status === "awaiting_destination" ? "routed" : run.status; delete run.failure; run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  let transcript = "";
  try {
    if (!run.github) {
      transcript = await options.download(run.file.id);
      if (!transcript.trim()) throw new Error("meeting_minutes_transcript_empty");
      const transcriptSha256 = await digest(transcript);
      if (run.transcriptSha256 && run.transcriptSha256 !== transcriptSha256) throw new Error("meeting_minutes_transcript_changed");
      run.transcriptSha256 ??= transcriptSha256;
      if (!run.generated) {
        run.generated = await options.generate(transcript, run.destination); run.status = "generated";
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      }
      run.github = await options.saveGitHub({ destination: run.destination, transcript, minutes: run.generated,
        sourceFileName: run.file.name, sourceTs: run.sourceMessageTs });
      run.status = "github_saved"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    const parentText = `*${run.generated!.title}*\n${run.generated!.overview}`;
    const narrativeText = `${parentText}\n\n------------\n\n${run.generated!.body}`;
    const chunks = splitMeetingMinutesForSlack(narrativeText); run.slack ??= { postedChunkIndexes: [] };
    if (!run.slack.parentTs) {
      run.slack.parentTs = await options.postParent(run.destination.slackChannelId, parentText, `${run.runId}-parent`);
      run.status = "posting"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    for (let index = 0; index < chunks.length; index += 1) {
      if (run.slack.postedChunkIndexes.includes(index)) continue;
      await options.postThreadChunk(run.destination.slackChannelId, run.slack.parentTs, chunks[index]!, `${run.runId}-chunk-${index}`);
      run.slack.postedChunkIndexes.push(index); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    run.status = "completed"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run); return run;
  } catch (error) {
    run.failure = { stage: run.status, message: error instanceof Error ? error.message : "meeting_minutes_failed" };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run); throw error;
  }
}
