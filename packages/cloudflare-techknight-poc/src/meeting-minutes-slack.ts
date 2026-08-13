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
  async postParent(channelId: string, text: string, clientMsgId: string): Promise<string> {
    const result = await this.post("chat.postMessage", { channel: channelId, text, client_msg_id: await clientMessageId(clientMsgId), unfurl_links: false });
    if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
  async postThreadChunk(channelId: string, threadTs: string, text: string, clientMsgId: string): Promise<string> {
    const result = await this.post("chat.postMessage", { channel: channelId, thread_ts: threadTs, text, client_msg_id: await clientMessageId(clientMsgId),
      unfurl_links: false }); if (!result.ts) throw new Error("slack_response_ts_missing"); return result.ts;
  }
}
