import type { CanonicalTask, UpdateTaskInput } from "@openryoko/task-runtime-core";
import { MEETING_MINUTES_TASK_CANCEL_ACTION_ID, MEETING_MINUTES_TASK_EDIT_ACTION_ID,
  MEETING_MINUTES_TASK_EDIT_VIEW_ID, type MeetingMinutesRun } from "./meeting-minutes-contracts.js";
import { meetingMinutesTaskEditViewFromAction } from "./meeting-minutes-task-cards.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
type ActionMetadata = { runId: string; index: number; organizationId?: string; channelId?: string; title?: string; due?: string };
function metadata(value: unknown): ActionMetadata | undefined {
  try { const parsed = object(JSON.parse(text(value) ?? "")); const runId = text(parsed?.runId); const index = parsed?.index;
    return runId && Number.isInteger(index) && Number(index) >= 0 ? { runId, index: Number(index),
      organizationId: text(parsed?.organizationId), channelId: text(parsed?.channelId), title: text(parsed?.title), due: text(parsed?.due) } : undefined; }
  catch { return undefined; }
}
export interface MeetingMinutesTaskActionDependencies {
  sourceTeamId: string; destinationTeamIds: Readonly<Record<string, string>>;
  operatorUserIds: ReadonlySet<string>;
  loadRun(runId: string): Promise<MeetingMinutesRun | undefined>;
  saveRun(run: MeetingMinutesRun): Promise<void>;
  getTask(taskId: string): Promise<CanonicalTask>;
  updateTask(taskId: string, input: UpdateTaskInput, idempotencyKey: string): Promise<CanonicalTask>;
  deleteTask(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<unknown>;
  updateCard(run: MeetingMinutesRun): Promise<void>;
  openView(organizationId: string, triggerId: string, view: Record<string, unknown>): Promise<void>;
  repairTaskBoard(): Promise<void>;
  defer(work: Promise<void>): void;
}
function candidate(run: MeetingMinutesRun, index: number) {
  return run.taskRegistration?.registered.find((item) => item.index === index && item.status !== "removed");
}
function status(error: unknown): number | undefined { return object(error)?.status as number | undefined; }
function allowed(payload: ObjectValue, run: MeetingMinutesRun, deps: MeetingMinutesTaskActionDependencies): boolean {
  const teamId = text(object(payload.team)?.id); const channelId = text(object(payload.channel)?.id);
  const expectedTeam = deps.destinationTeamIds[run.destination?.organization.id ?? ""] ?? deps.sourceTeamId;
  return teamId === expectedTeam && (!channelId || channelId === run.destination?.slackChannelId);
}
export async function handleMeetingMinutesTaskAction(payload: ObjectValue,
  deps: MeetingMinutesTaskActionDependencies): Promise<Response | undefined> {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = actions.length === 1 ? object(actions[0]) : undefined;
  const actionId = text(action?.action_id); const view = object(payload.view);
  const callbackId = text(view?.callback_id);
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
      index: value.index, title: value.title, due: value.due })));
    return Response.json({ ok: true });
  }
  const run = await deps.loadRun(value.runId); const item = run && candidate(run, value.index);
  if (!run || !run.destination || !item || !allowed(payload, run, deps)) {
    return Response.json({ error: "meeting_minutes_task_action_forbidden" }, { status: 403 });
  }
  if (actionId === MEETING_MINUTES_TASK_CANCEL_ACTION_ID) {
    deps.defer((async () => { let current: CanonicalTask;
      try { current = await deps.getTask(item.taskId); }
      catch (error) { if (status(error) !== 404) throw error;
        item.status = "removed"; run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run);
        await deps.repairTaskBoard(); return; }
      if (current.project_codes?.length !== 1 || current.project_codes[0] !== run.destination!.projectId) throw new Error("meeting_minutes_task_scope_mismatch");
      await deps.deleteTask(item.taskId, current.version, `meeting-minutes-${run.runId}-cancel-${value.index}`);
      item.status = "removed"; run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run);
      await deps.repairTaskBoard(); })());
    return Response.json({ ok: true });
  }
  const values = object(object(view?.state)?.values); const title = text(object(object(values?.title)?.value)?.value);
  const due = text(object(object(values?.due)?.value)?.selected_date);
  if (!title || title.length > 120) return Response.json({ response_action: "errors", errors: { title: "タイトルを入力してください" } });
  deps.defer((async () => { const current = await deps.getTask(item.taskId);
    if (current.project_codes?.length !== 1 || current.project_codes[0] !== run.destination!.projectId) throw new Error("meeting_minutes_task_scope_mismatch");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${title}\n${due ?? ""}`))))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    await deps.updateTask(item.taskId, { expected_version: current.version, title,
      ...(due ? { due_at: `${due}T00:00:00+09:00` } : {}) },
      `meeting-minutes-${run.runId}-edit-${value.index}-${digest}`);
    item.title = title; const generated = run.generated?.tasks?.[value.index];
    if (generated) { generated.title = title; if (due) generated.due_at = `${due}T00:00:00+09:00`; }
    run.updatedAt = new Date().toISOString(); await deps.saveRun(run); await deps.updateCard(run); await deps.repairTaskBoard(); })());
  return Response.json({ ok: true });
}
