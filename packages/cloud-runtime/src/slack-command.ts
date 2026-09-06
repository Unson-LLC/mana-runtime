import { verifySlackRequest } from "./slack.js";
import { readSlackRequestBody, slackRequestBodyErrorResponse } from "./slack-request-body.js";
import type { SlackQueueEvent } from "./types.js";

const COMMANDS = new Set(["/vibepro", "/ryoko-develop"]);

export interface SlackDevelopmentCommandInput {
  workspaceId: string;
  channelId: string;
  requesterId: string;
  triggerId: string;
  command: "/vibepro" | "/ryoko-develop";
  initialProblem: string;
}

export interface SlackMeetingMinutesRepairInput {
  workspaceId: string;
  channelId: string;
  requesterId: string;
  runId: string;
  sourceThreadTs: string;
}

export async function handleSlackCommandRequest(request: Request, options: {
  signingSecret: string;
  placements: ReadonlyArray<{ channelId: string; allowedUserIds: readonly string[] }>;
  repairPlacements?: ReadonlyArray<{ channelId: string; allowedUserIds: readonly string[] }>;
  nowMs?: number;
  /**
   * Production supplies this to open the non-engineer improvement form. The
   * queue fallback remains for compatibility with already-installed command
   * tests and emergency operator use, but the canonical runtime never invents
   * a synthetic Slack thread timestamp.
   */
  openModal?(input: SlackDevelopmentCommandInput): Promise<unknown>;
  /** Operator-only display repair for an awaiting selector or an already completed run. */
  repairMeetingMinutes?(input: SlackMeetingMinutesRepairInput): Promise<unknown>;
  /** Keep modal opening alive after returning Slack's required fast acknowledgement. */
  defer?(work: Promise<unknown>): void;
  send(event: Omit<SlackQueueEvent, "tenantId">): Promise<unknown>;
}): Promise<Response> {
  let body: string;
  try {
    body = await readSlackRequestBody(request);
  } catch (error) {
    const rejected = slackRequestBodyErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }
  const valid = await verifySlackRequest({
    body,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "",
    signingSecret: options.signingSecret,
    nowMs: options.nowMs,
  });
  if (!valid) return Response.json({ error: "slack_signature_invalid" }, { status: 401 });

  const form = new URLSearchParams(body);
  const workspaceId = form.get("team_id") ?? "";
  const channelId = form.get("channel_id") ?? "";
  const requesterId = form.get("user_id") ?? "";
  const command = form.get("command") ?? "";
  const triggerId = form.get("trigger_id") ?? "";
  const text = (form.get("text") ?? "").trim();
  const repairMatch = text.match(/^repair-meeting-minutes\s+([A-Za-z0-9_-]{3,260})\s+(\d{1,20}(?:\.\d{1,12})?)$/);
  const placement = options.placements.find((candidate) => candidate.channelId === channelId);
  const repairPlacement = options.repairPlacements?.find((candidate) => candidate.channelId === channelId);
  const authorized = repairMatch
    ? repairPlacement?.allowedUserIds.includes(requesterId)
    : placement?.allowedUserIds.includes(requesterId);
  if (!COMMANDS.has(command) || !authorized) {
    return Response.json({
      response_type: "ephemeral",
      text: "このコマンドを実行する権限がありません。",
    }, { status: 200 });
  }

  if (repairMatch && options.repairMeetingMinutes) {
    const repairWork = options.repairMeetingMinutes({ workspaceId, channelId, requesterId,
      runId: repairMatch[1]!, sourceThreadTs: repairMatch[2]! });
    if (options.defer) options.defer(repairWork);
    else await repairWork;
    return Response.json({ response_type: "ephemeral", text: "既存の議事録投稿の表示修復を受け付けました。" });
  }

  if (options.openModal) {
    if (!triggerId) {
      return Response.json({ response_type: "ephemeral", text: "入力フォームを開けませんでした。もう一度お試しください。" });
    }
    const modalWork = options.openModal({
      workspaceId,
      channelId,
      requesterId,
      triggerId,
      command: command as SlackDevelopmentCommandInput["command"],
      initialProblem: text,
    });
    if (options.defer) options.defer(modalWork);
    else await modalWork;
    return Response.json({
      response_type: "ephemeral",
      text: "Manaの改善フォームを開きました。困っていることと完了条件を入力してください。",
    });
  }

  // Backward-compatible operator fallback. Slash commands have no visible
  // message of their own, so production must use openModal + a real root post.
  if (!text) {
    return Response.json({ response_type: "ephemeral", text: "開発依頼を入力してください。" }, { status: 200 });
  }
  const nowMs = options.nowMs ?? Date.now();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${workspaceId}:${channelId}:${requesterId}:${triggerId}:${command}`),
  );
  const eventId = `slash_${[...new Uint8Array(digest)].slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const ts = String(nowMs / 1000);
  await options.send({
    eventId,
    workspaceId,
    channelId,
    threadTs: ts,
    messageTs: ts,
    userId: requesterId,
    eventType: "app_mention",
    text: `/develop ${text}`,
    receivedAt: new Date(nowMs).toISOString(),
  });
  return Response.json({
    response_type: "ephemeral",
    text: "開発依頼を受け付けました。結果はこのチャンネルへ投稿します。",
  });
}
