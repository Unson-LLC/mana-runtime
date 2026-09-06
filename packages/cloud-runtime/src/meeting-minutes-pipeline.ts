import { isMeetingMinutesFile, meetingMinutesRunId, type AuditedGeneratedMeetingMinutes, type GeneratedMeetingMinutes,
  type MeetingMinutesContextMode, type MeetingMinutesContextReceipt,
  type MeetingMinutesDestination, type MeetingMinutesDiagnosticStage, type MeetingMinutesGenerationDiagnostics,
  type MeetingMinutesRun, type MeetingMinutesSelection,
  type MeetingMinutesRedo, type MeetingMinutesRedoStage, type MeetingMinutesTaskCandidate,
  meetingMinutesContextProjectCode, meetingMinutesTaskProjectCodes } from "./meeting-minutes-contracts.js";
import type { CreateTaskInput, UpdateTaskInput } from "@openryoko/task-runtime-core";
import { assertGeneratedMeetingMinutesNotPlaceholder, splitMeetingMinutesForSlack,
  stripMeetingMinutesActionItems } from "./meeting-minutes-generator.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import type { SavedMeetingMinutesRecords } from "./meeting-minutes-github.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { assertMeetingMinutesContextUsable, bindGeneratedMeetingMinutesContext,
  reconcileMeetingMinutesTask } from "./meeting-minutes-brainbase-context.js";
import { classifyMeetingMinutesFailure, classifyMeetingMinutesRedoFailure, meetingMinutesFailureLog,
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
  resolveContext(identity: MeetingMinutesContextReceipt["identity"], receiptId?: string,
    projectId?: string): Promise<MeetingMinutesContextReceipt>;
  postProcessingStatus(run: MeetingMinutesRun): Promise<string>;
  download(fileId: string): Promise<string>;
  generate(transcript: string, destination: MeetingMinutesDestination, context: MeetingMinutesContextReceipt,
    mode: MeetingMinutesContextMode,
    observe?: (diagnostics: MeetingMinutesGenerationDiagnostics) => Promise<void>): Promise<AuditedGeneratedMeetingMinutes>;
  saveGitHub(input: { destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
    sourceFileName: string; sourceTs: string }): Promise<SavedMeetingMinutesRecords>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<{ id: string; assignee_person_id?: string | null;
    assignee_display_name?: string | null; version?: number; project_codes?: string[] }>;
  updateTask?(taskId: string, input: UpdateTaskInput, idempotencyKey: string): Promise<{ id: string;
    assignee_person_id?: string | null; assignee_display_name?: string | null; version?: number; project_codes?: string[] }>;
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

async function taskScopeUpdateIdempotencyKey(runId: string, revision: number, index: number): Promise<string> {
  return `meeting-minutes-${await digest(`${runId}:revision:${revision}:task:${index}:scope-update`)}`;
}

const SAFE_TASK_FAILURE_MESSAGES = new Set([
  "meeting_minutes_assignee_resolver_unconfigured", "meeting_minutes_assignee_unavailable",
  "meeting_minutes_task_invalid_response", "project_code_not_allowed", "task_scope_not_configured",
]);
const SAFE_TASK_FAILURE_CODES = new Set(["project_code_not_allowed", "task_scope_not_configured",
  "idempotency_conflict", "canonical_task_operation_in_progress",
  "CREDENTIAL_LEASE_SCOPE_MISMATCH", "CREDENTIAL_FORWARDING_UNAVAILABLE",
  "PROVIDER_OPERATION_UNSUPPORTED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_INVALID_RESPONSE"]);

function safeTaskFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : "";
  return SAFE_TASK_FAILURE_MESSAGES.has(message) || /^task_board_[a-z0-9_-]{1,96}$/u.test(message)
    ? message : fallback;
}

function safeTaskFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const isMachineCode = /^[a-z][a-z0-9_]{2,96}$/u.test(value)
    || /^[A-Z][A-Z0-9_]{2,96}$/u.test(value);
  return SAFE_TASK_FAILURE_CODES.has(value) || isMachineCode ? value : undefined;
}

