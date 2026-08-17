import { verifySlackRequest } from "./slack.js";
import type { SlackQueueEvent } from "./types.js";

const COMMANDS = new Set(["/vibepro", "/ryoko-develop"]);
export async function handleSlackCommandRequest(request: Request, options: {
  signingSecret: string;
  placements: ReadonlyArray<{ channelId: string; allowedUserIds: readonly string[] }>;
  nowMs?: number; send(event: Omit<SlackQueueEvent, "tenantId">): Promise<unknown>;
}): Promise<Response> {
  const body = await request.text();
  const valid = await verifySlackRequest({ body, timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "", signingSecret: options.signingSecret, nowMs: options.nowMs });
  if (!valid) return Response.json({ error: "slack_signature_invalid" }, { status: 401 });
  const form = new URLSearchParams(body);
  const teamId = form.get("team_id") ?? ""; const channelId = form.get("channel_id") ?? "";
  const userId = form.get("user_id") ?? ""; const command = form.get("command") ?? "";
  const triggerId = form.get("trigger_id") ?? ""; const text = (form.get("text") ?? "").trim();
  const placement = options.placements.find((candidate) => candidate.channelId === channelId);
  if (!COMMANDS.has(command) || !placement?.allowedUserIds.includes(userId)) {
    return Response.json({ response_type: "ephemeral", text: "このコマンドを実行する権限がありません。" }, { status: 200 });
  }
  if (!text) return Response.json({ response_type: "ephemeral", text: "開発依頼を入力してください。" }, { status: 200 });
  const nowMs = options.nowMs ?? Date.now();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${teamId}:${channelId}:${userId}:${triggerId}:${command}`));
  const eventId = `slash_${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const ts = String(nowMs / 1000);
  await options.send({ eventId, workspaceId: teamId, channelId, threadTs: ts,
    messageTs: ts, userId, eventType: "app_mention", text: `/develop ${text}`, receivedAt: new Date(nowMs).toISOString() });
  return Response.json({ response_type: "ephemeral", text: "開発依頼を受け付けました。結果はこのチャンネルへ投稿します。" });
}
