import { isMeetingMinutesFile, meetingMinutesRunId, type AuditedGeneratedMeetingMinutes, type GeneratedMeetingMinutes,
  type MeetingMinutesContextMode, type MeetingMinutesContextReceipt,
  type MeetingMinutesDestination, type MeetingMinutesRun, type MeetingMinutesSelection,
  type MeetingMinutesRedo, type MeetingMinutesTaskCandidate,
  meetingMinutesContextProjectCode, meetingMinutesTaskProjectCodes } from "./meeting-minutes-contracts.js";
import type { CreateTaskInput } from "@openryoko/task-runtime-core";
import { splitMeetingMinutesForSlack, stripMeetingMinutesActionItems } from "./meeting-minutes-generator.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { SavedMeetingMinutesRecords } from "./meeting-minutes-github.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { assertMeetingMinutesContextUsable, bindGeneratedMeetingMinutesContext,
  reconcileMeetingMinutesTask } from "./meeting-minutes-brainbase-context.js";

export interface StartMeetingMinutesOptions {
  enabled: boolean; routerChannelId: string; destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  download?(fileId: string): Promise<string>;
  classifyDestination?(transcript: string, destinations: readonly MeetingMinutesDestination[]):
    Promise<{ destinationId: string; reason: string } | null>;
  requestDestination(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string>;
}
export interface ResumeMeetingMinutesOptions {
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  contextMode: MeetingMinutesContextMode;
  resolveContext(identity: MeetingMinutesContextReceipt["identity"], receiptId?: string): Promise<MeetingMinutesContextReceipt>;
  postProcessingStatus(run: MeetingMinutesRun): Promise<string>;
  download(fileId: string): Promise<string>;
  generate(transcript: string, destination: MeetingMinutesDestination, context: MeetingMinutesContextReceipt,
    mode: MeetingMinutesContextMode): Promise<AuditedGeneratedMeetingMinutes>;
  saveGitHub(input: { destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
    sourceFileName: string; sourceTs: string }): Promise<SavedMeetingMinutesRecords>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<{ id: string; assignee_person_id?: string | null;
    assignee_display_name?: string | null }>;
  resolveAssignee?(name: string, projectId: string): Promise<
    { status: "resolved"; personId: string } | { status: "unknown" | "ambiguous" | "unavailable" }
  >;
  postParent(channelId: string, fileName: string, summary: string, clientMsgId: string): Promise<string>;
  postTaskCard?(run: MeetingMinutesRun): Promise<string>;
  repairTaskBoard?(projectCodes: readonly string[]): Promise<void>;
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
  const taskProjectCodes = value.taskProjectCodes;
  return /^[A-Za-z0-9_-]{1,128}$/.test(value.id) && !!value.projectId.trim() && !!value.name.trim() &&
    (value.contextProjectCode === undefined || /^[A-Za-z0-9_-]{1,128}$/.test(value.contextProjectCode)) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.organization?.id ?? "") && !!value.organization?.name.trim() &&
    /^[A-Z0-9]+$/.test(value.slackChannelId) && !!value.github.owner.trim() && !!value.github.repo.trim() &&
    (taskProjectCodes === undefined || (Array.isArray(taskProjectCodes) && taskProjectCodes.length > 0 &&
      taskProjectCodes.length <= 10 &&
      taskProjectCodes.every((code) => /^[A-Za-z0-9_-]{1,128}$/.test(code)) &&
      new Set(taskProjectCodes).size === taskProjectCodes.length));
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
  receipt: MeetingMinutesContextReceipt, options: ResumeMeetingMinutesOptions): Promise<void> {
  const tasks: MeetingMinutesTaskCandidate[] = run.generated?.tasks ?? [];
  const taskProjectCodes = meetingMinutesTaskProjectCodes(run.destination!);
  run.taskRegistration ??= { registered: [] };
  let activeIndex = 0;
  try {
    for (let index = 0; index < tasks.length; index += 1) {
      activeIndex = index;
      if (run.taskRegistration.registered.some((item) => item.index === index)) continue;
      const candidate = tasks[index]!;
      const reconciliation = reconcileMeetingMinutesTask(candidate, receipt);
      if (reconciliation.outcome !== "new") {
        run.taskRegistration.registered.push({ index, title: candidate.title, taskId: reconciliation.taskId,
          status: reconciliation.outcome });
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
        continue;
      }
      let assignee_person_id: string | undefined;
      if (candidate.assignee_name) {
        if (!options.resolveAssignee) throw new Error("meeting_minutes_assignee_resolver_unconfigured");
        const resolution = await options.resolveAssignee(candidate.assignee_name, taskProjectCodes[0]!);
        if (resolution.status === "unavailable") throw new Error("meeting_minutes_assignee_unavailable");
        if (resolution.status === "resolved") assignee_person_id = resolution.personId;
        else console.warn("meeting_minutes_assignee_unresolved", {
          runId: run.runId, taskIndex: index, status: resolution.status,
        });
      }
      const { assignee_name: _assigneeName, ...taskCandidate } = candidate;
      const task = await options.createTask({ ...taskCandidate, ...(assignee_person_id ? { assignee_person_id } : {}),
        project_codes: taskProjectCodes },
        await taskIdempotencyKey(run.runId, run.revision ?? 0, index));
      if (!task.id?.trim()) throw new Error("meeting_minutes_task_invalid_response");
      run.taskRegistration.registered.push({ index, title: candidate.title, taskId: task.id.trim(),
        ...(task.assignee_person_id ? { assigneePersonId: task.assignee_person_id } : {}),
        ...(task.assignee_display_name ? { assigneeDisplayName: task.assignee_display_name } : {}) });
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
  } catch (error) {
    run.taskRegistration.failure = { index: activeIndex,
      stage: "task_registration",
      message: error instanceof Error ? error.message : "meeting_minutes_task_registration_failed",
      failedAt: now(options) };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    throw error;
  }
}

async function deferTaskIntegration(fs: WorkspaceFs, run: MeetingMinutesRun,
  stage: "task_registration" | "task_board" | "task_card", error: unknown,
  options: ResumeMeetingMinutesOptions): Promise<void> {
  run.taskRegistration ??= { registered: [] };
  run.taskRegistration.failure = { index: run.taskRegistration.failure?.index ??
    Math.max(0, run.taskRegistration.registered.length - 1), stage,
    message: error instanceof Error ? error.message : "meeting_minutes_task_integration_failed", failedAt: now(options) };
  run.status = "completed"; delete run.failure; run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
}

async function markTaskIntegrationPending(fs: WorkspaceFs, run: MeetingMinutesRun,
  stage: "task_board" | "task_card", options: ResumeMeetingMinutesOptions): Promise<void> {
  run.taskRegistration ??= { registered: [] };
  run.taskRegistration.failure = { index: run.taskRegistration.failure?.index ??
    Math.max(0, run.taskRegistration.registered.length - 1), stage,
    message: `meeting_minutes_${stage}_pending`, failedAt: now(options) };
  run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
}

async function clearTaskIntegrationPending(fs: WorkspaceFs, run: MeetingMinutesRun,
  options: ResumeMeetingMinutesOptions): Promise<void> {
  if (!run.taskRegistration?.failure) return;
  delete run.taskRegistration.failure;
  run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
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
  const contextProjectChanged = !!run.destination &&
    meetingMinutesContextProjectCode(run.destination) !== meetingMinutesContextProjectCode(configured);
  if (contextProjectChanged && run.context) throw new Error("meeting_minutes_context_project_changed");
  if (run.destination && (JSON.stringify(run.destination.taskProjectCodes) !== JSON.stringify(configured.taskProjectCodes) ||
    contextProjectChanged)) {
    run.destination.taskProjectCodes = configured.taskProjectCodes ? [...configured.taskProjectCodes] : undefined;
    run.destination.contextProjectCode = configured.contextProjectCode;
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
  }
  if (run.approvedBy && run.approvedBy !== selection.userId) throw new Error("meeting_minutes_approver_changed");
  if (run.status === "completed") {
    if (run.taskRegistration?.failure && run.destination && run.transcriptSha256) {
      const retryStage = run.taskRegistration.failure.stage;
      try {
        const receipt = await options.resolveContext({ run_id: run.runId,
          project_code: meetingMinutesContextProjectCode(run.destination),
          transcript_sha256: run.transcriptSha256 }, run.context?.receiptId);
        assertMeetingMinutesContextUsable(receipt, options.contextMode);
        await registerGeneratedTasks(fs, run, receipt, options);
      } catch (error) {
        console.error("meeting_minutes_task_registration_retry_failed", {
          runId: run.runId, error: error instanceof Error ? error.message : "meeting_minutes_task_registration_failed",
        });
        return run;
      }
      if (retryStage !== "task_card" && run.taskRegistration.registered.length && options.repairTaskBoard) {
        await markTaskIntegrationPending(fs, run, "task_board", options);
        try {
          await options.repairTaskBoard(meetingMinutesTaskProjectCodes(run.destination));
        } catch (error) {
          await deferTaskIntegration(fs, run, "task_board", error, options);
          return run;
        }
      }
      if (run.taskRegistration.registered.length && run.slack?.parentTs && !run.slack.taskCardTs && options.postTaskCard) {
        await markTaskIntegrationPending(fs, run, "task_card", options);
        try {
          run.slack.taskCardTs = await options.postTaskCard(run);
          run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
        } catch (error) {
          await deferTaskIntegration(fs, run, "task_card", error, options);
          return run;
        }
      }
      await clearTaskIntegrationPending(fs, run, options);
    }
    return run;
  }
  if (run.status === "failed") {
    if (!run.github && run.failure?.message === "meeting_minutes_context_source_ref_unknown") {
      delete run.generated;
    }
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
  let contextReceipt: MeetingMinutesContextReceipt | undefined;
  try {
    if (!run.github || !run.context) {
      transcript = await options.download(run.file.id);
      if (!transcript.trim()) throw new Error("meeting_minutes_transcript_empty");
      const transcriptSha256 = await digest(transcript);
      if (run.transcriptSha256 && run.transcriptSha256 !== transcriptSha256) throw new Error("meeting_minutes_transcript_changed");
      run.transcriptSha256 ??= transcriptSha256;
    }
    const contextIdentity = { run_id: run.runId, project_code: meetingMinutesContextProjectCode(run.destination),
      transcript_sha256: run.transcriptSha256! };
    contextReceipt = await options.resolveContext(contextIdentity, run.context?.receiptId);
    assertMeetingMinutesContextUsable(contextReceipt, options.contextMode);
    if (run.context && (run.context.receiptId !== contextReceipt.receipt_id || run.context.checksum !== contextReceipt.checksum)) {
      throw new Error("meeting_minutes_context_changed");
    }
    if (!run.context) {
      run.context = { receiptId: contextReceipt.receipt_id, checksum: contextReceipt.checksum,
        status: contextReceipt.status, mode: options.contextMode,
        sourceRefs: contextReceipt.context.source_refs, resolvedAt: contextReceipt.resolved_at };
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    if (!run.github) {
      if (!run.generated) {
        const candidate = await options.generate(transcript, run.destination, contextReceipt, options.contextMode);
        run.generated = bindGeneratedMeetingMinutesContext(candidate, contextReceipt, options.contextMode);
        run.status = "generated";
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      } else {
        try {
          run.generated = bindGeneratedMeetingMinutesContext(run.generated, contextReceipt, options.contextMode);
        } catch (error) {
          if (!(error instanceof Error) || !["meeting_minutes_context_source_ref_unknown",
            "meeting_minutes_context_attestation_mismatch"].includes(error.message)) throw error;
          const candidate = await options.generate(transcript, run.destination, contextReceipt, options.contextMode);
          run.generated = bindGeneratedMeetingMinutesContext(candidate, contextReceipt, options.contextMode);
        }
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      }
      run.github = await options.saveGitHub({ destination: run.destination, transcript, minutes: run.generated,
        sourceFileName: run.file.name, sourceTs: run.sourceMessageTs });
      run.status = "github_saved"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
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
    try {
      await registerGeneratedTasks(fs, run, contextReceipt, options);
    } catch (error) {
      console.error("meeting_minutes_task_registration_deferred", {
        runId: run.runId, error: error instanceof Error ? error.message : "meeting_minutes_task_registration_failed",
      });
      await deferTaskIntegration(fs, run, "task_registration", error, options); return run;
    }
    if (run.taskRegistration?.registered.length && options.repairTaskBoard) {
      await markTaskIntegrationPending(fs, run, "task_board", options);
      try {
        await options.repairTaskBoard(meetingMinutesTaskProjectCodes(run.destination));
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_board", error, options); return run;
      }
    }
    if (run.taskRegistration?.registered.length && !run.slack.taskCardTs && options.postTaskCard) {
      await markTaskIntegrationPending(fs, run, "task_card", options);
      try {
        run.slack.taskCardTs = await options.postTaskCard(run);
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_card", error, options); return run;
      }
    }
    await clearTaskIntegrationPending(fs, run, options);
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
  delete run.destination; delete run.approvedBy; delete run.context; delete run.generated; delete run.github;
  delete run.taskRegistration; delete run.failure;
  run.slack = { selectionTs, postedChunkIndexes: [] };
  run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  return run;
}
