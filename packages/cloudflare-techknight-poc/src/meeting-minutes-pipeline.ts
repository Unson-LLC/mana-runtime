import { isMeetingMinutesFile, meetingMinutesRunId, type AuditedGeneratedMeetingMinutes, type GeneratedMeetingMinutes,
  type MeetingMinutesContextMode, type MeetingMinutesContextReceipt,
  type MeetingMinutesDestination, type MeetingMinutesDiagnosticStage, type MeetingMinutesGenerationDiagnostics,
  type MeetingMinutesRun, type MeetingMinutesSelection,
  type MeetingMinutesRedo, type MeetingMinutesTaskCandidate,
  meetingMinutesContextProjectCode, meetingMinutesTaskProjectCodes } from "./meeting-minutes-contracts.js";
import type { CreateTaskInput } from "@openryoko/task-runtime-core";
import { assertGeneratedMeetingMinutesNotPlaceholder, splitMeetingMinutesForSlack,
  stripMeetingMinutesActionItems } from "./meeting-minutes-generator.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { SavedMeetingMinutesRecords } from "./meeting-minutes-github.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { assertMeetingMinutesContextUsable, bindGeneratedMeetingMinutesContext,
  reconcileMeetingMinutesTask } from "./meeting-minutes-brainbase-context.js";
import { classifyMeetingMinutesFailure, meetingMinutesFailureLog,
  meetingMinutesReceiptSnapshot } from "./meeting-minutes-diagnostics.js";

export interface StartMeetingMinutesOptions {
  enabled: boolean; routerChannelId: string; sourceAppId: string;
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
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
    mode: MeetingMinutesContextMode,
    observe?: (diagnostics: MeetingMinutesGenerationDiagnostics) => Promise<void>): Promise<AuditedGeneratedMeetingMinutes>;
  saveGitHub(input: { destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
    sourceFileName: string; sourceTs: string }): Promise<SavedMeetingMinutesRecords>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<{ id: string; assignee_person_id?: string | null;
    assignee_display_name?: string | null }>;
  findExistingTask?(title: string, projectCodes: readonly string[]): Promise<{ id: string } | undefined>;
  resolveAssignee?(name: string, projectId: string): Promise<
    { status: "resolved"; personId: string } | { status: "unknown" | "ambiguous" | "unavailable" }
  >;
  postParent(channelId: string, fileName: string, summary: string, clientMsgId: string): Promise<string>;
  postTaskCard?(run: MeetingMinutesRun): Promise<string>;
  repairTaskBoard?(targetId: string): Promise<void>;
  postThreadChunk(channelId: string, threadTs: string, fileName: string, text: string,
    index: number, total: number, clientMsgId: string): Promise<string>;
}
export interface RedoMeetingMinutesOptions {
  destinations: readonly MeetingMinutesDestination[]; now?: () => Date;
  deleteGitHub(destination: MeetingMinutesDestination, paths: readonly string[]): Promise<void>;
  deleteTask(taskId: string, idempotencyKey: string): Promise<void>;
  retractSharedMinutes(destination: MeetingMinutesDestination, parentTs: string, fileName: string): Promise<void>;
  showDestinationSelection(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string>;
  showRedoFailure?(run: MeetingMinutesRun): Promise<void>;
}

function now(options: { now?: () => Date }): string { return (options.now?.() ?? new Date()).toISOString(); }

async function generateWithDiagnostics(fs: WorkspaceFs, run: MeetingMinutesRun, transcript: string,
  context: MeetingMinutesContextReceipt, options: ResumeMeetingMinutesOptions): Promise<AuditedGeneratedMeetingMinutes> {
  const candidate = await options.generate(transcript, run.destination!, context, options.contextMode,
    async (generation) => {
      run.diagnostics = { ...run.diagnostics, schemaVersion: "meeting_minutes_diagnostics.v1",
        stage: "generation", generation };
      run.updatedAt = now(options);
      await saveMeetingMinutesRun(fs, run);
    });
  if (candidate.generationDiagnostics) run.diagnostics = { ...run.diagnostics,
    schemaVersion: "meeting_minutes_diagnostics.v1", stage: "generation",
    generation: candidate.generationDiagnostics };
  delete candidate.generationDiagnostics;
  return candidate;
}
function destinationIsValid(value: MeetingMinutesDestination): boolean {
  const taskProjectCodes = value.taskProjectCodes;
  return /^[A-Za-z0-9_-]{1,128}$/.test(value.id) && !!value.projectId.trim() && !!value.name.trim() &&
    typeof value.contextProjectCode === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.contextProjectCode) &&
    typeof value.taskBoardTargetId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.taskBoardTargetId) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.organization?.id ?? "") && !!value.organization?.name.trim() &&
    /^[A-Z0-9]+$/.test(value.slackChannelId) && !!value.github.owner.trim() && !!value.github.repo.trim() &&
    (Array.isArray(taskProjectCodes) && taskProjectCodes.length > 0 &&
      taskProjectCodes.length <= 10 &&
      taskProjectCodes.every((code) => /^[A-Za-z0-9_-]{1,128}$/.test(code)) &&
      new Set(taskProjectCodes).size === taskProjectCodes.length);
}
export function validateMeetingMinutesDestinations(destinations: readonly MeetingMinutesDestination[]): void {
  if (!destinations.length || destinations.length > 25 || destinations.some((item) => !destinationIsValid(item)) ||
    new Set(destinations.map((item) => item.id)).size !== destinations.length ||
    destinations.some((item) => destinations.some((candidate) => candidate.organization.id === item.organization.id &&
      candidate.organization.name !== item.organization.name)) ||
    destinations.some((item) => destinations.some((candidate) => candidate.slackChannelId === item.slackChannelId &&
      candidate.organization.id !== item.organization.id))) {
    throw new Error("meeting_minutes_destinations_invalid");
  }
}

