import { isMeetingMinutesFile, meetingMinutesRunId, type GeneratedMeetingMinutes,
  type MeetingMinutesDestination, type MeetingMinutesRun, type MeetingMinutesSelection,
  type MeetingMinutesRedo, type MeetingMinutesTaskCandidate } from "./meeting-minutes-contracts.js";
import type { CreateTaskInput } from "@openryoko/task-runtime-core";
import { splitMeetingMinutesForSlack, stripMeetingMinutesActionItems } from "./meeting-minutes-generator.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { SavedMeetingMinutesRecords } from "./meeting-minutes-github.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";

export interface StartMeetingMinutesOptions {
  enabled: boolean; routerChannelId: string; destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  download?(fileId: string): Promise<string>;
  classifyDestination?(transcript: string, destinations: readonly MeetingMinutesDestination[]):
    Promise<{ destinationId: string; reason: string } | null>;
  requestDestination(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string>;
}
export interface ResumeMeetingMinutesOptions {
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  postProcessingStatus(run: MeetingMinutesRun): Promise<string>;
  download(fileId: string): Promise<string>;
  generate(transcript: string, destination: MeetingMinutesDestination): Promise<GeneratedMeetingMinutes>;
  saveGitHub(input: { destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
    sourceFileName: string; sourceTs: string }): Promise<SavedMeetingMinutesRecords>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<{ id: string; assignee_person_id?: string | null;
    assignee_display_name?: string | null }>;
  resolveAssignee?(name: string, projectId: string): Promise<
    { status: "resolved"; personId: string } | { status: "unknown" | "ambiguous" | "unavailable" }
  >;
  postParent(channelId: string, fileName: string, summary: string, clientMsgId: string): Promise<string>;
  postTaskCard?(run: MeetingMinutesRun): Promise<string>;
  postThreadChunk(channelId: string, threadTs: string, fileName: string, text: string,
    index: number, total: number, clientMsgId: string): Promise<string>;
}
export interface RedoMeetingMinutesOptions {
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  deleteGitHub(destination: MeetingMinutesDestination, paths: readonly string[]): Promise<void>;
  deleteTask(taskId: string, idempotencyKey: string): Promise<void>;
  retractSharedMinutes(destination: MeetingMinutesDestination, parentTs: string, fileName: string): Promise<void>;
  showDestinationSelection(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string>;
}

function now(options: { now?: () => Date }): string { return (options.now?.() ?? new Date()).toISOString(); }
function destinationIsValid(value: MeetingMinutesDestination): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value.id) && !!value.projectId.trim() && !!value.name.trim() &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.organization?.id ?? "") && !!value.organization?.name.trim() &&
    /^[A-Z0-9]+$/.test(value.slackChannelId) && !!value.github.owner.trim() && !!value.github.repo.trim();
}
export function validateMeetingMinutesDestinations(destinations: readonly MeetingMinutesDestination[]): void {
  if (!destinations.length || destinations.length > 25 || destinations.some((item) => !destinationIsValid(item)) ||
    new Set(destinations.map((item) => item.id)).size !== destinations.length ||
    destinations.some((item) => destinations.some((candidate) => candidate.organization.id === item.organization.id &&
      candidate.organization.name !== item.organization.name))) {
    throw new Error("meeting_minutes_destinations_invalid");
  }
}

