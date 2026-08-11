import type { SlackQueueEvent } from "./types.js";

const SLACK_REPLAY_WINDOW_SECONDS = 300;

interface VerifySlackRequestOptions {
  body: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  nowMs?: number;
}

interface HandleSlackRequestOptions {
  signingSecret: string;
  expectedTeamId: string;
  nowMs?: number;
  send(event: SlackQueueEvent): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifySlackRequest(
  options: VerifySlackRequestOptions,
): Promise<boolean> {
  if (!/^\d+$/.test(options.timestamp) || !/^v0=[a-f0-9]{64}$/.test(options.signature)) {
    return false;
  }

  const timestampSeconds = Number(options.timestamp);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > SLACK_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${options.timestamp}:${options.body}`),
  );
  return constantTimeEqual(`v0=${bytesToHex(digest)}`, options.signature);
}

export function normalizeSlackEvent(
  payload: unknown,
  expectedTeamId: string,
  receivedAt: string,
): SlackQueueEvent {
  if (!isRecord(payload) || payload.team_id !== expectedTeamId) {
    throw new Error("slack_team_forbidden");
  }
  if (payload.type !== "event_callback" || !isRecord(payload.event)) {
    throw new Error("slack_event_invalid");
  }

  const eventId = nonEmptyString(payload.event_id);
  const eventType = nonEmptyString(payload.event.type);
  const channelId = nonEmptyString(payload.event.channel);
  const messageTs = nonEmptyString(payload.event.ts);
  if (!eventId || !eventType || !channelId || !messageTs) {
    throw new Error("slack_event_invalid");
  }

  const userId = nonEmptyString(payload.event.user);
  const botId = nonEmptyString(payload.event.bot_id);
  const subtype = nonEmptyString(payload.event.subtype);
  return {
    tenantId: "techknight",
    eventId,
    workspaceId: expectedTeamId,
    channelId,
    threadTs: nonEmptyString(payload.event.thread_ts) ?? messageTs,
    messageTs,
    ...(userId ? { userId } : {}),
    ...(botId ? { botId } : {}),
    ...(subtype ? { subtype } : {}),
    eventType,
    text: typeof payload.event.text === "string" ? payload.event.text : "",
    receivedAt,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function handleSlackRequest(
  request: Request,
  options: HandleSlackRequestOptions,
): Promise<Response> {
  const body = await request.text();
  const validSignature = await verifySlackRequest({
    body,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "",
    signingSecret: options.signingSecret,
    nowMs: options.nowMs,
  });
  if (!validSignature) return jsonResponse({ error: "slack_signature_invalid" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "slack_payload_invalid" }, 400);
  }
  if (isRecord(payload) && payload.type === "url_verification") {
    const challenge = nonEmptyString(payload.challenge);
    return challenge
      ? jsonResponse({ challenge }, 200)
      : jsonResponse({ error: "slack_payload_invalid" }, 400);
  }

  if (!isRecord(payload) || payload.team_id !== options.expectedTeamId) {
    return jsonResponse({ error: "slack_team_forbidden" }, 403);
  }

  try {
    const event = normalizeSlackEvent(
      payload,
      options.expectedTeamId,
      new Date(options.nowMs ?? Date.now()).toISOString(),
    );
    await options.send(event);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "slack_event_invalid";
    return jsonResponse({ error: message }, message === "slack_team_forbidden" ? 403 : 400);
  }
}
