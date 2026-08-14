const LEASE_MS = 15 * 60 * 1_000;
import type { SlackQueueEvent } from "./types.js";

interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface TransactionalStorage {
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
}

interface EventClaim {
  status: "processing" | "completed";
  claimedAt: number;
  responseTs?: string;
  completedAt?: number;
}

function key(eventId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) throw new Error("event_id_invalid");
  return `runtime-event:${eventId}`;
}

export function runtimeDeliveryId(event: Pick<SlackQueueEvent, "eventId" | "messageTs" | "eventType">): string {
  if (/^\d{10,16}\.\d{1,12}$/.test(event.messageTs)) {
    return `message_${event.messageTs.replace(".", "_")}`;
  }
  return event.eventId;
}

export async function claimRuntimeEvent(storage: TransactionalStorage, eventId: string, now = Date.now()): Promise<boolean> {
  const storageKey = key(eventId);
  return storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status === "completed") return false;
    if (current?.status === "processing" && now - current.claimedAt < LEASE_MS) return false;
    await transaction.put(storageKey, { status: "processing", claimedAt: now } satisfies EventClaim);
    return true;
  });
}

export async function completeRuntimeEvent(
  storage: TransactionalStorage,
  eventId: string,
  responseTs: string | undefined,
  now = Date.now(),
): Promise<void> {
  const storageKey = key(eventId);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status !== "processing") throw new Error("runtime_event_claim_missing");
    await transaction.put(storageKey, {
      status: "completed",
      claimedAt: current.claimedAt,
      ...(responseTs ? { responseTs } : {}),
      completedAt: now,
    } satisfies EventClaim);
  });
}

export async function releaseRuntimeEvent(storage: TransactionalStorage, eventId: string): Promise<void> {
  const storageKey = key(eventId);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status === "processing") await transaction.delete(storageKey);
  });
}
