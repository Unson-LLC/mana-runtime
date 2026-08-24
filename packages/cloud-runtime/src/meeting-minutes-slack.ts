import { MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, MEETING_MINUTES_CHOOSE_ACTION_ID,
  MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID, MEETING_MINUTES_CONFIRM_REDO_ACTION_ID,
  MEETING_MINUTES_REDO_ACTION_ID, type MeetingMinutesDestination,
  meetingMinutesTaskActionFailure, type MeetingMinutesRun,
  type MeetingMinutesTaskActionFailure } from "./meeting-minutes-contracts.js";
import { meetingMinutesTaskCard } from "./meeting-minutes-task-cards.js";
import type { UserFailure } from "./multitenancy/failure.js";
import { deriveCorrelationId } from "./multitenancy/ids.js";
import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";

export interface SlackSelectionMessage {
  replace_original: true;
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function organizationSelectionMessage(runId: string, fileName: string,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  const preferredOrder = ["unson", "unson-business", "tech-knight"];
  const organizations = [...new Map(destinations.map((item) => [item.organization.id, item.organization])).values()]
    .sort((left, right) => {
      const leftIndex = preferredOrder.indexOf(left.id); const rightIndex = preferredOrder.indexOf(right.id);
      return (leftIndex < 0 ? preferredOrder.length : leftIndex) - (rightIndex < 0 ? preferredOrder.length : rightIndex);
    });
  return { replace_original: true, text: `${safeFileName} の保存先組織を選択してください。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${safeFileName}* の保存先組織を選択してください。` } },
    { type: "actions", elements: organizations.map((organization) => ({ type: "button",
      text: { type: "plain_text", text: organization.name },
      action_id: `${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:${organization.id}`,
      value: JSON.stringify({ runId, organizationId: organization.id, fileName }) })) },
  ] };
}

export function projectSelectionMessage(runId: string, fileName: string, organizationId: string,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  const projects = destinations.filter((item) => item.organization.id === organizationId);
  if (!projects.length) throw new Error("meeting_minutes_organization_invalid");
  const organization = projects[0]!.organization;
  return { replace_original: true, text: `${safeFileName} の保存先プロジェクトを選択してください。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${safeFileName}* の保存先プロジェクトを選択してください。\n組織: *${organization.name}*` } },
    { type: "actions", elements: projects.map((destination) => ({ type: "button",
      text: { type: "plain_text", text: destination.name }, action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${destination.id}`,
      value: JSON.stringify({ runId, destinationId: destination.id, fileName }) })) },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← 組織選択に戻る" },
      action_id: MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, value: JSON.stringify({ runId, fileName }) }] },
  ] };
}

export function destinationSelectedMessage(runId: string, fileName: string,
  destination: MeetingMinutesDestination): SlackSelectionMessage {
  return { replace_original: true, text: `${escapeUntrustedSlackMrkdwn(fileName)} の保存先に ${destination.name} を選択しました。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*✅ 保存先を選択しました*\n保存先: ${destination.name}` } },
  ] };
}

export function redoConfirmationMessage(runId: string, fileName: string): SlackSelectionMessage {
  return { replace_original: true, text: `${escapeUntrustedSlackMrkdwn(fileName)} の保存先をやり直しますか？`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*保存先をやり直しますか？*\nGitHubの議事録・文字起こしと自動登録タスクを取り消します。旧共有投稿は「取り消し済み」にし、保存先選択へ戻します。` } },
    { type: "actions", elements: [
      { type: "button", style: "danger", text: { type: "plain_text", text: "取り消して選び直す" },
        action_id: MEETING_MINUTES_CONFIRM_REDO_ACTION_ID, value: JSON.stringify({ runId, fileName }) },
    ] },
  ] };
}

export function redoProcessingMessage(fileName: string, runId?: string): SlackSelectionMessage {
  const processingDetails = runId ? `\n処理ID: ${runId}` : "";
  return { replace_original: true, text: `${escapeUntrustedSlackMrkdwn(fileName)} の保存先をやり直しています。`, blocks: [
    { type: "section", text: { type: "mrkdwn",
      text: `:hourglass_flowing_sand: *保存先をやり直しています…*${processingDetails}\n旧保存先の議事録とタスクを取り消したあと、保存先選択へ切り替えます。` } },
  ] };
}

function publicFailureMessage(runId: string, fileName: string, stage: string, code: string,
  headline: string, instruction: string): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  const correlationId = deriveCorrelationId(runId, stage, code);
  const details = `処理ID: ${runId}\n失敗段階: ${stage}\nエラーコード: ${code}\n問い合わせID: ${correlationId}`;
  return { replace_original: true,
    text: `${safeFileName} ${headline} エラーコード: ${code}（問い合わせID: ${correlationId}）`,
    blocks: [{ type: "section", text: { type: "mrkdwn",
      text: `:warning: *${headline}*\n${details}\n${instruction}` } }] };
}

