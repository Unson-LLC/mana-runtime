import type { CreateTaskInput } from "@openryoko/task-runtime-core";
import { meetingMinutesTaskProjectCodes, type MeetingMinutesContextReceipt,
  type MeetingMinutesRun, type MeetingMinutesTaskCandidate } from "./meeting-minutes-contracts.js";
import type { ResumeMeetingMinutesOptions } from "./meeting-minutes-pipeline.js";
import type { WorkspaceFs } from "./workspace-store.js";
import { saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import { reconcileMeetingMinutesTask } from "./meeting-minutes-brainbase-context.js";
import { classifyMeetingMinutesFailure, meetingMinutesFailureLog } from "./meeting-minutes-diagnostics.js";

function now(options: { now?: () => Date }): string { return (options.now?.() ?? new Date()).toISOString(); }

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

/** Initial delivery and retries share the same checkpointed downstream workflow. */
export async function resumeMeetingMinutesTaskIntegration(fs: WorkspaceFs, run: MeetingMinutesRun,
  options: ResumeMeetingMinutesOptions, input: {
    startAt: "task_registration" | "task_board" | "task_card";
    reconcileBoard?: boolean;
    resolveContext(): Promise<MeetingMinutesContextReceipt>;
  }): Promise<MeetingMinutesRun> {
  run.taskRegistration ??= { registered: [] };
  if (input.startAt === "task_registration") {
    const needsRegistration = (run.generated?.tasks ?? []).some((_, index) =>
      !run.taskRegistration!.registered.some((item) => item.index === index));
    if (needsRegistration) {
      try {
        await registerGeneratedTasks(fs, run, await input.resolveContext(), options);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_registration", error, options);
        return run;
      }
    }
  }
  if (input.startAt !== "task_card" &&
    (run.taskRegistration.registered.length || input.reconcileBoard)) {
    if (input.startAt === "task_board" && !options.repairTaskBoard) return run;
    if (options.repairTaskBoard) {
      await markTaskIntegrationPending(fs, run, "task_board", options);
      try {
        await options.repairTaskBoard(run.destination!.taskBoardTargetId);
      } catch (error) {
        await deferTaskIntegration(fs, run, "task_board", error, options);
        return run;
      }
    }
  }
  if (input.startAt === "task_card" && !run.slack?.taskCardTs &&
    (!run.taskRegistration.registered.length || !run.slack?.parentTs || !options.postTaskCard)) return run;
  if (run.taskRegistration.registered.length && run.slack?.parentTs &&
    !run.slack.taskCardTs && options.postTaskCard) {
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
  run.status = "completed"; run.updatedAt = now(options);
  await saveMeetingMinutesRun(fs, run);
  return run;
}
