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