function sameDestination(left: MeetingMinutesDestination, right: MeetingMinutesDestination): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.name === right.name &&
    (!left.organization || (left.organization.id === right.organization.id && left.organization.name === right.organization.name)) &&
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
    if (options.download && options.classifyDestination && !run.routing?.evaluated) {
      try {
        const routed = await options.classifyDestination(await options.download(file.id), options.destinations);
        run.routing = { evaluated: true, ...(routed ? {
          suggestedDestinationId: routed.destinationId, reason: routed.reason,
        } : {}) };
      } catch {
        run.routing = { evaluated: true };
      }
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
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

async function taskIdempotencyKey(runId: string, revision: number, index: number): Promise<string> {
  return `meeting-minutes-${await digest(`${runId}:revision:${revision}:task:${index}`)}`;
}

async function registerGeneratedTasks(fs: WorkspaceFs, run: MeetingMinutesRun,
  options: ResumeMeetingMinutesOptions): Promise<void> {
  const tasks: MeetingMinutesTaskCandidate[] = run.generated?.tasks ?? [];
  run.taskRegistration ??= { registered: [] };
  for (let index = 0; index < tasks.length; index += 1) {
    if (run.taskRegistration.registered.some((item) => item.index === index)) continue;
    const candidate = tasks[index]!;
    let assignee_person_id: string | undefined;
    if (candidate.assignee_name) {
      if (!options.resolveAssignee) throw new Error("meeting_minutes_assignee_resolver_unconfigured");
      const resolution = await options.resolveAssignee(candidate.assignee_name, run.destination!.projectId);
      if (resolution.status === "unavailable") throw new Error("meeting_minutes_assignee_unavailable");
      if (resolution.status === "resolved") assignee_person_id = resolution.personId;
      else console.warn("meeting_minutes_assignee_unresolved", {
        runId: run.runId, taskIndex: index, status: resolution.status,
      });
    }
    const { assignee_name: _assigneeName, ...taskCandidate } = candidate;
    const task = await options.createTask({ ...taskCandidate, ...(assignee_person_id ? { assignee_person_id } : {}),
      project_codes: [run.destination!.projectId] },
      await taskIdempotencyKey(run.runId, run.revision ?? 0, index));
    if (!task.id?.trim()) throw new Error("meeting_minutes_task_invalid_response");
    run.taskRegistration.registered.push({ index, title: candidate.title, taskId: task.id.trim(),
      ...(task.assignee_person_id ? { assigneePersonId: task.assignee_person_id } : {}),
      ...(task.assignee_display_name ? { assigneeDisplayName: task.assignee_display_name } : {}) });
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
  }
}

export async function resumeMeetingMinutesRun(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  options: ResumeMeetingMinutesOptions): Promise<MeetingMinutesRun> {
  validateMeetingMinutesDestinations(options.destinations);
  const run = await loadMeetingMinutesRun(fs, selection.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (run.workspaceId !== selection.workspaceId || run.sourceChannelId !== selection.channelId) {
    throw new Error("meeting_minutes_selection_boundary_mismatch");
  }
  const configured = options.destinations.find((item) => item.id === selection.destinationId);
  if (!configured) throw new Error("meeting_minutes_destination_forbidden");
  if (run.destination && !sameDestination(run.destination, configured)) {
    throw new Error("meeting_minutes_destination_changed");
  }
  if (run.approvedBy && run.approvedBy !== selection.userId) throw new Error("meeting_minutes_approver_changed");
  if (run.status === "completed") {
    if (run.taskRegistration?.registered.length && run.slack?.parentTs && !run.slack.taskCardTs && options.postTaskCard) {
      run.slack.taskCardTs = await options.postTaskCard(run);
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    return run;
  }
  if (run.status === "failed") {
    run.status = run.github ? (run.slack?.parentTs ? "posting" : "github_saved") :
      run.generated ? "generated" : "routed";
  }
  run.destination ??= structuredClone(configured); run.approvedBy ??= selection.userId;
  run.status = run.status === "awaiting_destination" ? "routed" : run.status; delete run.failure; run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  run.slack ??= { postedChunkIndexes: [] };
  if (!run.slack.processingTs) {
    run.slack.processingTs = await options.postProcessingStatus(run);
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
  }
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
    await registerGeneratedTasks(fs, run, options);
    const parentText = `*${run.generated!.title}*\n${run.generated!.overview}`;
    const body = stripMeetingMinutesActionItems(run.generated!.body).trimStart();
    const narrativeText = body.startsWith("------------") ? body : `------------\n\n${body}`;
    const chunks = splitMeetingMinutesForSlack(narrativeText);
    run.slack ??= { postedChunkIndexes: [] };
    if (!run.slack.parentTs) {
      run.slack.parentTs = await options.postParent(run.destination.slackChannelId, run.file.name, parentText,
        `${run.runId}-revision-${run.revision ?? 0}-parent`);
      run.status = "posting"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    for (let index = 0; index < chunks.length; index += 1) {
      if (run.slack.postedChunkIndexes.includes(index)) continue;
      await options.postThreadChunk(run.destination.slackChannelId, run.slack.parentTs, run.file.name, chunks[index]!,
        index, chunks.length, `${run.runId}-revision-${run.revision ?? 0}-chunk-${index}`);
      run.slack.postedChunkIndexes.push(index); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    if (run.taskRegistration?.registered.length && !run.slack.taskCardTs && options.postTaskCard) {
      run.slack.taskCardTs = await options.postTaskCard(run);
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    run.status = "completed"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run); return run;
  } catch (error) {
    const failedStage = run.status;
    run.status = "failed";
    run.failure = { stage: failedStage, message: error instanceof Error ? error.message : "meeting_minutes_failed" };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run); throw error;
  }
}

export async function redoMeetingMinutesRun(fs: WorkspaceFs, command: MeetingMinutesRedo,
  options: RedoMeetingMinutesOptions): Promise<MeetingMinutesRun> {
  validateMeetingMinutesDestinations(options.destinations);
  const run = await loadMeetingMinutesRun(fs, command.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (run.workspaceId !== command.workspaceId || run.sourceChannelId !== command.channelId) {
    throw new Error("meeting_minutes_redo_boundary_mismatch");
  }
  if (run.status !== "completed" || !run.destination || !run.github || !run.slack?.processingTs) {
    throw new Error("meeting_minutes_redo_not_available");
  }
  await options.deleteGitHub(run.destination, [run.github.transcriptPath, run.github.minutesPath]);
  for (const task of run.taskRegistration?.registered ?? []) {
    await options.deleteTask(task.taskId, `meeting-minutes-redo-${run.runId}-revision-${run.revision ?? 0}-${task.index}`);
  }
  if (run.slack.parentTs) {
    await options.retractSharedMinutes(run.destination, run.slack.parentTs, run.file.name);
  }
  const selectionTs = await options.showDestinationSelection(structuredClone(run), options.destinations);
  run.status = "awaiting_destination";
  run.revision = (run.revision ?? 0) + 1;
  delete run.destination; delete run.approvedBy; delete run.generated; delete run.github;
  delete run.taskRegistration; delete run.failure;
  run.slack = { selectionTs, postedChunkIndexes: [] };
  run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  return run;
}
