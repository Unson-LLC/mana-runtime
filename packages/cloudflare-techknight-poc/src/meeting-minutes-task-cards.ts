import { MEETING_MINUTES_TASK_CANCEL_ACTION_ID, MEETING_MINUTES_TASK_EDIT_ACTION_ID,
  MEETING_MINUTES_TASK_EDIT_VIEW_ID, type MeetingMinutesRun } from "./meeting-minutes-contracts.js";

function safe(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
}
export function meetingMinutesTaskCard(run: MeetingMinutesRun): { text: string; blocks: Array<Record<string, unknown>> } {
  const registered = run.taskRegistration?.registered ?? [];
  const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn",
    text: `📋 *議事録から${registered.length}件のタスクを正本に登録しました* — 間違いは取り消し/編集できます` } },
    { type: "divider" }];
  for (const item of [...registered].sort((left, right) => left.index - right.index)) {
    const candidate = run.generated?.tasks?.[item.index]; const removed = item.status === "removed";
    const details = [`${removed ? "🗑" : "✅"} *${safe(item.title)}*${removed ? " — _取り消し済み_" : ""}`];
    const meta = [candidate?.assignee_name ? `担当: ${safe(candidate.assignee_name)}` : undefined,
      candidate?.due_at ? `期限: ${safe(candidate.due_at.slice(0, 10))}` : undefined].filter(Boolean);
    if (meta.length) details.push(meta.join(" | ")); if (candidate?.description) details.push(`_${safe(candidate.description)}_`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: details.join("\n") } });
    if (!removed) { const value = JSON.stringify({ runId: run.runId, index: item.index,
      organizationId: run.destination?.organization.id, channelId: run.destination?.slackChannelId,
      title: item.title, due: candidate?.due_at?.slice(0, 10) }); blocks.push({ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "編集" }, action_id: MEETING_MINUTES_TASK_EDIT_ACTION_ID, value },
      { type: "button", style: "danger", text: { type: "plain_text", text: "取り消し" }, action_id: MEETING_MINUTES_TASK_CANCEL_ACTION_ID,
        value, confirm: { title: { type: "plain_text", text: "タスクの取り消し" },
          text: { type: "plain_text", text: "正本タスクボードから削除します。よろしいですか？" },
          confirm: { type: "plain_text", text: "削除する" }, deny: { type: "plain_text", text: "やめる" } } },
    ] }); }
  }
  return { text: `議事録から${registered.length}件のタスクを登録しました`, blocks };
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
export function meetingMinutesTaskEditViewFromAction(input: { runId: string; index: number; title: string; due?: string }): Record<string, unknown> {
  return { type: "modal", callback_id: MEETING_MINUTES_TASK_EDIT_VIEW_ID,
    private_metadata: JSON.stringify({ runId: input.runId, index: input.index }), title: { type: "plain_text", text: "タスクを編集" },
    submit: { type: "plain_text", text: "保存" }, close: { type: "plain_text", text: "キャンセル" }, blocks: [
      { type: "input", block_id: "title", label: { type: "plain_text", text: "タイトル" }, element: {
        type: "plain_text_input", action_id: "value", initial_value: input.title, max_length: 120 } },
      { type: "input", block_id: "due", optional: true, label: { type: "plain_text", text: "期限" }, element: {
        type: "datepicker", action_id: "value", ...(input.due ? { initial_date: input.due } : {}) } },
    ] };
}
