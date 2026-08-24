import { MEETING_MINUTES_TASK_CANCEL_ACTION_ID, MEETING_MINUTES_TASK_EDIT_ACTION_ID,
  MEETING_MINUTES_TASK_EDIT_VIEW_ID, MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID, type MeetingMinutesRun } from "./meeting-minutes-contracts.js";
import { deriveCorrelationId } from "./multitenancy/ids.js";

export const MEETING_MINUTES_ASSIGNEE_NONE = "__none__";

function safe(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
}
export function meetingMinutesTaskCard(run: MeetingMinutesRun): { text: string; blocks: Array<Record<string, unknown>> } {
  const registered = run.taskRegistration?.registered ?? [];
  const created = registered.filter((item) => !item.status || item.status === "registered").length;
  const reused = registered.filter((item) => item.status === "reused").length;
  const needsReview = registered.filter((item) => item.status === "needs_review").length;
  const summary = [`新規${created}件`, `既存${reused}件`, needsReview ? `要確認${needsReview}件` : undefined]
    .filter(Boolean).join("・");
  const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn",
    text: `📋 *議事録のタスク確認* — ${summary}` } },
    { type: "divider" }];
  if (!run.sourceAppId) {
    const correlationId = deriveCorrelationId(run.runId, "task_action", "TASK_ACTION_EXPIRED");
    blocks.push({ type: "section", text: { type: "mrkdwn",
      text: `⚠️ このカードは旧形式のため操作できません。議事録を再生成してください。問い合わせID: ${correlationId}` } });
  }
  for (const item of [...registered].sort((left, right) => left.index - right.index)) {
    const candidate = run.generated?.tasks?.[item.index]; const removed = item.status === "removed";
    const marker = removed ? "🗑" : item.status === "reused" ? "♻️" : item.status === "needs_review" ? "⚠️" : "✅";
    const suffix = removed ? " — _取り消し済み_" : item.status === "reused" ? " — _既存タスクを再利用_" :
      item.status === "needs_review" ? " — _似た既存タスクあり・要確認_" : "";
    const details = [`${marker} *${safe(item.title)}*${suffix}`];
    const meta = [candidate?.assignee_name ? `担当: ${safe(candidate.assignee_name)}` : undefined,
      candidate?.due_at ? `期限: ${safe(candidate.due_at.slice(0, 10))}` : undefined].filter(Boolean);
    if (meta.length) details.push(meta.join(" | ")); if (candidate?.description) details.push(`_${safe(candidate.description)}_`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: details.join("\n") } });
    if (!removed && (!item.status || item.status === "registered") && run.sourceAppId) {
      const value = JSON.stringify({ runId: run.runId, index: item.index,
      organizationId: run.destination?.organization.id, channelId: run.destination?.slackChannelId,
      title: item.title, due: candidate?.due_at?.slice(0, 10), projectId: run.destination?.projectId,
      assigneePersonId: item.assigneePersonId, assigneeDisplayName: item.assigneeDisplayName ?? candidate?.assignee_name,
      sourceWorkspaceId: run.workspaceId, sourceAppId: run.sourceAppId,
      sourceChannelId: run.sourceChannelId, sourceThreadTs: run.sourceThreadTs }); blocks.push({ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "編集" }, action_id: MEETING_MINUTES_TASK_EDIT_ACTION_ID, value },
      { type: "button", style: "danger", text: { type: "plain_text", text: "取り消し" }, action_id: MEETING_MINUTES_TASK_CANCEL_ACTION_ID,
        value, confirm: { title: { type: "plain_text", text: "タスクの取り消し" },
          text: { type: "plain_text", text: "正本タスクボードから削除します。よろしいですか？" },
          confirm: { type: "plain_text", text: "削除する" }, deny: { type: "plain_text", text: "やめる" } } },
    ] }); }
  }
  return { text: `議事録のタスク確認: ${summary}`, blocks };
}
export function meetingMinutesTaskEditView(run: MeetingMinutesRun, index: number): Record<string, unknown> {
  const item = run.taskRegistration?.registered.find((candidate) => candidate.index === index && candidate.status !== "removed");
  if (!item) throw new Error("meeting_minutes_task_not_found"); const candidate = run.generated?.tasks?.[index];
  return { type: "modal", callback_id: MEETING_MINUTES_TASK_EDIT_VIEW_ID,
    private_metadata: JSON.stringify({ runId: run.runId, index }), title: { type: "plain_text", text: "タスクを編集" },
    submit: { type: "plain_text", text: "保存" }, close: { type: "plain_text", text: "キャンセル" }, blocks: [
      { type: "input", block_id: "title", label: { type: "plain_text", text: "タイトル" }, element: {
        type: "plain_text_input", action_id: "value", initial_value: item.title, max_length: 120 } },
      { type: "input", block_id: "due", optional: true, label: { type: "plain_text", text: "期限" }, element: {
        type: "datepicker", action_id: "value", ...(candidate?.due_at ? { initial_date: candidate.due_at.slice(0, 10) } : {}) } },
    ] };
}
export function meetingMinutesTaskEditViewFromAction(input: { runId: string; index: number; title: string; due?: string;
  organizationId: string; channelId: string; projectId?: string; assigneePersonId?: string; assigneeDisplayName?: string;
  sourceWorkspaceId: string; sourceAppId: string; sourceChannelId: string; sourceThreadTs: string }): Record<string, unknown> {
  const initialOption = input.assigneePersonId && input.assigneeDisplayName ? {
    text: { type: "plain_text", text: input.assigneeDisplayName.slice(0, 75) }, value: input.assigneePersonId } : undefined;
  return { type: "modal", callback_id: MEETING_MINUTES_TASK_EDIT_VIEW_ID,
    private_metadata: JSON.stringify({ runId: input.runId, index: input.index, organizationId: input.organizationId,
      channelId: input.channelId, projectId: input.projectId, sourceWorkspaceId: input.sourceWorkspaceId,
      sourceAppId: input.sourceAppId, sourceChannelId: input.sourceChannelId,
      sourceThreadTs: input.sourceThreadTs }), title: { type: "plain_text", text: "タスクを編集" },
    submit: { type: "plain_text", text: "保存" }, close: { type: "plain_text", text: "キャンセル" }, blocks: [
      { type: "input", block_id: "title", label: { type: "plain_text", text: "タイトル" }, element: {
        type: "plain_text_input", action_id: "value", initial_value: input.title, max_length: 120 } },
      { type: "input", block_id: "due", optional: true, label: { type: "plain_text", text: "期限" }, element: {
        type: "datepicker", action_id: "value", ...(input.due ? { initial_date: input.due } : {}) } },
      { type: "input", block_id: "assignee", optional: true, label: { type: "plain_text", text: "担当者（Graph SSOT）" }, element: {
        type: "external_select", action_id: MEETING_MINUTES_TASK_ASSIGNEE_ACTION_ID, min_query_length: 0,
        placeholder: { type: "plain_text", text: "担当者を選択" }, ...(initialOption ? { initial_option: initialOption } : {}) } },
    ] };
}
