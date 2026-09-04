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
  claimToken: string;
  preserveUntilReconciled?: boolean;
  responseTs?: string;
  completedAt?: number;
}

export type RuntimeEventClaimResult =
  | { disposition: "claimed"; claimToken: string }
  | { disposition: "in_progress"; retryAfterMs: number }
  | { disposition: "completed"; responseTs?: string };

export type RuntimeClaimSettlement = "complete" | "release";

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

/**
 * Claims the canonical Slack message delivery identity. `message` and
 * `app_mention` variants of one Slack post intentionally share this claim, but
 * only a delivered text reply completes it. Non-reply triage releases it so a
 * later explicit mention remains eligible.
 */
export async function claimRuntimeEvent(
  storage: TransactionalStorage,
  eventId: string,
  now = Date.now(),
  preserveUntilReconciled = false,
): Promise<RuntimeEventClaimResult> {
  const storageKey = key(eventId);
  return storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status === "completed") {
      return { disposition: "completed", ...(current.responseTs ? { responseTs: current.responseTs } : {}) };
    }
    if (current?.status === "processing") {
      const elapsedMs = now - current.claimedAt;
      if (current.preserveUntilReconciled || elapsedMs < LEASE_MS) {
        return {
          disposition: "in_progress",
          retryAfterMs: current.preserveUntilReconciled ? LEASE_MS : LEASE_MS - elapsedMs,
        };
      }
    }
    const claimToken = crypto.randomUUID();
    await transaction.put(storageKey, {
      status: "processing",
      claimedAt: now,
      claimToken,
      ...(preserveUntilReconciled ? { preserveUntilReconciled: true } : {}),
    } satisfies EventClaim);
    return { disposition: "claimed", claimToken };
  });
}

export function runtimeClaimSettlement(result: { outcome?: string; responseTs?: string }): RuntimeClaimSettlement {
  if (result.outcome === "ignored" || result.outcome === "reacted") return "release";
  return typeof result.responseTs === "string" && result.responseTs.length > 0 ? "complete" : "release";
}

export async function completeRuntimeEvent(
  storage: TransactionalStorage,
  eventId: string,
  claimToken: string,
  responseTs: string | undefined,
  now = Date.now(),
): Promise<void> {
  const storageKey = key(eventId);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status !== "processing") throw new Error("runtime_event_claim_missing");
    if (current.claimToken !== claimToken) throw new Error("runtime_event_claim_conflict");
    await transaction.put(storageKey, {
      status: "completed",
      claimedAt: current.claimedAt,
      claimToken,
      ...(responseTs ? { responseTs } : {}),
      completedAt: now,
    } satisfies EventClaim);
  });
}

export async function releaseRuntimeEvent(
  storage: TransactionalStorage,
  eventId: string,
  claimToken: string,
): Promise<void> {
  const storageKey = key(eventId);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<EventClaim>(storageKey);
    if (current?.status !== "processing") throw new Error("runtime_event_claim_missing");
    if (current.claimToken !== claimToken) throw new Error("runtime_event_claim_conflict");
    if (current.preserveUntilReconciled) throw new Error("runtime_event_claim_preserved");
    await transaction.delete(storageKey);
  });
}
