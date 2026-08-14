import { MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, MEETING_MINUTES_CHOOSE_ACTION_ID,
  MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID, MEETING_MINUTES_REDO_ACTION_ID, type MeetingMinutesDestination,
  type MeetingMinutesRun } from "./meeting-minutes-contracts.js";

export interface SlackSelectionMessage {
  replace_original: true;
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function organizationSelectionMessage(runId: string, fileName: string,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage {
  const preferredOrder = ["unson", "unson-business", "tech-knight"];
  const organizations = [...new Map(destinations.map((item) => [item.organization.id, item.organization])).values()]
    .sort((left, right) => {
      const leftIndex = preferredOrder.indexOf(left.id); const rightIndex = preferredOrder.indexOf(right.id);
      return (leftIndex < 0 ? preferredOrder.length : leftIndex) - (rightIndex < 0 ? preferredOrder.length : rightIndex);
    });
  return { replace_original: true, text: `${fileName} の保存先組織を選択してください。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${fileName}* の保存先組織を選択してください。` } },
    { type: "actions", elements: organizations.map((organization) => ({ type: "button",
      text: { type: "plain_text", text: organization.name },
      action_id: `${MEETING_MINUTES_CHOOSE_ORGANIZATION_ACTION_ID}:${organization.id}`,
      value: JSON.stringify({ runId, organizationId: organization.id, fileName }) })) },
  ] };
}

export function projectSelectionMessage(runId: string, fileName: string, organizationId: string,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage {
  const projects = destinations.filter((item) => item.organization.id === organizationId);
  if (!projects.length) throw new Error("meeting_minutes_organization_invalid");
  const organization = projects[0]!.organization;
  return { replace_original: true, text: `${fileName} の保存先プロジェクトを選択してください。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${fileName}* の保存先プロジェクトを選択してください。\n組織: *${organization.name}*` } },
    { type: "actions", elements: projects.map((destination) => ({ type: "button",
      text: { type: "plain_text", text: destination.name }, action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${destination.id}`,
      value: JSON.stringify({ runId, destinationId: destination.id, fileName }) })) },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "← 組織選択に戻る" },
      action_id: MEETING_MINUTES_BACK_TO_ORGANIZATIONS_ACTION_ID, value: JSON.stringify({ runId, fileName }) }] },
  ] };
}

export function destinationSelectedMessage(runId: string, fileName: string,
  destination: MeetingMinutesDestination): SlackSelectionMessage {
  return { replace_original: true, text: `${fileName} の保存先に ${destination.name} を選択しました。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*✅ 保存先を選択しました*\n保存先: ${destination.name}` } },
  ] };
}

export function redoConfirmationMessage(runId: string, fileName: string): SlackSelectionMessage {
  return { replace_original: true, text: `${fileName} の保存先をやり直しますか？`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*保存先をやり直しますか？*\nGitHubの議事録・文字起こしと自動登録タスクを取り消します。旧共有投稿は「取り消し済み」にし、保存先選択へ戻します。` } },
    { type: "actions", elements: [
      { type: "button", style: "danger", text: { type: "plain_text", text: "取り消して選び直す" },
        action_id: "mana_meeting_minutes_confirm_redo", value: JSON.stringify({ runId, fileName }) },
    ] },
  ] };
}