/** Stable public failure shown when the interaction could not identify the source thread. */
export function threadCoordinateMissingMessage(runId: string, fileName: string): SlackSelectionMessage {
  return publicFailureMessage(runId, fileName, "スレッド特定", "THREAD_COORDINATE_MISSING",
    "議事録処理のスレッドを特定できませんでした。", "元の投稿からもう一度保存先を選択してください。");
}

/** Stable public failure shown when the short-lived Slack status projection fails. */
export function immediateStatusFailedMessage(runId: string, fileName: string): SlackSelectionMessage {
  return publicFailureMessage(runId, fileName, "状態表示", "IMMEDIATE_STATUS_FAILED",
    "議事録処理の状態表示に失敗しました。", "処理は継続しています。処理IDを添えて運用担当者へ確認してください。");
}

/** Stable public failure shown when the destination confirmation projection fails. */
export function selectionConfirmationFailedMessage(runId: string, fileName: string): SlackSelectionMessage {
  return publicFailureMessage(runId, fileName, "選択確認", "SELECTION_CONFIRMATION_FAILED",
    "保存先の選択結果を表示できませんでした。", "処理は継続しています。処理IDを添えて運用担当者へ確認してください。");
}

/** Stable public failure used by a one-shot fallback after any status projection failure. */
export function statusProjectionFailedMessage(runId: string, fileName: string): SlackSelectionMessage {
  return publicFailureMessage(runId, fileName, "状態表示", "STATUS_PROJECTION_FAILED",
    "議事録処理の状態表示に失敗しました。", "処理IDを添えて運用担当者へ確認してください。");
}

export function redoFailedMessage(runId: string, fileName: string): SlackSelectionMessage {
  const correlationId = deriveCorrelationId(runId, "redo_enqueue", "REDO_ENQUEUE_FAILED");
  const details = `処理ID: ${runId}\n失敗段階: 処理受付\nエラーコード: REDO_ENQUEUE_FAILED\n問い合わせID: ${correlationId}`;
  return { replace_original: true, text: `${escapeUntrustedSlackMrkdwn(fileName)} の保存先変更に失敗しました。エラーコード: REDO_ENQUEUE_FAILED（問い合わせID: ${correlationId}）`, blocks: [
    { type: "section", text: { type: "mrkdwn",
      text: `:warning: *保存先のやり直しを完了できませんでした*\n${details}\n完了済みの取り消し工程は保持されています。下のボタンから続きを再実行できます。` } },
    { type: "actions", elements: [{ type: "button", style: "danger",
      text: { type: "plain_text", text: "取り消しを再実行" }, action_id: MEETING_MINUTES_CONFIRM_REDO_ACTION_ID,
      value: JSON.stringify({ runId, fileName }) }] },
  ] };
}

export function interactionEnqueueFailedMessage(runId: string, fileName: string): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  const correlationId = deriveCorrelationId(runId, "interaction_enqueue", "INTERACTION_ENQUEUE_FAILED");
  const details = `処理ID: ${runId}\n失敗段階: 処理受付\nエラーコード: INTERACTION_ENQUEUE_FAILED\n問い合わせID: ${correlationId}`;
  return { replace_original: true,
    text: `${safeFileName} の議事録処理を開始できませんでした。エラーコード: INTERACTION_ENQUEUE_FAILED（問い合わせID: ${correlationId}）`,
    blocks: [{ type: "section", text: { type: "mrkdwn",
      text: `:warning: *議事録処理を開始できませんでした*\n${details}\nもう一度保存先を選択してください。` } }] };
}

export function tenantInteractionFailedMessage(runId: string, fileName: string, failure: UserFailure): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  return { replace_original: true,
    text: `${safeFileName} の認証・接続確認に失敗しました。エラーコード: ${failure.code}（問い合わせID: ${failure.correlation_id}）`,
    blocks: [{ type: "section", text: { type: "mrkdwn",
      text: `:warning: *認証・接続確認に失敗しました*\n処理ID: ${runId}\n失敗段階: テナント認証\nエラーコード: ${failure.code}\n問い合わせID: ${failure.correlation_id}\n設定を確認してから再実行してください。` } }] };
}

/** Stable public failure shown when a shared interaction action handler rejects. */
export function interactionActionFailedMessage(runId: string, fileName: string,
  failure: UserFailure): SlackSelectionMessage {
  const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
  return { replace_original: true,
    text: `${safeFileName} の操作に失敗しました。エラーコード: ${failure.code}（問い合わせID: ${failure.correlation_id}）`,
    blocks: [{ type: "section", text: { type: "mrkdwn",
      text: `:warning: *議事録の操作に失敗しました*\n処理ID: ${runId}\n失敗段階: 操作処理\nエラーコード: ${failure.code}\n問い合わせID: ${failure.correlation_id}\n処理を再実行してください。` } }] };
}

