import type { SlackQueueEvent } from "./types.js";

const MAX_PERSISTED_EVENT_TEXT_CHARS = 20_000;

export interface WorkspaceFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  ls(prefix: string): Promise<string[]>;
  readFile(path: string): Promise<string | ReadableStream<Uint8Array>>;
  writeFile(path: string, value: string): Promise<unknown>;
}

export interface ReplyCompletion {
  eventId: string;
  responseTs: string;
  completedAt: string;
  outcome?: "meeting_tasks_disabled";
}

export type ReplyFailureNoticeStatus = "pending" | "sent";

/**
 * Durable state for a fixed failure notice sent after reply generation was
 * rejected by the judgment audit. This is deliberately separate from
 * ReplyCompletion: a delivered failure notice is a failed operation and must
 * never make the ordinary /replies completion marker look successful.
 */
export interface ReplyFailureNotice {
  eventId: string;
  failureCode: string;
  status: ReplyFailureNoticeStatus;
  updatedAt: string;
  responseTs?: string;
}

export async function persistEventOnce(
  fs: WorkspaceFs,
  event: SlackQueueEvent,
): Promise<{ created: boolean; path: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.eventId)) {
    throw new Error("event_id_invalid");
  }

  const path = `/events/${event.eventId}.json`;
  await fs.mkdir("/events", { recursive: true });
  if ((await fs.ls("/events")).includes(path)) {
    return { created: false, path };
  }

  const persistedEvent = {
    ...event,
    text: event.text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .slice(0, MAX_PERSISTED_EVENT_TEXT_CHARS),
  };
  await fs.writeFile(path, JSON.stringify(persistedEvent));
  return { created: true, path };
}

function validateEventId(eventId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
    throw new Error("event_id_invalid");
  }
}

export async function isReplyCompleted(
  fs: WorkspaceFs,
  eventId: string,
): Promise<boolean> {
  validateEventId(eventId);
  const path = `/replies/${eventId}.json`;
  await fs.mkdir("/replies", { recursive: true });
  return (await fs.ls("/replies")).includes(path);
}

export async function readReplyCompletion(
  fs: WorkspaceFs,
  eventId: string,
): Promise<ReplyCompletion | undefined> {
  validateEventId(eventId);
  const path = `/replies/${eventId}.json`;
  await fs.mkdir("/replies", { recursive: true });
  if (!(await fs.ls("/replies")).includes(path)) return undefined;
  const raw = await fs.readFile(path);
  if (typeof raw !== "string") throw new Error("reply_completion_invalid");
  const value = JSON.parse(raw) as Partial<ReplyCompletion>;
  if (value.eventId !== eventId || typeof value.responseTs !== "string" || !value.responseTs
    || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))
    || (value.outcome !== undefined && value.outcome !== "meeting_tasks_disabled")) {
    throw new Error("reply_completion_invalid");
  }
  return {
    eventId, responseTs: value.responseTs, completedAt: value.completedAt,
    ...(value.outcome ? { outcome: value.outcome } : {}),
  };
}

export async function persistReplyCompletion(
  fs: WorkspaceFs,
  completion: ReplyCompletion,
): Promise<string> {
  validateEventId(completion.eventId);
  const path = `/replies/${completion.eventId}.json`;
  await fs.mkdir("/replies", { recursive: true });
  await fs.writeFile(path, JSON.stringify(completion));
  return path;
}

function validateFailureCode(failureCode: string): void {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(failureCode)) {
    throw new Error("reply_failure_notice_invalid");
  }
}

function validateTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error("reply_failure_notice_invalid");
  }
}

function validateReplyFailureNotice(value: unknown, eventId: string): ReplyFailureNotice {
  if (typeof value !== "object" || value === null) {
    throw new Error("reply_failure_notice_invalid");
  }
  const notice = value as Partial<ReplyFailureNotice>;
  if (notice.eventId !== eventId
    || typeof notice.failureCode !== "string"
    || typeof notice.status !== "string"
    || (notice.status !== "pending" && notice.status !== "sent")
    || typeof notice.updatedAt !== "string") {
    throw new Error("reply_failure_notice_invalid");
  }
  validateFailureCode(notice.failureCode);
  validateTimestamp(notice.updatedAt);
  if (notice.status === "sent"
    && (typeof notice.responseTs !== "string" || !notice.responseTs)) {
    throw new Error("reply_failure_notice_invalid");
  }
  if (notice.status === "pending" && notice.responseTs !== undefined) {
    throw new Error("reply_failure_notice_invalid");
  }
  return {
    eventId,
    failureCode: notice.failureCode,
    status: notice.status,
    updatedAt: notice.updatedAt,
    ...(notice.responseTs ? { responseTs: notice.responseTs } : {}),
  };
}

export async function readReplyFailureNotice(
  fs: WorkspaceFs,
  eventId: string,
): Promise<ReplyFailureNotice | undefined> {
  validateEventId(eventId);
  const path = `/reply-failure-notices/${eventId}.json`;
  await fs.mkdir("/reply-failure-notices", { recursive: true });
  if (!(await fs.ls("/reply-failure-notices")).includes(path)) return undefined;
  const raw = await fs.readFile(path);
  if (typeof raw !== "string") throw new Error("reply_failure_notice_invalid");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("reply_failure_notice_invalid");
  }
  return validateReplyFailureNotice(value, eventId);
}

export async function persistReplyFailureNotice(
  fs: WorkspaceFs,
  notice: ReplyFailureNotice,
): Promise<string> {
  validateEventId(notice.eventId);
  const validated = validateReplyFailureNotice(notice, notice.eventId);
  const path = `/reply-failure-notices/${notice.eventId}.json`;
  await fs.mkdir("/reply-failure-notices", { recursive: true });
  await fs.writeFile(path, JSON.stringify(validated));
  return path;
}