function safeTaskBoundaryDetail(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(value)
    ? value : undefined;
}

async function registerGeneratedTasks(fs: WorkspaceFs, run: MeetingMinutesRun,
  receipt: MeetingMinutesContextReceipt, options: ResumeMeetingMinutesOptions): Promise<void> {
  const tasks: MeetingMinutesTaskCandidate[] = run.generated?.tasks ?? [];
  const taskProjectCodes = meetingMinutesTaskProjectCodes(run.destination!);
  run.taskRegistration ??= { registered: [] };
  let activeIndex = 0;
  let failurePoint: NonNullable<NonNullable<MeetingMinutesRun["taskRegistration"]>["failure"]>["failurePoint"];
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
        failurePoint = "assignee_resolution";
        if (!options.resolveAssignee) throw new Error("meeting_minutes_assignee_resolver_unconfigured");
        const resolution = await options.resolveAssignee(candidate.assignee_name, taskProjectCodes[0]!);
        if (resolution.status === "resolved") assignee_person_id = resolution.personId;
        else console.warn("meeting_minutes_assignee_unresolved", {
          runId: run.runId, taskIndex: index, status: resolution.status,
        });
      }
      const { assignee_name: _assigneeName, ...taskCandidate } = candidate;
      const registeredScopes = run.taskRegistration.registered
        .map((item) => item.projectCodes?.join("\0"))
        .filter((scope): scope is string => typeof scope === "string");
      failurePoint = "task_create";
      const legacyConflictScope = !run.taskRegistration.pending && run.taskRegistration.failure?.status === 409
        && registeredScopes.length > 0 && new Set(registeredScopes).size === 1
        ? registeredScopes[0]!.split("\0") : undefined;
      if (!run.taskRegistration.pending && run.taskRegistration.failure?.status === 409 && !legacyConflictScope) {
        throw Object.assign(new Error("meeting_minutes_task_registration_failed"),
          { status: 409, code: "idempotency_conflict" });
      }
      const pending = run.taskRegistration.pending?.index === index
        ? run.taskRegistration.pending
        : { index, idempotencyKey: await taskIdempotencyKey(run.runId, run.revision ?? 0, index),
          input: { ...taskCandidate, ...(assignee_person_id ? { assignee_person_id } : {}),
            project_codes: legacyConflictScope ?? taskProjectCodes } };
      if (run.taskRegistration.pending !== pending) {
        run.taskRegistration.pending = pending;
        run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
      }
      let task = await options.createTask(pending.input, pending.idempotencyKey);
      if (!task.id?.trim()) throw new Error("meeting_minutes_task_invalid_response");
      const pendingProjectCodes = pending.input.project_codes ?? [];
      // Canonical Task API exposes project_codes on CanonicalTask and accepts project_codes with
      // expected_version on UpdateTaskInput. Prefer the create recovery readback: a prior PATCH may
      // have committed even when its response was lost.
      const recoveredProjectCodes = Array.isArray(task.project_codes) ? task.project_codes : pendingProjectCodes;
      if (recoveredProjectCodes.join("\0") !== taskProjectCodes.join("\0")) {
        if (!Number.isInteger(task.version) || !options.updateTask) throw new Error("meeting_minutes_task_invalid_response");
        failurePoint = "task_scope_update";
        task = await options.updateTask(task.id.trim(), { expected_version: task.version!,
          project_codes: [...taskProjectCodes] },
        await taskScopeUpdateIdempotencyKey(run.runId, run.revision ?? 0, index));
        if (!task.id?.trim()) throw new Error("meeting_minutes_task_invalid_response");
      }
      run.taskRegistration.registered.push({ index, title: candidate.title, taskId: task.id.trim(),
        projectCodes: [...taskProjectCodes],
        ...(task.assignee_person_id ? { assigneePersonId: task.assignee_person_id } : {}),
        ...(task.assignee_display_name ? { assigneeDisplayName: task.assignee_display_name } : {}) });
      delete run.taskRegistration.pending;
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
      ...(failurePoint ? { failurePoint } : {}),
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
  const boundaryCode = error && typeof error === "object" && "code" in error
    ? safeTaskFailureCode(error.code) : undefined;
  const boundary = error && typeof error === "object" && "boundary" in error
    ? safeTaskBoundaryDetail(error.boundary) : undefined;
  const scopeReason = error && typeof error === "object" && "details" in error
    && error.details && typeof error.details === "object" && "scope_reason" in error.details
    ? safeTaskBoundaryDetail(error.details.scope_reason) : undefined;
  run.taskRegistration.failure = { index: run.taskRegistration.failure?.index ??
    Math.max(0, run.taskRegistration.registered.length - 1), stage,
    message: safeTaskFailureMessage(error, `meeting_minutes_${stage}_failed`),
    ...(existingClassification?.failurePoint ? { failurePoint: existingClassification.failurePoint } : {}),
    ...(existingClassification?.code ? { code: existingClassification.code } : {}),
    ...(boundaryCode ? { code: boundaryCode } : {}),
    ...(boundary ? { boundary } : {}),
    ...(scopeReason ? { scopeReason } : {}),
    ...(existingClassification?.status ? { status: existingClassification.status } : {}),
    failedAt: now(options) };
  const classified = classifyMeetingMinutesFailure("task_registration", error);
  run.diagnostics = { ...run.diagnostics, schemaVersion: "meeting_minutes_diagnostics.v1", ...classified,
    failedAt: now(options), checkpoint: { hasGitHub: Boolean(run.github), hasSlackParent: Boolean(run.slack?.parentTs),
      postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 } };
  run.status = "completed"; delete run.failure; run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  console.error(JSON.stringify({ event: `meeting_minutes_${stage}_deferred`,
    ...meetingMinutesFailureLog(run) }));
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
  const resumedPersistedOutput = Boolean(run.github && run.slack?.parentTs);
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
          transcript_sha256: run.transcriptSha256 }, run.context?.receiptId, run.destination.projectId);
        assertMeetingMinutesContextUsable(receipt, options.contextMode);
        await registerGeneratedTasks(fs, run, receipt, options);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_registration", error, options);
        console.error(JSON.stringify({ event: "meeting_minutes_task_registration_retry_failed",
          ...meetingMinutesFailureLog(run) }));
        return run;
      }
      // A task-board repair rebuilds the board from the destination project,
      // not from this run's local registration receipts. Older runs can carry
      // a task_board failure with an empty registered array after a partial
      // state migration, so honor that explicit retry stage independently.
      if ((run.taskRegistration.registered.length || retryStage === "task_board") && options.repairTaskBoard) {
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
    } else if (run.destination && options.repairTaskBoard) {
      // A completed run can outlive a stale Slack retry button or a downstream
      // task-board queue failure. Treat an explicit repeated selection as a
      // reconciliation request even when the persisted failure and local task
      // receipts were already cleared. The repair rebuilds from the destination
      // project, so it does not need to recreate tasks from this run.
      await markTaskIntegrationPending(fs, run, "task_board", options);
      try {
        await options.repairTaskBoard(run.destination.taskBoardTargetId);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_board", error, options);
        return run;
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
    contextReceipt = await options.resolveContext(contextIdentity, run.context?.receiptId, run.destination.projectId);
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
    if ((run.taskRegistration?.registered.length || resumedPersistedOutput) && options.repairTaskBoard) {
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
    const safeFailureReason = error instanceof Error && /^meeting_minutes_[a-z0-9_:.-]+$/.test(error.message)
      ? error.message : undefined;
    console.error(JSON.stringify({
      event: "meeting_minutes_pipeline_failed",
      run_id: run.runId,
      failure_stage: classified.stage,
      failure_code: classified.code,
      failure_retryable: classified.retryable,
      ...(safeFailureReason ? { failure_reason: safeFailureReason } : {}),
      ...(error instanceof Error ? { error_name: error.name.slice(0, 64) } : {}),
      ...(generationDiagnostics ? {
        generation_outcome: generationDiagnostics.outcome,
        generation_stderr_code: generationDiagnostics.stderrCode,
        generation_exit_code: generationDiagnostics.exitCode,
        generation_elapsed_ms: generationDiagnostics.elapsedMs,
        generation_progress: generationDiagnostics.progress,
      } : {}),
    }));
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
  const requestedRevision = command.revision ?? 0;
  const persistedRevision = run.revision ?? 0;
  if (requestedRevision !== persistedRevision) {
    // An old button is terminal, not a transient queue failure. Never project
    // its result onto the current generation's status message.
    console.info(JSON.stringify({ event: "meeting_minutes_redo_superseded", runId: run.runId,
      requestedRevision, currentRevision: persistedRevision }));
    return run;
  }
  if (run.status !== "completed" || !run.destination || !run.github || !run.slack?.processingTs) {
    throw new Error("meeting_minutes_redo_not_available");
  }
  const redoRevision = persistedRevision;
  if (!run.redo || run.redo.revision !== redoRevision) {
    run.redo = { revision: redoRevision, requestedAt: now(options), deletedTaskIds: [] };
    run.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, run);
  }
  const redoState = run.redo;
  let redoStage: MeetingMinutesRedoStage = "redo_github_delete";
  try {
    delete redoState.failure;
    if (run.taskRegistration?.pending) {
      redoStage = "redo_task_delete";
      throw new Error("meeting_minutes_redo_task_registration_pending");
    }
    if (!redoState.githubDeletedAt) {
      await options.deleteGitHub(run.destination, [run.github.transcriptPath, run.github.minutesPath]);
      redoState.githubDeletedAt = now(options); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    redoStage = "redo_task_delete";
    for (const task of run.taskRegistration?.registered ?? []) {
      if (task.status !== undefined && task.status !== "registered") continue;
      if (redoState.deletedTaskIds.includes(task.taskId)) continue;
      await options.deleteTask(task.taskId, `meeting-minutes-redo-${run.runId}-revision-${redoRevision}-${task.index}`);
      redoState.deletedTaskIds.push(task.taskId); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    redoStage = "redo_slack_retract";
    if (run.slack.parentTs && !redoState.sharedRetractedAt) {
      await options.retractSharedMinutes(run.destination, run.slack.parentTs, run.file.name);
      redoState.sharedRetractedAt = now(options); run.updatedAt = now(options); await saveMeetingMinutesRun(fs, run);
    }
    redoStage = "redo_destination_selection";
    const selectionTs = await options.showDestinationSelection(structuredClone(run), options.destinations);
    // Keep the completed run and its redo checkpoint intact until the final
    // state write succeeds.  If this write fails, the catch block must be
    // able to persist the checkpoint and leave the redo action retryable.
    const nextRun = structuredClone(run);
    nextRun.status = "awaiting_destination";
    nextRun.revision = redoRevision + 1;
    delete nextRun.destination; delete nextRun.approvedBy; delete nextRun.context; delete nextRun.generated; delete nextRun.github;
    delete nextRun.taskRegistration; delete nextRun.failure; delete nextRun.redo;
    nextRun.slack = { selectionTs, postedChunkIndexes: [] };
    nextRun.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, nextRun);
    return nextRun;
  } catch (error) {
    const diagnostic = classifyMeetingMinutesRedoFailure(redoStage, error);
    redoState.failure = { ...diagnostic, message: diagnostic.code, failedAt: now(options) };
    run.updatedAt = now(options);
    await saveMeetingMinutesRun(fs, run);
    console.error(JSON.stringify({ event: "meeting_minutes_redo_failed", ...meetingMinutesFailureLog(run) }));
    if (options.showRedoFailure) {
      try { await options.showRedoFailure(run); }
      catch {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_failure_projection_failed", runId: run.runId,
          stage: "status_projection", code: "STATUS_PROJECTION_FAILED", retryable: true }));
      }
    }
    throw error;
  }
}