export function suggestedDestinationMessage(run: MeetingMinutesRun,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage | undefined {
  const destination = destinations.find((item) => item.id === run.routing?.suggestedDestinationId);
  if (!destination) return undefined;
  const safeFileName = escapeUntrustedSlackMrkdwn(run.file.name);
  const reason = run.routing?.reason ? `\n推定根拠: ${escapeUntrustedSlackMrkdwn(run.routing.reason)}` : "";
  return { replace_original: true, text: `${safeFileName} の保存先候補は ${destination.name} です。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${safeFileName}* の保存先候補です。\n候補は *${destination.name}* です。${reason}` } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "この候補で進める" },
        action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${destination.id}`,
        value: JSON.stringify({ runId: run.runId, destinationId: destination.id, fileName: run.file.name }) },
      { type: "button", text: { type: "plain_text", text: "別の保存先を選ぶ" },
        action_id: MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID,
        value: JSON.stringify({ runId: run.runId, fileName: run.file.name }) },
    ] },
  ] };
}

interface SlackApiResponse { ok?: boolean; error?: string; ts?: string }
function isBrainbaseAuthenticationFailure(run: MeetingMinutesRun): boolean {
  return run.failure?.message === "meeting_minutes_context_request_failed:401"
    || (run.taskRegistration?.failure?.stage === "task_registration"
      && run.taskRegistration.failure.status === 401);
}
function isBrainbaseProjectBindingFailure(run: MeetingMinutesRun): boolean {
  const taskFailure = run.taskRegistration?.failure;
  return /^(?:meeting_minutes_context_project_unconfigured|meeting_minutes_context_request_failed:403)$/.test(
    run.failure?.message ?? "",
  ) || (taskFailure?.stage === "task_registration" && (
    taskFailure.status === 403
    || /^(?:project_code_not_allowed|task_scope_not_configured)$/.test(taskFailure.code ?? "")
    || /^(?:project_code_not_allowed|task_scope_not_configured)$/.test(taskFailure.message)
  ));
}
function safeFailureDetails(run: MeetingMinutesRun): string[] {
  const failure = run.projectionFailure ?? run.diagnostics;
  const taskFailure = run.taskRegistration?.failure;
  const stage = failure?.stage ?? taskFailure?.stage ?? run.failure?.stage;
  const code = failure?.code ?? (taskFailure ? "TASK_REGISTRATION_FAILED" : "UNCLASSIFIED_FAILURE");
  const correlationId = deriveCorrelationId(run.runId, stage ?? "unknown", code);
  const stageLabels: Record<string, string> = {
    interaction_enqueue: "処理受付", transcript_download: "文字起こし取得", context_resolve: "Brainbase文脈取得",
    context_gate: "Brainbase文脈検証", generation: "議事録生成", github_save: "GitHub保存",
    slack_publish: "Slack投稿", task_registration: "タスク登録", task_board: "タスクボード反映",
    task_card: "タスクカード投稿", task_action: "タスク操作", task_scope: "タスク紐付け確認",
    redo_enqueue: "保存先変更受付", tenant_authentication: "テナント認証", intake: "受付制御",
    status_projection: "状態表示",
  };
  return [`処理ID: ${run.runId}`, `失敗段階: ${stage ? stageLabels[stage] ?? "不明" : "不明（旧形式）"}`,
    `エラーコード: ${code}`, `問い合わせID: ${correlationId}`];
}

function taskActionFailureDetails(failure: MeetingMinutesTaskActionFailure): string[] {
  return [`処理ID: ${failure.processingId}`, `失敗段階: タスク操作（${failure.stage}）`,
    `エラーコード: ${failure.code}`, `問い合わせID: ${failure.correlationId}`,
    `再試行可否: ${failure.retryable ? "可能" : "不可"}`];
}

const CANONICAL_CORRELATION_ID = /^cor_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ACTION_FAILURE_CODES: readonly MeetingMinutesTaskActionFailure["code"][] = [
  "TASK_ACTION_FAILED",
  "TASK_SCOPE_MISMATCH",
  "TASK_SCOPE_MIGRATION_FAILED",
  "TASK_ACTION_EXPIRED",
];

function isCanonicalCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_CORRELATION_ID.test(value);
}

function isTaskActionFailureCode(value: unknown): value is MeetingMinutesTaskActionFailure["code"] {
  return typeof value === "string" && TASK_ACTION_FAILURE_CODES.includes(value as MeetingMinutesTaskActionFailure["code"]);
}

function normalizeTaskActionFailure(run: MeetingMinutesRun,
  failure: MeetingMinutesTaskActionFailure | string,
  fallbackCode: MeetingMinutesTaskActionFailure["code"] = "TASK_ACTION_FAILED"): MeetingMinutesTaskActionFailure {
  const fallback = meetingMinutesTaskActionFailure(run.runId, fallbackCode, fallbackCode !== "TASK_SCOPE_MISMATCH");
  if (typeof failure === "string") {
    // A legacy string carries no stage/code context, so even a well-formed
    // correlation id cannot be tied to this failure. Keep the public id
    // deterministic from the run, stage, and fallback code.
    return fallback;
  }
  if (!failure || typeof failure !== "object") return fallback;
  if (failure.processingId !== run.runId || failure.stage !== "task_action" ||
    !isTaskActionFailureCode(failure.code) || typeof failure.retryable !== "boolean") return fallback;
  const expectedCorrelationId = deriveCorrelationId(failure.processingId, failure.stage, failure.code);
  return { ...failure,
    correlationId: isCanonicalCorrelationId(failure.correlationId) && failure.correlationId === expectedCorrelationId
      ? failure.correlationId : expectedCorrelationId };
}
function failedRunDetails(run: MeetingMinutesRun): string[] {
  const destination = `保存先: ${run.destination!.name}`;
  let details: string[];
  if (run.failure?.message === "meeting_minutes_generation_placeholder_output") {
    details = ["*⚠️ 生成結果が議事録になっていませんでした*", destination,
      "見本やプレースホルダーのままの出力を検出したため、GitHub・Slack・タスクには保存していません。",
      "下のボタンから安全に再実行できます。"];
  } else if (run.taskRegistration?.failure && run.slack?.parentTs) {
    details = ["*⚠️ 議事録は共有しましたが、タスク自動登録に失敗しました*", destination,
      "議事録本文は共有済みです。タスク登録を再試行するには、下のボタンを押してください。"];
  } else if (/slack_api_failed:chat\.postMessage:(?:channel_not_found|not_in_channel)/.test(run.failure?.message ?? "")) {
    details = ["*⚠️ 保存先チャンネルへ投稿できませんでした*", destination,
      `Manaアプリが「${run.destination!.name}」のチャンネルに参加しているか確認してください。`,
      "参加させた後、下のボタンから再実行できます。"];
  } else if (isBrainbaseProjectBindingFailure(run)) {
    details = ["*⚠️ Brainbaseのプロジェクト紐付けを確認できませんでした*", destination,
      `「${run.destination!.name}」に対応するBrainbaseプロジェクトが未設定、または利用権限がありません。`,
      "設定を修正するまで再実行しても成功しません。運用担当者へ確認してください。"];
  } else if (isBrainbaseAuthenticationFailure(run)) {
    details = ["*⚠️ Brainbaseの認証設定を確認できませんでした*", destination,
      "Brainbaseへの認証情報が未設定、無効、または期限切れです。",
      "認証設定を修正するまで再実行しても成功しません。運用担当者へ確認してください。"];
  } else {
    details = ["*⚠️ 議事録の作成に失敗しました*", destination,
      (run.projectionFailure ?? run.diagnostics)?.retryable === false
        ? "同じ条件では再実行せず、処理IDを添えて運用担当者へ確認してください。"
        : "下のボタンから再実行できます。"];
  }
  return [...details, ...safeFailureDetails(run)];
}
async function clientMessageId(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meeting-minutes:${seed}`))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class MeetingMinutesSlackClient {
  private readonly fetchImpl: typeof fetch;
  private readonly brokered: boolean;

  constructor(private readonly token?: string, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.brokered = fetchImpl !== undefined;
  }

  private authorization(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async post(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<SlackApiResponse> {
    if (!this.token?.trim() && !this.brokered) throw new Error("slack_bot_token_not_configured");
    const response = await this.fetchImpl.call(globalThis, `https://slack.com/api/${method}`, { method: "POST",
      headers: { ...this.authorization(), "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal });
    const result = await response.json() as SlackApiResponse;
    if (!response.ok || !result.ok) throw new Error(`slack_api_failed:${method}:${result.error ?? response.status}`);
    return result;
  }
  async downloadTextFile(fileId: string, maxBytes = 20 * 1024 * 1024): Promise<string> {
    if (!this.token?.trim() && !this.brokered) throw new Error("slack_bot_token_not_configured");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new Error("slack_file_id_invalid");
    const infoResponse = await this.fetchImpl.call(globalThis, `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: this.authorization(),
    });
    const info = await infoResponse.json() as { ok?: boolean; error?: string; file?: { name?: string; mimetype?: string; size?: number; url_private_download?: string } };
    if (!infoResponse.ok || !info.ok || !info.file?.url_private_download) throw new Error(`slack_file_info_failed:${info.error ?? infoResponse.status}`);
    if (!/\.txt$/i.test(info.file.name ?? "") || (info.file.mimetype && info.file.mimetype !== "text/plain")) throw new Error("slack_file_type_invalid");
    if (typeof info.file.size === "number" && info.file.size > maxBytes) throw new Error("slack_file_size_invalid");
    const download = await this.fetchImpl.call(globalThis, info.file.url_private_download, { headers: this.authorization() });
    if (!download.ok) throw new Error(`slack_file_download_failed:${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("slack_file_size_invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async requestDestination(run: MeetingMinutesRun, destinations: readonly MeetingMinutesDestination[]): Promise<string> {
    if (!destinations.length) throw new Error("meeting_minutes_destinations_empty");
    const message = suggestedDestinationMessage(run, destinations) ??
      organizationSelectionMessage(run.runId, run.file.name, destinations);
    const result = await this.post("chat.postMessage", { channel: run.sourceChannelId, thread_ts: run.sourceThreadTs,
      text: message.text, client_msg_id: await clientMessageId(`${run.runId}-selection`), blocks: message.blocks });
    if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async postIntakePaused(channelId: string, threadTs: string, eventId?: string): Promise<void> {
    const seed = eventId?.trim() || `legacy-intake:${channelId}:${threadTs}`;
    const correlationId = deriveCorrelationId(seed, "intake", "INTAKE_PAUSED");
    await this.post("chat.postMessage", {
      channel: channelId,
      thread_ts: threadTs,
      text: `議事録の新規受付は一時停止中です。復旧後にファイルを投稿し直してください。問い合わせID: ${correlationId}`,
      blocks: [{ type: "section", text: { type: "mrkdwn",
        text: `:warning: *議事録の新規受付は一時停止中です*\n復旧後にファイルを投稿し直してください。\n問い合わせID: ${correlationId}` } }],
    });
  }
  async postIntakePausedToUser(channelId: string, userId: string, runId?: string): Promise<void> {
    const seed = runId?.trim() || `legacy-intake:${channelId}:${userId}`;
    const correlationId = deriveCorrelationId(seed, "intake", "INTAKE_PAUSED");
    await this.post("chat.postEphemeral", {
      channel: channelId,
      user: userId,
      text: `議事録の受付は一時停止中です。復旧後に、保存先の選択またはやり直しをもう一度実行してください。問い合わせID: ${correlationId}`,
      blocks: [{ type: "section", text: { type: "mrkdwn",
        text: `:warning: *議事録の受付は一時停止中です*\n復旧後に、保存先の選択またはやり直しをもう一度実行してください。\n問い合わせID: ${correlationId}` } }],
    });
  }
  async postProcessingStatus(run: MeetingMinutesRun): Promise<string> {
    if (!run.destination) throw new Error("meeting_minutes_destination_missing");
    if (!run.slack?.selectionTs) throw new Error("meeting_minutes_selection_coordinates_missing");
    await this.setThreadStatus(run, `議事録を作成しています…（${run.destination.name}）`);
    const result = await this.post("chat.postMessage", { channel: run.sourceChannelId, thread_ts: run.sourceThreadTs,
      text: `${escapeUntrustedSlackMrkdwn(run.file.name)} の議事録を作成しています。`, client_msg_id: await clientMessageId(`${run.runId}-processing`),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*⏳ 議事録を作成中…*\n保存先: ${run.destination.name}\n完了すると共有先へ投稿します。` } }] });
    if (!result.ts) throw new Error("slack_response_ts_missing");
    return result.ts;
  }
  async showProcessingStatus(channelId: string, threadTs: string, destinationName: string): Promise<void> {
    await this.post("assistant.threads.setStatus", {
      channel_id: channelId,
      thread_ts: threadTs,
      status: `議事録を作成しています…（${destinationName}）`,
    }, AbortSignal.timeout(1_500));
  }
  async clearProcessingStatus(channelId: string, threadTs: string): Promise<void> {
    await this.post("assistant.threads.setStatus", { channel_id: channelId, thread_ts: threadTs, status: "" },
      AbortSignal.timeout(1_500));
  }
  async updateRunStatus(run: MeetingMinutesRun, outcome: "completed" | "failed"): Promise<void> {
    if (!run.slack?.processingTs || !run.destination) throw new Error("meeting_minutes_status_coordinates_missing");
    await this.setThreadStatus(run, "", true);
    const completed = outcome === "completed";
    const permanentProjectBindingFailure = isBrainbaseProjectBindingFailure(run);
    const permanentAuthenticationFailure = isBrainbaseAuthenticationFailure(run);
    const permanentBrainbaseFailure = permanentProjectBindingFailure || permanentAuthenticationFailure;
    const persistedPlaceholderFailure = completed
      && run.failure?.message === "meeting_minutes_persisted_placeholder_output";
    const taskRegistrationPending = completed && Boolean(run.taskRegistration?.failure)
      && !permanentBrainbaseFailure;
    const contextWarning = completed
      && run.generated?.brainbase_context_warnings?.includes("unknown_source_ref_removed");
    const taskIntegrationStage = run.taskRegistration?.failure?.stage;
    const taskIntegrationMessage = taskIntegrationStage === "task_board"
      ? "タスク登録は完了しましたが、タスクボードへの反映が完了していません。"
      : taskIntegrationStage === "task_card"
      ? "タスク登録は完了しましたが、タスクカードの投稿が完了していません。"
      : "タスク自動登録だけ完了していません。";
    const safeFileName = escapeUntrustedSlackMrkdwn(run.file.name);
    const text = persistedPlaceholderFailure
      ? `${safeFileName} の保存済み議事録に見本文が含まれています。保存先をやり直してください。`
      : completed && permanentAuthenticationFailure
      ? `${safeFileName} の議事録は作成・共有済みですが、Brainbaseの認証設定を確認できませんでした。`
      : completed && permanentProjectBindingFailure
      ? `${safeFileName} の議事録は作成・共有済みですが、Brainbaseのプロジェクト紐付けを確認できませんでした。`
      : taskRegistrationPending
      ? `${safeFileName} の議事録は作成・共有済みです。未完了のタスク連携を再実行できます。`
      : completed
      ? `${safeFileName} の議事録を作成しました。${contextWarning
        ? " Brainbaseの正本にない参照候補は除外しました。" : ""}`
      : permanentAuthenticationFailure
      ? `${safeFileName} の議事録作成に失敗しました。Brainbaseの認証設定を確認してください。`
      : permanentProjectBindingFailure
      ? `${safeFileName} の議事録作成に失敗しました。Brainbaseのプロジェクト紐付けを確認してください。`
      : `${safeFileName} の議事録作成に失敗しました。再実行できます。`;
    const details = persistedPlaceholderFailure
      ? [`*⚠️ 保存済みの議事録に見本文が含まれています*`,
        `保存先: ${run.destination.name}`,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|現在のGitHubファイルを確認する>` : undefined,
        run.slack?.parentTs ? `共有先: <#${run.destination.slackChannelId}>` : undefined,
        "以前の生成結果を自動では上書きしません。下の「保存先をやり直す」で撤回し、再生成してください。"]
        .filter(Boolean).join("\n")
      : completed && permanentAuthenticationFailure
      ? [`*⚠️ 議事録は作成・共有済みですが、Brainbaseの認証設定を確認できませんでした*`,
        `保存先: ${run.destination.name}`,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|GitHubで議事録を開く>` : undefined,
        `共有先: <#${run.destination.slackChannelId}>`,
        "Brainbaseへの認証情報が未設定、無効、または期限切れです。",
        "認証設定を修正するまで再実行しても成功しません。運用担当者へ確認してください。"]
        .filter(Boolean).join("\n")
      : completed && permanentProjectBindingFailure
      ? [`*⚠️ 議事録は作成・共有済みですが、Brainbaseのプロジェクト紐付けを確認できませんでした*`,
        `保存先: ${run.destination.name}`,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|GitHubで議事録を開く>` : undefined,
        `共有先: <#${run.destination.slackChannelId}>`,
        `「${run.destination.name}」に対応するBrainbaseプロジェクトが未登録、またはタスク登録権限がありません。`,
        "設定を修正するまで再実行しても成功しません。運用担当者へ確認してください。"]
        .filter(Boolean).join("\n")
      : taskRegistrationPending
      ? [`*⚠️ 議事録は作成・共有済みです*`, `保存先: ${run.destination.name}`,
        contextWarning ? "⚠️ Brainbaseの正本にない参照候補を除外し、正本の参照だけで作成しました。" : undefined,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|GitHubで議事録を開く>` : undefined,
        `共有先: <#${run.destination.slackChannelId}>`,
        `${taskIntegrationMessage} 下のボタンから未完了の処理だけ再実行できます。`]
        .filter(Boolean).join("\n")
      : completed
      ? [`*✅ 議事録を作成しました*`, `保存先: ${run.destination.name}`,
        run.context ? `Brainbase正本文脈: ${run.context.status === "resolved" ? "参照済み" :
          run.context.status === "confirmed_empty" ? "確認済み（該当なし）" :
          run.context.status === "partial" ? "一部参照" : "参照不能"}（Receipt: ${run.context.receiptId}）` : undefined,
        contextWarning ? "⚠️ Brainbaseの正本にない参照候補を除外し、正本の参照だけで作成しました。" : undefined,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|GitHubで議事録を開く>` : undefined,
        `共有先: <#${run.destination.slackChannelId}>`].filter(Boolean).join("\n")
      : failedRunDetails(run).join("\n");
    const hasLifecycleFailure = !completed || Boolean(run.failure || run.projectionFailure || run.diagnostics || run.taskRegistration?.failure);
    const lifecycleFailure = run.projectionFailure ?? run.diagnostics;
    const lifecycleStage = lifecycleFailure?.stage ?? run.taskRegistration?.failure?.stage ?? run.failure?.stage ?? "unknown";
    const lifecycleCode = lifecycleFailure?.code
      ?? (run.taskRegistration?.failure ? "TASK_REGISTRATION_FAILED" : "UNCLASSIFIED_FAILURE");
    const lifecycleCorrelationId = deriveCorrelationId(run.runId, lifecycleStage, lifecycleCode);
    const userText = hasLifecycleFailure ? `${text}（問い合わせID: ${lifecycleCorrelationId}）` : text;
    const userDetails = completed && hasLifecycleFailure
      ? `${details}\n${safeFailureDetails(run).join("\n")}` : details;
    const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: userDetails } }];
    if (completed) {
      const elements: Array<Record<string, unknown>> = [];
      if (taskRegistrationPending) {
        elements.push({ type: "button", text: { type: "plain_text", text: "タスク処理を再実行" },
          action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${run.destination.id}`,
          value: JSON.stringify({ runId: run.runId, destinationId: run.destination.id,
            sourceThreadTs: run.sourceThreadTs }) });
      }
      elements.push({ type: "button", text: { type: "plain_text", text: "保存先をやり直す" },
        action_id: MEETING_MINUTES_REDO_ACTION_ID,
        value: JSON.stringify({ runId: run.runId, fileName: run.file.name }) });
      blocks.push({ type: "actions", elements });
    } else if (!permanentBrainbaseFailure && (run.projectionFailure ?? run.diagnostics)?.retryable !== false) {
      blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "再実行" },
        action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${run.destination.id}`,
        value: JSON.stringify({ runId: run.runId, destinationId: run.destination.id,
          sourceThreadTs: run.sourceThreadTs }) }] });
    }
    await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs, text: userText, blocks });
  }
  /**
   * One-shot, non-recursive fallback for a failed status projection. It deliberately
   * updates only the original processing message and does not call updateRunStatus
   * or assistant.threads.setStatus again.
   */
  async projectStatusFailure(run: MeetingMinutesRun): Promise<void> {
    if (!run.slack?.processingTs) throw new Error("meeting_minutes_status_coordinates_missing");
    const message = statusProjectionFailedMessage(run.runId, run.file.name);
    await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs,
      text: message.text, blocks: message.blocks });
  }
  private async setThreadStatus(run: MeetingMinutesRun, status: string, required = false): Promise<void> {
    try {
      await this.post("assistant.threads.setStatus", {
        channel_id: run.sourceChannelId,
        thread_ts: run.sourceThreadTs,
        status,
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "meeting_minutes_thread_status_failed", runId: run.runId,
        stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
        correlation_id: deriveCorrelationId(run.runId, "status_projection", "STATUS_PROJECTION_FAILED"), retryable: true }));
      if (required) throw error;
    }
  }
  async postParent(channelId: string, fileName: string, summary: string, clientMsgId: string): Promise<string> {
    const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
    const text = `📝 会議要約: ${safeFileName}`;
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `📝 *会議要約: ${safeFileName}*\n\n_AI生成による要約です_` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: escapeUntrustedSlackMrkdwn(summary) } },
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: "💬 _詳細な議事録はこの投稿のスレッドに投稿されます_" }] },
    ];
    const result = await this.post("chat.postMessage", { channel: channelId, text, blocks,
      client_msg_id: await clientMessageId(clientMsgId), unfurl_links: false });
    if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async postThreadChunk(channelId: string, threadTs: string, fileName: string, minutes: string,
    index: number, total: number, clientMsgId: string): Promise<string> {
    const first = index === 0; const last = index === total - 1;
    const safeFileName = escapeUntrustedSlackMrkdwn(fileName);
    const text = first ? `📄 詳細議事録: ${safeFileName}` : `📄 詳細議事録（続き ${index + 1}/${total}）`;
    const blocks: Array<Record<string, unknown>> = [];
    if (first) blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `📄 *詳細議事録: ${safeFileName}*\n\n_AI生成による詳細な議事録です_` } },
      { type: "divider" },
    );
    blocks.push({ type: "section", text: { type: "mrkdwn", text: escapeUntrustedSlackMrkdwn(minutes) } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: last
      ? "🤖 _この議事録はAIにより自動生成されました。必要に応じて内容をご確認ください。_"
      : `📜 _続きがあります（${total}件中 ${index + 1}件目）_` }] });
    const result = await this.post("chat.postMessage", { channel: channelId, thread_ts: threadTs, text, blocks,
      client_msg_id: await clientMessageId(clientMsgId),
    unfurl_links: false }); if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async postTaskCard(run: MeetingMinutesRun): Promise<string> {
    if (!run.destination || !run.slack?.parentTs) throw new Error("meeting_minutes_task_card_coordinates_missing");
    const revision = run.revision ?? 0;
    const idempotencySeed = revision > 0
      ? `${run.runId}-revision-${revision}-task-card`
      : `${run.runId}-task-card`;
    const result = await this.post("chat.postMessage", { channel: run.destination.slackChannelId,
      thread_ts: run.slack.parentTs, ...meetingMinutesTaskCard(run),
      client_msg_id: await clientMessageId(idempotencySeed) });
    if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async updateTaskCard(run: MeetingMinutesRun): Promise<void> {
    if (!run.destination || !run.slack?.taskCardTs) throw new Error("meeting_minutes_task_card_coordinates_missing");
    await this.post("chat.update", { channel: run.destination.slackChannelId, ts: run.slack.taskCardTs,
      ...meetingMinutesTaskCard(run) });
  }
  async postTaskScopeMismatch(run: MeetingMinutesRun, userId: string,
    failure = meetingMinutesTaskActionFailure(run.runId, "TASK_SCOPE_MISMATCH", false)): Promise<void> {
    if (!run.destination || !run.slack?.parentTs) throw new Error("meeting_minutes_task_card_coordinates_missing");
    const details = taskActionFailureDetails(failure);
    await this.post("chat.postEphemeral", { channel: run.destination.slackChannelId, thread_ts: run.slack.parentTs,
      user: userId, text: [`このタスクは現在のBrainbaseプロジェクトに紐付いていないため、編集・取消できません。`,
        ...details, "再試行せず、管理者がプロジェクト紐付けを確認してください。"].join("\n") });
  }
  async postTaskActionFailure(run: MeetingMinutesRun, userId: string, action: string,
    failure: MeetingMinutesTaskActionFailure | string): Promise<void> {
    if (!run.destination || !run.slack?.parentTs) throw new Error("meeting_minutes_task_card_coordinates_missing");
    const actionLabel = action === "cancel" ? "取消" : "編集";
    const normalizedFailure = normalizeTaskActionFailure(run, failure);
    const guidance = normalizedFailure.retryable
      ? "もう一度操作してください。"
      : "再試行せず、管理者がプロジェクト紐付けを確認してください。";
    await this.post("chat.postEphemeral", { channel: run.destination.slackChannelId, thread_ts: run.slack.parentTs,
      user: userId,
      text: [`議事録タスクの${actionLabel}に失敗しました。処理は安全に停止しました。`,
        ...taskActionFailureDetails(normalizedFailure), guidance].join("\n") });
  }
  async openTaskEditView(triggerId: string, view: Record<string, unknown>): Promise<void> {
    await this.post("views.open", { trigger_id: triggerId, view }, AbortSignal.timeout(2_000));
  }
  async retractSharedMinutes(channelId: string, parentTs: string, fileName: string): Promise<void> {
    try {
      await this.post("chat.update", { channel: channelId, ts: parentTs,
        text: `${escapeUntrustedSlackMrkdwn(fileName)} の議事録は保存先変更のため取り消されました。`,
        blocks: [{ type: "section", text: { type: "mrkdwn",
          text: `*⚠️ この議事録は取り消されました*\n保存先を変更して再作成しています。` } }] });
    } catch (error) {
      if (error instanceof Error && error.message === "slack_api_failed:chat.update:message_not_found") return;
      throw error;
    }
  }
  async showDestinationSelection(run: MeetingMinutesRun,
    destinations: readonly MeetingMinutesDestination[]): Promise<string> {
    if (!run.slack?.processingTs) throw new Error("meeting_minutes_status_coordinates_missing");
    const message = organizationSelectionMessage(run.runId, run.file.name, destinations);
    await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs,
      text: message.text, blocks: message.blocks });
    return run.slack.processingTs;
  }
  async showRedoFailure(run: MeetingMinutesRun): Promise<void> {
    if (!run.slack?.processingTs) throw new Error("meeting_minutes_status_coordinates_missing");
    const message = redoFailedMessage(run.runId, run.file.name);
    try {
      await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs,
        text: message.text, blocks: message.blocks });
    } catch (error) {
      // A failed failure notice still gets one bounded, code-bearing update. Do
      // not call showRedoFailure/updateRunStatus again from this fallback.
      try {
        const fallback = statusProjectionFailedMessage(run.runId, run.file.name);
        await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs,
          text: fallback.text, blocks: fallback.blocks });
        return;
      } catch {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_failure_projection_failed", runId: run.runId,
          stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
          correlation_id: deriveCorrelationId(run.runId, "status_projection", "STATUS_PROJECTION_FAILED"), retryable: true }));
      }
      throw error;
    }
  }
}
