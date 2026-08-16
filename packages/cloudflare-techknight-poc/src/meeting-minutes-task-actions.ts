import type { CanonicalTask, UpdateTaskInput } from "@openryoko/task-runtime-core";
import { MEETING_MINUTES_TASK_CANCEL_ACTION_ID, MEETING_MINUTES_TASK_EDIT_ACTION_ID,
  MEETING_MINUTES_TASK_EDIT_VIEW_ID, MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID,
  meetingMinutesTaskProjectCodes, type MeetingMinutesDestination, type MeetingMinutesRun } from "./meeting-minutes-contracts.js";
import { MEETING_MINUTES_ASSIGNEE_NONE, meetingMinutesTaskEditViewFromAction } from "./meeting-minutes-task-cards.js";
import type { GraphPersonOption } from "./brainbase-graph-runtime.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
type ActionMetadata = { runId: string; index: number; organizationId?: string; channelId?: string; projectId?: string;
  title?: string; due?: string; assigneePersonId?: string; assigneeDisplayName?: string };
function metadata(value: unknown): ActionMetadata | undefined {
  try { const parsed = object(JSON.parse(text(value) ?? "")); const runId = text(parsed?.runId); const index = parsed?.index;
    return runId && Number.isInteger(index) && Number(index) >= 0 ? { runId, index: Number(index),
      organizationId: text(parsed?.organizationId), channelId: text(parsed?.channelId), projectId: text(parsed?.projectId),
      title: text(parsed?.title), due: text(parsed?.due), assigneePersonId: text(parsed?.assigneePersonId),
      assigneeDisplayName: text(parsed?.assigneeDisplayName) } : undefined; }
  catch { return undefined; }
}
export interface MeetingMinutesTaskActionDependencies {
  sourceTeamId: string; destinationTeamIds: Readonly<Record<string, string>>;
  destinations: readonly MeetingMinutesDestination[];
  operatorUserIds: ReadonlySet<string>;
  loadRun(runId: string): Promise<MeetingMinutesRun | undefined>;
  saveRun(run: MeetingMinutesRun): Promise<void>;
  getTask(taskId: string): Promise<CanonicalTask>;
  updateTask(taskId: string, input: UpdateTaskInput, idempotencyKey: string): Promise<CanonicalTask>;
  deleteTask(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<unknown>;
  updateCard(run: MeetingMinutesRun): Promise<void>;
  notifyScopeMismatch(run: MeetingMinutesRun, userId: string): Promise<void>;
  openView(organizationId: string, triggerId: string, view: Record<string, unknown>): Promise<void>;
  listPeople(): Promise<GraphPersonOption[] | undefined>;
  repairTaskBoard(targetId: string): Promise<void>;
  defer(work: Promise<void>): void;
}
async function reconcileTaskDestination(run: MeetingMinutesRun,
  deps: MeetingMinutesTaskActionDependencies): Promise<void> {
  const current = run.destination && deps.destinations.find((item) => item.id === run.destination?.id);
  if (!run.destination || !current) throw new Error("meeting_minutes_destination_forbidden");
  const changed = JSON.stringify(run.destination.taskProjectCodes) !== JSON.stringify(current.taskProjectCodes) ||
    run.destination.taskBoardTargetId !== current.taskBoardTargetId;
  if (!changed) return;
  run.destination.taskProjectCodes = [...current.taskProjectCodes];
  run.destination.taskBoardTargetId = current.taskBoardTargetId;
  run.updatedAt = new Date().toISOString();
  await deps.saveRun(run);
}
function candidate(run: MeetingMinutesRun, index: number) {
  return run.taskRegistration?.registered.find((item) => item.index === index && item.status !== "removed");
}
function status(error: unknown): number | undefined { return object(error)?.status as number | undefined; }
function sameTaskScope(actual: readonly string[] | undefined, expected: readonly string[] | undefined): boolean {
  return Boolean(actual && expected && actual.length === expected.length && expected.every((code) => actual.includes(code)));
}
function trustedLegacyTaskScopes(run: MeetingMinutesRun,
  item: NonNullable<MeetingMinutesRun["taskRegistration"]>["registered"][number]): string[][] {
  const candidates = [item.projectCodes, run.destination?.taskProjectCodes,
    run.destination?.projectId ? [run.destination.projectId] : undefined]
    .filter((scope): scope is string[] => Boolean(scope?.length));
  return candidates.filter((scope, index) => candidates.findIndex((candidate) => sameTaskScope(scope, candidate)) === index);
}
function allowed(payload: ObjectValue, run: MeetingMinutesRun, deps: MeetingMinutesTaskActionDependencies): boolean {
  const teamId = text(object(payload.team)?.id); const channelId = text(object(payload.channel)?.id);
  const expectedTeam = deps.destinationTeamIds[run.destination?.organization.id ?? ""] ?? deps.sourceTeamId;
  return teamId === expectedTeam && (!channelId || channelId === run.destination?.slackChannelId);
}
export async function handleMeetingMinutesTaskAction(payload: ObjectValue,
  deps: MeetingMinutesTaskActionDependencies): Promise<Response | undefined> {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = actions.length === 1 ? object(actions[0]) : undefined;
  const isBlockSuggestion = payload.type === "block_suggestion";
  const actionId = text(payload.action_id) ?? text(action?.action_id); const view = object(payload.view);
  const callbackId = text(view?.callback_id);
  if (isBlockSuggestion) console.info("meeting_minutes_block_suggestion_received", {
    actionId: actionId ?? "missing", hasTopLevelValue: Boolean(text(payload.value)), hasActionValue: Boolean(text(action?.value)),
  });
  if (payload.type === "block_suggestion" && actionId === MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID) {
    const value = metadata(view?.private_metadata); const userId = text(object(payload.user)?.id);
    const teamId = text(object(payload.team)?.id); const expectedTeam = value?.organizationId && deps.destinationTeamIds[value.organizationId];
    if (!value || !userId || !deps.operatorUserIds.has(userId) || teamId !== expectedTeam) {
      console.warn("meeting_minutes_assignee_suggestion_forbidden", {
        hasMetadata: Boolean(value), hasUserId: Boolean(userId), operatorAllowed: Boolean(userId && deps.operatorUserIds.has(userId)),
        teamMatched: Boolean(teamId && expectedTeam && teamId === expectedTeam),
      });
      return Response.json({ error: "meeting_minutes_task_action_forbidden" }, { status: 403 });
    }
    const people = await deps.listPeople();
    if (!people) {
      console.error("meeting_minutes_assignee_graph_unavailable");
      return Response.json({ error: "meeting_minutes_graph_unavailable" }, { status: 503 });
    }
    const query = (text(payload.value) ?? text(action?.value) ?? "").normalize("NFKC").toLocaleLowerCase("ja");
    const matches = people.filter((person) => !query || [person.name, ...person.aliases]
      .some((name) => name.normalize("NFKC").toLocaleLowerCase("ja").includes(query))).slice(0, 99);
    console.info("meeting_minutes_assignee_suggestion_ready", { peopleCount: people.length, matchCount: matches.length });
    return Response.json({ options: [
      { text: { type: "plain_text", text: "（担当なし）" }, value: MEETING_MINUTES_ASSIGNEE_NONE },
      ...matches.map((person) => ({ text: { type: "plain_text", text: person.name.slice(0, 75) }, value: person.id })),
    ].slice(0, 100) });
  }
  if (actionId !== MEETING_MINUTES_TASK_EDIT_ACTION_ID && actionId !== MEETING_MINUTES_TASK_CANCEL_ACTION_ID &&
    callbackId !== MEETING_MINUTES_TASK_EDIT_VIEW_ID) return undefined;
  const value = callbackId ? metadata(view?.private_metadata) : metadata(action?.value);
  if (!value) return Response.json({ error: "meeting_minutes_task_action_invalid" }, { status: 400 });
  const userId = text(object(payload.user)?.id);
  if (!userId || !deps.operatorUserIds.has(userId)) return Response.json({ error: "meeting_minutes_task_action_forbidden" }, { status: 403 });
  if (actionId === MEETING_MINUTES_TASK_EDIT_ACTION_ID) {
    const triggerId = text(payload.trigger_id); const teamId = text(object(payload.team)?.id); const channelId = text(object(payload.channel)?.id);
    const expectedTeam = value.organizationId && deps.destinationTeamIds[value.organizationId];
    if (!triggerId || !value.organizationId || !value.channelId || !value.title || teamId !== expectedTeam || channelId !== value.channelId)
      return Response.json({ error: "meeting_minutes_task_action_forbidden" }, { status: 403 });
    deps.defer(deps.openView(value.organizationId, triggerId, meetingMinutesTaskEditViewFromAction({ runId: value.runId,
      index: value.index, title: value.title, due: value.due, organizationId: value.organizationId,
      channelId: value.channelId, projectId: value.projectId, assigneePersonId: value.assigneePersonId,
      assigneeDisplayName: value.assigneeDisplayName })));
    return Response.json({ ok: true });
  }
  const run = await deps.loadRun(value.runId); const item = run && candidate(run, value.index);
  if (!run || !run.destination || !item || !allowed(payload, run, deps)) {
    return Response.json({ error: "meeting_minutes_task_action_forbidden" }, { status: 403 });
  }
  const legacyTaskScopes = trustedLegacyTaskScopes(run, item);
  await reconcileTaskDestination(run, deps);
  const currentTaskScope = meetingMinutesTaskProjectCodes(run.destination);
  if (actionId === MEETING_MINUTES_TASK_CANCEL_ACTION_ID) {
    deps.defer((async () => { let current: CanonicalTask;
      try { current = await deps.getTask(item.taskId); }
      catch (error) { if (status(error) !== 404) throw error;
        item.status = "removed"; run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run);
        await deps.repairTaskBoard(run.destination!.taskBoardTargetId); return; }
      if (!sameTaskScope(current.project_codes, currentTaskScope) &&
        !legacyTaskScopes.some((scope) => sameTaskScope(current.project_codes, scope)))
        throw new Error("meeting_minutes_task_scope_mismatch");
      await deps.deleteTask(item.taskId, current.version, `meeting-minutes-${run.runId}-cancel-${value.index}`);
      item.status = "removed"; run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run);
      await deps.repairTaskBoard(run.destination!.taskBoardTargetId); })().catch(async (error) => {
      if (error instanceof Error && error.message === "meeting_minutes_task_scope_mismatch") {
        console.warn("meeting_minutes_task_scope_mismatch", { runId: run.runId, taskId: item.taskId, action: "cancel" });
        await deps.notifyScopeMismatch(run, userId);
        return;
      }
      throw error;
    }));
    return Response.json({ ok: true });
  }
  const values = object(object(view?.state)?.values); const title = text(object(object(values?.title)?.value)?.value);
  const due = text(object(object(values?.due)?.value)?.selected_date);
  const assigneeState = object(object(values?.assignee)?.[MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID]);
  const assigneeSelection = text(object(assigneeState?.selected_option)?.value);
  if (!title || title.length > 120) return Response.json({ response_action: "errors", errors: { title: "タイトルを入力してください" } });
  deps.defer((async () => { const current = await deps.getTask(item.taskId);
    const scopeIsCurrent = sameTaskScope(current.project_codes, currentTaskScope);
    const scopeIsTrustedLegacy = !scopeIsCurrent && legacyTaskScopes.some((scope) => sameTaskScope(current.project_codes, scope));
    if (!scopeIsCurrent && !scopeIsTrustedLegacy) throw new Error("meeting_minutes_task_scope_mismatch");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${title}\n${due ?? ""}\n${assigneeSelection ?? "unchanged"}`))))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    const updated = await deps.updateTask(item.taskId, { expected_version: current.version, title,
      ...(scopeIsTrustedLegacy ? { project_codes: currentTaskScope } : {}),
      ...(due ? { due_at: `${due}T00:00:00+09:00` } : {}),
      ...(assigneeSelection === MEETING_MINUTES_ASSIGNEE_NONE ? { assignee_person_id: null }
        : assigneeSelection ? { assignee_person_id: assigneeSelection } : {}) },
      `meeting-minutes-${run.runId}-edit-${value.index}-${digest}`);
    if (!sameTaskScope(updated.project_codes, currentTaskScope)) throw new Error("meeting_minutes_task_scope_migration_failed");
    item.title = title;
    item.projectCodes = [...currentTaskScope];
    if (assigneeSelection) { item.assigneePersonId = updated.assignee_person_id ?? undefined;
      item.assigneeDisplayName = updated.assignee_display_name ?? undefined; }
    const generated = run.generated?.tasks?.[value.index];
    if (generated) { generated.title = title; if (due) generated.due_at = `${due}T00:00:00+09:00`;
      if (assigneeSelection) generated.assignee_name = updated.assignee_display_name ?? undefined; }
    run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run);
    await deps.repairTaskBoard(run.destination!.taskBoardTargetId); })().catch(async (error) => {
    if (error instanceof Error && error.message === "meeting_minutes_task_scope_mismatch") {
      console.warn("meeting_minutes_task_scope_mismatch", { runId: run.runId, taskId: item.taskId, action: "edit" });
      await deps.notifyScopeMismatch(run, userId);
      return;
    }
    throw error;
  }));
  return Response.json({ ok: true });
}