function sameDestination(left: MeetingMinutesDestination, right: MeetingMinutesDestination): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.name === right.name &&
    left.slackChannelId === right.slackChannelId && left.github.owner === right.github.owner &&
    left.github.repo === right.github.repo && (left.github.branch ?? "main") === (right.github.branch ?? "main") &&
    (left.github.pathPrefix ?? "") === (right.github.pathPrefix ?? "");
}

function sameDestinationOrganization(left: MeetingMinutesDestination, right: MeetingMinutesDestination): boolean {
  return !!left.organization && left.organization.id === right.organization.id &&
    left.organization.name === right.organization.name;
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
      workspaceId: event.workspaceId, sourceAppId: options.sourceAppId,
      sourceChannelId: event.channelId, sourceThreadTs: event.threadTs,
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

const SAFE_TASK_FAILURE_MESSAGES = new Set([
  "meeting_minutes_assignee_resolver_unconfigured", "meeting_minutes_assignee_unavailable",
  "meeting_minutes_task_invalid_response", "project_code_not_allowed", "task_scope_not_configured",
]);
const SAFE_TASK_FAILURE_CODES = new Set(["project_code_not_allowed", "task_scope_not_configured"]);

function safeTaskFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_TASK_FAILURE_MESSAGES.has(message) ? message : fallback;
}

function safeTaskFailureCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TASK_FAILURE_CODES.has(value) ? value : undefined;
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
          status: reconciliation.outcome, projectCodes: [...taskProjectCodes] });
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
      let task: { id: string; assignee_person_id?: string | null; assignee_display_name?: string | null };
      let reusedExisting = false;
      try {
        task = await options.createTask({ ...taskCandidate, ...(assignee_person_id ? { assignee_person_id } : {}),
          project_codes: taskProjectCodes },
          await taskIdempotencyKey(run.runId, run.revision ?? 0, index));
      } catch (error) {
        const conflict = error && typeof error === "object" && "status" in error && error.status === 409;
        const existing = conflict && options.findExistingTask
          ? await options.findExistingTask(candidate.title, taskProjectCodes)
          : undefined;
        if (!existing) throw error;
        task = existing;
        reusedExisting = true;
      }
      if (!task.id?.trim()) throw new Error("meeting_minutes_task_invalid_response");
      run.taskRegistration.registered.push({ index, title: candidate.title, taskId: task.id.trim(),
        projectCodes: [...taskProjectCodes],
        ...(reusedExisting ? { status: "reused" as const } : {}),
        ...(task.assignee_person_id ? { assigneePersonId: task.assignee_person_id } : {}),
        ...(task.assignee_display_name ? { assigneeDisplayName: task.assignee_display_name } : {}) });
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
  } catch (error) {
    const taskApiClassification = error && typeof error === "object"
      ? { code: "code" in error ? safeTaskFailureCode(error.code) : undefined,
        status: "status" in error && typeof error.status === "number" && Number.isInteger(error.status)
          ? error.status : undefined }
      : {};
    run.taskRegistration.failure = { index: activeIndex,
      stage: "task_registration",
      message: safeTaskFailureMessage(error, "meeting_minutes_task_registration_failed"),
      ...(taskApiClassification.code ? { code: taskApiClassification.code } : {}),
      ...(taskApiClassification.status ? { status: taskApiClassification.status } : {}),
      failedAt: now(options) };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    throw error;
  }
}

