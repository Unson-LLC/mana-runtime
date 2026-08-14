import type { SlackFileReference, SlackQueueEvent } from "./types.js";

const SLACK_REPLAY_WINDOW_SECONDS = 300;
const MAX_SLACK_FILES = 10;
const MAX_SLACK_FILE_SIZE_BYTES = 20 * 1024 * 1024;

interface VerifySlackRequestOptions {
  body: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  nowMs?: number;
}

interface HandleSlackRequestOptions {
  signingSecret: string;
  tenantId?: string;
  expectedTeamId: string;
  expectedAppId?: string;
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

function normalizeSlackFiles(value: unknown): SlackFileReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_SLACK_FILES) throw new Error("slack_files_too_many");
  const files = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("slack_file_invalid");
    const id = nonEmptyString(candidate.id);
    const name = nonEmptyString(candidate.name);
    const mimetype = nonEmptyString(candidate.mimetype);
    const size = candidate.size;
    if (!id || !name || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("slack_file_invalid");
    }
    if (typeof size === "number" &&
      (!Number.isSafeInteger(size) || size < 0 || size > MAX_SLACK_FILE_SIZE_BYTES)) {
      throw new Error("slack_file_size_invalid");
    }
    return { id, name: name.slice(0, 255), ...(mimetype ? { mimetype } : {}),
      ...(typeof size === "number" ? { size } : {}) };
  });
  return files.length > 0 ? files : undefined;
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
  tenantId = "techknight",
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
  const channelType = nonEmptyString(payload.event.channel_type);
  const files = normalizeSlackFiles(payload.event.files);
  return {
    tenantId,
    eventId,
    workspaceId: expectedTeamId,
    channelId,
    ...(channelType ? { channelType } : {}),
    threadTs: nonEmptyString(payload.event.thread_ts) ?? messageTs,
    messageTs,
    ...(userId ? { userId } : {}),
    ...(botId ? { botId } : {}),
    ...(subtype ? { subtype } : {}),
    eventType,
    text: typeof payload.event.text === "string" ? payload.event.text : "",
    receivedAt,
    ...(files ? { files } : {}),
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

  if (
    options.expectedAppId &&
    (!isRecord(payload) || payload.api_app_id !== options.expectedAppId)
  ) {
    return jsonResponse({ error: "slack_app_forbidden" }, 403);
  }

  if (!isRecord(payload) || payload.team_id !== options.expectedTeamId) {
    return jsonResponse({ error: "slack_team_forbidden" }, 403);
  }

  try {
    const event = normalizeSlackEvent(
      payload,
      options.expectedTeamId,
      new Date(options.nowMs ?? Date.now()).toISOString(),
      options.tenantId,
    );
    await options.send(event);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "slack_event_invalid";
    return jsonResponse({ error: message }, message === "slack_team_forbidden" ? 403 : 400);
  }
}
