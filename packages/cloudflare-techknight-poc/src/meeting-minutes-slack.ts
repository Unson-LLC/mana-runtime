import { MEETING_MINUTES_CHOOSE_ACTION_ID, type MeetingMinutesDestination, type MeetingMinutesRun } from "./meeting-minutes-contracts.js";

interface SlackApiResponse { ok?: boolean; error?: string; ts?: string }
async function clientMessageId(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`meeting-minutes:${seed}`))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class MeetingMinutesSlackClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private async post(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    if (!this.token.trim()) throw new Error("slack_bot_token_not_configured");
    const response = await this.fetchImpl.call(globalThis, `https://slack.com/api/${method}`, { method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
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
    const result = await this.post("chat.postMessage", { channel: run.sourceChannelId, thread_ts: run.sourceThreadTs,
      text: `${run.file.name} の保存先プロジェクトを選択してください。`, client_msg_id: await clientMessageId(`${run.runId}-selection`), blocks: [{ type: "section",
        text: { type: "mrkdwn", text: `*${run.file.name}* の保存先プロジェクトを選択してください。` } },
      { type: "actions", elements: destinations.map((destination) => ({ type: "button", text: { type: "plain_text", text: destination.name },
        action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${destination.id}`, value: JSON.stringify({ runId: run.runId, destinationId: destination.id }) })) }] });
    if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async postProcessingStatus(run: MeetingMinutesRun): Promise<string> {
    if (!run.destination) throw new Error("meeting_minutes_destination_missing");
    if (!run.slack?.selectionTs) throw new Error("meeting_minutes_selection_coordinates_missing");
    await this.setThreadStatus(run, `議事録を作成しています…（${run.destination.name}）`);
    return run.slack.selectionTs;
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
      : [`*⚠️ 議事録の作成に失敗しました*`, `保存先: ${run.destination.name}`,
        "下のボタンから再実行できます。"].join("\n");
    const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text: details } }];
    if (!completed) {
      blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "再実行" },
        action_id: `${MEETING_MINUTES_CHOOSE_ACTION_ID}:${run.destination.id}`,
        value: JSON.stringify({ runId: run.runId, destinationId: run.destination.id }) }] });
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
}