async function deferTaskIntegration(fs: WorkspaceFs, run: MeetingMinutesRun,
  stage: "task_registration" | "task_board" | "task_card", error: unknown,
  options: ResumeMeetingMinutesOptions): Promise<void> {
  run.taskRegistration ??= { registered: [] };
  const existingClassification = stage === "task_registration" ? run.taskRegistration.failure : undefined;
  run.taskRegistration.failure = { index: run.taskRegistration.failure?.index ??
    Math.max(0, run.taskRegistration.registered.length - 1), stage,
    message: safeTaskFailureMessage(error, `meeting_minutes_${stage}_failed`),
    ...(existingClassification?.code ? { code: existingClassification.code } : {}),
    ...(existingClassification?.status ? { status: existingClassification.status } : {}),
    failedAt: now(options) };
  const classified = classifyMeetingMinutesFailure("task_registration", error);
  run.diagnostics = { ...run.diagnostics, schemaVersion: "meeting_minutes_diagnostics.v1", ...classified,
    failedAt: now(options), checkpoint: { hasGitHub: Boolean(run.github), hasSlackParent: Boolean(run.slack?.parentTs),
      postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 } };
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
  if (run.diagnostics?.stage === "task_registration") {
    const receiptSnapshot = run.diagnostics.receiptSnapshot;
    run.diagnostics = { schemaVersion: "meeting_minutes_diagnostics.v1", ...(receiptSnapshot ? { receiptSnapshot } : {}) };
  }
  run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
}

