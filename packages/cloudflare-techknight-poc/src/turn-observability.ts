import type { SlackQueueEvent } from "./types.js";

export type TurnLogLevel = "log" | "warn" | "error";

export interface TurnRuntimeTrace {
  placementId?: string;
  projectCodes?: readonly string[];
  actorIdHash?: string;
  workerVersion?: string;
  model?: string;
  effort?: string;
}

const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function safeTraceId(value: string | null | undefined): string | undefined {
  return value && SAFE_TRACE_ID.test(value) ? value : undefined;
}

export async function logFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest.slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function actorIdHash(event: SlackQueueEvent): Promise<string | undefined> {
  return event.userId
    ? logFingerprint(`${event.workspaceId}:${event.userId}`)
    : undefined;
}

export function emitStructuredLog(
  level: TurnLogLevel,
  entry: Record<string, unknown>,
): void {
  console[level]({ ...entry, schemaVersion: "mana.turn.v1" });
}

export function emitTurnLog(
  level: TurnLogLevel,
  name: string,
  event: SlackQueueEvent,
  runtime: TurnRuntimeTrace = {},
  fields: Record<string, unknown> = {},
): void {
  emitStructuredLog(level, {
    ...fields,
    event: name,
    traceId: event.eventId,
    tenantId: event.tenantId,
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    messageTs: event.messageTs,
    ...(runtime.placementId ? { placementId: runtime.placementId } : {}),
    ...(runtime.projectCodes ? { projectCodes: [...runtime.projectCodes] } : {}),
    ...(runtime.actorIdHash ? { actorIdHash: runtime.actorIdHash } : {}),
    ...(runtime.workerVersion ? { workerVersion: runtime.workerVersion } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {}),
  });
}