export function suggestedDestinationMessage(run: MeetingMinutesRun,
  destinations: readonly MeetingMinutesDestination[]): SlackSelectionMessage | undefined {
  const destination = destinations.find((item) => item.id === run.routing?.suggestedDestinationId);
  if (!destination) return undefined;
  const reason = run.routing?.reason ? `\n推定根拠: ${run.routing.reason}` : "";
  return { replace_original: true, text: `${run.file.name} の保存先候補は ${destination.name} です。`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${run.file.name}* の保存先候補です。\n候補は *${destination.name}* です。${reason}` } },
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
function failedRunDetails(run: MeetingMinutesRun): string[] {
  const destination = `保存先: ${run.destination!.name}`;
  if (/slack_api_failed:chat\.postMessage:(?:channel_not_found|not_in_channel)/.test(run.failure?.message ?? "")) {
    return ["*⚠️ 保存先チャンネルへ投稿できませんでした*", destination,
      `Manaアプリが「${run.destination!.name}」のチャンネルに参加しているか確認してください。`,
      "参加させた後、下のボタンから再実行できます。"];
  }
  return ["*⚠️ 議事録の作成に失敗しました*", destination, "下のボタンから再実行できます。"];
}
async function clientMessageId(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meeting-minutes:${seed}`))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class MeetingMinutesSlackClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private async post(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<SlackApiResponse> {
    if (!this.token.trim()) throw new Error("slack_bot_token_not_configured");
    const response = await this.fetchImpl.call(globalThis, `https://slack.com/api/${method}`, { method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal });
    const result = await response.json() as SlackApiResponse;
    if (!response.ok || !result.ok) throw new Error(`slack_api_failed:${method}:${result.error ?? response.status}`);
    return result;
  }
  async downloadTextFile(fileId: string, maxBytes = 20 * 1024 * 1024): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new Error("slack_file_id_invalid");
    const infoResponse = await this.fetchImpl.call(globalThis, `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const info = await infoResponse.json() as { ok?: boolean; error?: string; file?: { name?: string; mimetype?: string; size?: number; url_private_download?: string } };
    if (!infoResponse.ok || !info.ok || !info.file?.url_private_download) throw new Error(`slack_file_info_failed:${info.error ?? infoResponse.status}`);
    if (!/\.txt$/i.test(info.file.name ?? "") || (info.file.mimetype && info.file.mimetype !== "text/plain")) throw new Error("slack_file_type_invalid");
    if (typeof info.file.size === "number" && info.file.size > maxBytes) throw new Error("slack_file_size_invalid");
    const download = await this.fetchImpl.call(globalThis, info.file.url_private_download, { headers: { Authorization: `Bearer ${this.token}` } });
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
  async postProcessingStatus(run: MeetingMinutesRun): Promise<string> {
    if (!run.destination) throw new Error("meeting_minutes_destination_missing");
    if (!run.slack?.selectionTs) throw new Error("meeting_minutes_selection_coordinates_missing");
    await this.setThreadStatus(run, `議事録を作成しています…（${run.destination.name}）`);
    const result = await this.post("chat.postMessage", { channel: run.sourceChannelId, thread_ts: run.sourceThreadTs,
      text: `${run.file.name} の議事録を作成しています。`, client_msg_id: await clientMessageId(`${run.runId}-processing`),
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
    await this.setThreadStatus(run, "");
    const completed = outcome === "completed";
    const text = completed
      ? `${run.file.name} の議事録を作成しました。`
      : `${run.file.name} の議事録作成に失敗しました。再実行できます。`;
    const details = completed
      ? [`*✅ 議事録を作成しました*`, `保存先: ${run.destination.name}`,
        run.github?.minutesUrl ? `<${run.github.minutesUrl}|GitHubで議事録を開く>` : undefined,
        `共有先: <#${run.destination.slackChannelId}>`].filter(Boolean).join("\n")
      : failedRunDetails(run).join("\n");
    const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: details } }];
    if (completed) {
      blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "保存先をやり直す" },
        action_id: MEETING_MINUTES_REDO_ACTION_ID,
        value: JSON.stringify({ runId: run.runId, fileName: run.file.name }) }] });
    } else {
      blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "再実行" },
        action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${run.destination.id}`,
        value: JSON.stringify({ runId: run.runId, destinationId: run.destination.id,
          sourceThreadTs: run.sourceThreadTs }) }] });
    }
    await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs, text, blocks });
  }
  private async setThreadStatus(run: MeetingMinutesRun, status: string): Promise<void> {
    try {
      await this.post("assistant.threads.setStatus", {
        channel_id: run.sourceChannelId,
        thread_ts: run.sourceThreadTs,
        status,
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "meeting_minutes_thread_status_failed", runId: run.runId,
        message: error instanceof Error ? error.message : String(error) }));
    }
  }
  async postParent(channelId: string, fileName: string, summary: string, clientMsgId: string): Promise<string> {
    const text = `📝 会議要約: ${fileName}`;
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `📝 *会議要約: ${fileName}*\n\n_AI生成による要約です_` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: summary } },
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
    const text = first ? `📄 詳細議事録: ${fileName}` : `📄 詳細議事録（続き ${index + 1}/${total}）`;
    const blocks: Array<Record<string, unknown>> = [];
    if (first) blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `📄 *詳細議事録: ${fileName}*\n\n_AI生成による詳細な議事録です_` } },
      { type: "divider" },
    );
    blocks.push({ type: "section", text: { type: "mrkdwn", text: minutes } });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: last
      ? "🤖 _この議事録はAIにより自動生成されました。必要に応じて内容をご確認ください。_"
      : `📜 _続きがあります（${total}件中 ${index + 1}件目）_` }] });
    const result = await this.post("chat.postMessage", { channel: channelId, thread_ts: threadTs, text, blocks,
      client_msg_id: await clientMessageId(clientMsgId),
      unfurl_links: false }); if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async retractSharedMinutes(channelId: string, parentTs: string, fileName: string): Promise<void> {
    await this.post("chat.update", { channel: channelId, ts: parentTs,
      text: `${fileName} の議事録は保存先変更のため取り消されました。`,
      blocks: [{ type: "section", text: { type: "mrkdwn",
        text: `*⚠️ この議事録は取り消されました*\n保存先を変更して再作成しています。` } }] });
  }
  async showDestinationSelection(run: MeetingMinutesRun,
    destinations: readonly MeetingMinutesDestination[]): Promise<string> {
    if (!run.slack?.processingTs) throw new Error("meeting_minutes_status_coordinates_missing");
    const message = organizationSelectionMessage(run.runId, run.file.name, destinations);
    await this.post("chat.update", { channel: run.sourceChannelId, ts: run.slack.processingTs,
      text: message.text, blocks: message.blocks });
    return run.slack.processingTs;
  }
}