export async function resumeMeetingMinutesRun(fs: WorkspaceFs, selection: MeetingMinutesSelection,
  options: ResumeMeetingMinutesOptions): Promise<MeetingMinutesRun> {
  validateMeetingMinutesDestinations(options.destinations);
  const run = await loadMeetingMinutesRun(fs, selection.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (run.workspaceId !== selection.workspaceId || run.sourceAppId !== selection.appId ||
    run.sourceChannelId !== selection.channelId || run.sourceThreadTs !== selection.threadTs) {
    throw new Error("meeting_minutes_selection_boundary_mismatch");
  }
  const configured = options.destinations.find((item) => item.id === selection.destinationId);
  if (!configured) throw new Error("meeting_minutes_destination_forbidden");
  if (run.destination && !sameDestination(run.destination, configured)) {
    throw new Error("meeting_minutes_destination_changed");
  }
  const contextProjectChanged = !!run.destination &&
    meetingMinutesContextProjectCode(run.destination) !== meetingMinutesContextProjectCode(configured);
  // GitHub保存済みの議事録で使ったReceiptは監査証跡として固定する。
  // ただしタスク・ボード連携は修正後の紐付けへ移行できるようにする。
  // GitHub保存前なら旧文脈から作った候補を破棄し、新しい紐付けで取得し直せる。
  if (contextProjectChanged && run.context && !run.github) {
    delete run.context;
    delete run.generated;
  }
  if (run.destination && (!sameDestinationOrganization(run.destination, configured) ||
    JSON.stringify(run.destination.taskProjectCodes) !== JSON.stringify(configured.taskProjectCodes) ||
    run.destination.taskBoardTargetId !== configured.taskBoardTargetId || contextProjectChanged)) {
    // organization is trusted credential-routing metadata. Refresh it when the
    // immutable Slack/GitHub destination still matches so pre-fix runs can retry.
    run.destination.organization = structuredClone(configured.organization);
    run.destination.taskProjectCodes = [...configured.taskProjectCodes];
    if (!run.context) run.destination.contextProjectCode = configured.contextProjectCode;
    run.destination.taskBoardTargetId = configured.taskBoardTargetId;
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
  }
  if (run.approvedBy && run.approvedBy !== selection.userId) throw new Error("meeting_minutes_approver_changed");
  if (run.generated) {
    try {
      assertGeneratedMeetingMinutesNotPlaceholder(run.generated);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "meeting_minutes_generation_placeholder_output") throw error;
      if (!run.github) {
        delete run.generated;
        delete run.failure;
        run.status = "routed";
        run.updatedAt = now(options);
        await saveMeetingMinutesRun(fs, run);
      } else {
        run.status = "completed";
        run.failure = { stage: "generated", message: "meeting_minutes_persisted_placeholder_output" };
        run.updatedAt = now(options);
        await saveMeetingMinutesRun(fs, run);
        return run;
      }
    }
  }
  if (run.status === "completed") {
    if (run.taskRegistration?.failure && run.destination && run.transcriptSha256) {
      const retryStage = run.taskRegistration.failure.stage;
      if (retryStage === "task_card") {
        if (run.slack?.taskCardTs) {
          await clearTaskIntegrationPending(fs, run, options);
          return run;
        }

        if (!run.taskRegistration.registered.length || !run.slack?.parentTs || !options.postTaskCard) return run;

        await markTaskIntegrationPending(fs, run, "task_card", options);
        try {
          run.slack.taskCardTs = await options.postTaskCard(run);
          run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
        } catch (error) {
          await deferTaskIntegration(fs, run, "task_card", error, options);
          return run;
        }
        await clearTaskIntegrationPending(fs, run, options);
        return run;
      }
      try {
        const receipt = await options.resolveContext({ run_id: run.runId,
          project_code: meetingMinutesContextProjectCode(run.destination),
          transcript_sha256: run.transcriptSha256 }, run.context?.receiptId);
        assertMeetingMinutesContextUsable(receipt, options.contextMode);
        await registerGeneratedTasks(fs, run, receipt, options);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_registration", error, options);
        console.error(JSON.stringify({ event: "meeting_minutes_task_registration_retry_failed",
          ...meetingMinutesFailureLog(run) }));
        return run;
      }
      if (run.taskRegistration.registered.length && options.repairTaskBoard) {
        await markTaskIntegrationPending(fs, run, "task_board", options);
        try {
          await options.repairTaskBoard(run.destination.taskBoardTargetId);
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
  if (!run.github && options.contextMode === "required" && run.context &&
    (run.context.status === "partial" || run.context.status === "unavailable")) {
    delete run.context;
    delete run.generated;
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
  let transcript = "";
  let contextReceipt: MeetingMinutesContextReceipt | undefined;
  let diagnosticStage: MeetingMinutesDiagnosticStage = "slack_publish";
  try {
    if (!run.slack.processingTs) {
      run.slack.processingTs = await options.postProcessingStatus(run);
      run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    diagnosticStage = "transcript_download";
    if (!run.github || !run.context) {
      transcript = await options.download(run.file.id);
      if (!transcript.trim()) throw new Error("meeting_minutes_transcript_empty");
      const transcriptSha256 = await digest(transcript);
      if (run.transcriptSha256 && run.transcriptSha256 !== transcriptSha256) throw new Error("meeting_minutes_transcript_changed");
      run.transcriptSha256 ??= transcriptSha256;
    }
    const contextIdentity = { run_id: run.runId, project_code: meetingMinutesContextProjectCode(run.destination),
      transcript_sha256: run.transcriptSha256! };
    diagnosticStage = "context_resolve";
    contextReceipt = await options.resolveContext(contextIdentity, run.context?.receiptId);
    diagnosticStage = "context_gate";
    run.diagnostics = { schemaVersion: "meeting_minutes_diagnostics.v1", stage: diagnosticStage,
      receiptSnapshot: meetingMinutesReceiptSnapshot(contextReceipt) };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
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
      diagnosticStage = "generation";
      if (!run.generated) {
        const candidate = await generateWithDiagnostics(fs, run, transcript, contextReceipt, options);
        run.generated = bindGeneratedMeetingMinutesContext(candidate, contextReceipt, options.contextMode);
        run.status = "generated";
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      } else {
        try {
          run.generated = bindGeneratedMeetingMinutesContext(run.generated, contextReceipt, options.contextMode);
        } catch (error) {
          if (!(error instanceof Error) || !["meeting_minutes_context_source_ref_unknown",
            "meeting_minutes_context_attestation_mismatch"].includes(error.message)) throw error;
          diagnosticStage = "generation";
          const candidate = await generateWithDiagnostics(fs, run, transcript, contextReceipt, options);
          run.generated = bindGeneratedMeetingMinutesContext(candidate, contextReceipt, options.contextMode);
        }
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      }
      diagnosticStage = "github_save";
      run.github = await options.saveGitHub({ destination: run.destination, transcript, minutes: run.generated,
        sourceFileName: run.file.name, sourceTs: run.sourceMessageTs });
      run.status = "github_saved"; run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    const parentText = `*${run.generated!.title}*\n${run.generated!.overview}`;
    const body = stripMeetingMinutesActionItems(run.generated!.body).trimStart();
    const narrativeText = body.startsWith("------------") ? body : `------------\n\n${body}`;
    const chunks = splitMeetingMinutesForSlack(narrativeText);
    run.slack ??= { postedChunkIndexes: [] };
    diagnosticStage = "slack_publish";
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
      diagnosticStage = "task_registration";
      await registerGeneratedTasks(fs, run, contextReceipt, options);
    } catch (error) {
      await deferTaskIntegration(fs, run, "task_registration", error, options);
      console.error(JSON.stringify({ event: "meeting_minutes_task_registration_deferred",
        ...meetingMinutesFailureLog(run) }));
      return run;
    }
    if (run.taskRegistration?.registered.length && options.repairTaskBoard) {
      await markTaskIntegrationPending(fs, run, "task_board", options);
      try {
        await options.repairTaskBoard(run.destination.taskBoardTargetId);
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
    const classified = classifyMeetingMinutesFailure(diagnosticStage, error);
    const generationDiagnostics = error && typeof error === "object" && "generationDiagnostics" in error
      ? (error as { generationDiagnostics?: MeetingMinutesGenerationDiagnostics }).generationDiagnostics
      : undefined;
    run.status = "failed";
    run.failure = { stage: failedStage, message: error instanceof Error ? error.message : "meeting_minutes_failed" };
    run.diagnostics = { ...run.diagnostics, schemaVersion: "meeting_minutes_diagnostics.v1", ...classified,
      ...(generationDiagnostics ? { generation: generationDiagnostics } : {}),
      failedAt: now(options), checkpoint: { hasGitHub: Boolean(run.github),
        hasSlackParent: Boolean(run.slack?.parentTs), postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 } };
    run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run); throw error;
  }
}

export async function redoMeetingMinutesRun(fs: WorkspaceFs, command: MeetingMinutesRedo,
  options: RedoMeetingMinutesOptions): Promise<MeetingMinutesRun> {
  validateMeetingMinutesDestinations(options.destinations);
  const run = await loadMeetingMinutesRun(fs, command.runId);
  if (!run) throw new Error("meeting_minutes_run_not_found");
  if (run.workspaceId !== command.workspaceId || run.sourceAppId !== command.appId ||
    run.sourceChannelId !== command.channelId || run.sourceThreadTs !== command.threadTs) {
    throw new Error("meeting_minutes_redo_boundary_mismatch");
  }
  if (run.status !== "completed" || !run.destination || !run.github || !run.slack?.processingTs) {
    throw new Error("meeting_minutes_redo_not_available");
  }
  const redoRevision = run.revision ?? 0;
  if (!run.redo || run.redo.revision !== redoRevision) {
    run.redo = { revision: redoRevision, requestedAt: now(options), deletedTaskIds: [] };
    run.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, run);
  }
  const redoState = run.redo;
  try {
    delete redoState.failure;
    if (!redoState.githubDeletedAt) {
      await options.deleteGitHub(run.destination, [run.github.transcriptPath, run.github.minutesPath]);
      redoState.githubDeletedAt = now(options); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    for (const task of run.taskRegistration?.registered ?? []) {
      if (redoState.deletedTaskIds.includes(task.taskId)) continue;
      await options.deleteTask(task.taskId, `meeting-minutes-redo-${run.runId}-revision-${redoRevision}-${task.index}`);
      redoState.deletedTaskIds.push(task.taskId); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    if (run.slack.parentTs && !redoState.sharedRetractedAt) {
      await options.retractSharedMinutes(run.destination, run.slack.parentTs, run.file.name);
      redoState.sharedRetractedAt = now(options); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    const selectionTs = await options.showDestinationSelection(structuredClone(run), options.destinations);
    run.status = "awaiting_destination";
    run.revision = redoRevision + 1;
    delete run.destination; delete run.approvedBy; delete run.context; delete run.generated; delete run.github;
    delete run.taskRegistration; delete run.failure; delete run.redo;
    run.slack = { selectionTs, postedChunkIndexes: [] };
    run.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, run);
    return run;
  } catch (error) {
    redoState.failure = { message: error instanceof Error ? error.message : "meeting_minutes_redo_failed",
      failedAt: now(options) };
    run.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, run);
    if (options.showRedoFailure) {
      try { await options.showRedoFailure(run); }
      catch (notificationError) {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_failure_projection_failed", runId: run.runId,
          error: notificationError instanceof Error ? notificationError.message : "unexpected_error" }));
      }
    }
    throw error;
  }
}
