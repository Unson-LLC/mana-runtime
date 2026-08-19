import {
  developmentCallbackPayloadHash,
  type DevelopmentCallbackClaim,
  type DevelopmentCallbackDelivery,
  type DevelopmentCallbackPayload,
} from "../development-callback.js";
import { TenantBoundaryError } from "./errors.js";

type StoredCallback = {
  status: "delivery_pending" | "accounting_pending" | "completed";
  payloadHash: string;
  delivery?: DevelopmentCallbackDelivery;
  leaseUntil?: string;
  fence: number;
  claimedAt?: string;
  deliveredAt?: string;
  completedAt?: string;
};

export interface DevelopmentCallbackTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DevelopmentCallbackStorage extends DevelopmentCallbackTransaction {
  transaction<T>(callback: (transaction: DevelopmentCallbackTransaction) => Promise<T>): Promise<T>;
}

function keyFor(eventId: string): string {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(eventId)) throw new Error("event_id_invalid");
  return `development-callback:${eventId}`;
}

export async function claimDevelopmentCallbackState(
  storage: DevelopmentCallbackStorage,
  eventId: string,
  payload: DevelopmentCallbackPayload,
  now = Date.now(),
): Promise<DevelopmentCallbackClaim> {
  const key = keyFor(eventId);
  const payloadHash = await developmentCallbackPayloadHash(payload);
  return storage.transaction(async (transaction) => {
    const current = await transaction.get<StoredCallback>(key);
    if (current) {
      if (current.payloadHash !== payloadHash) return { state: "conflict" };
      if (current.status === "completed") return { state: "completed", delivery: current.delivery, fence: current.fence };
      if (current.status === "accounting_pending" && current.delivery) {
        return { state: "accounting_pending", delivery: current.delivery, fence: current.fence };
      }
      if (current.leaseUntil && Date.parse(current.leaseUntil) > now) return { state: "in_progress" };
    }
    const fence = (current?.fence ?? 0) + 1;
    await transaction.put(key, {
      status: "delivery_pending",
      payloadHash,
      claimedAt: new Date(now).toISOString(),
      leaseUntil: new Date(now + 10_000).toISOString(),
      fence,
    } satisfies StoredCallback);
    return { state: "claimed", fence };
  });
}

export async function recordDevelopmentCallbackDeliveryState(
  storage: DevelopmentCallbackStorage,
  eventId: string,
  payload: DevelopmentCallbackPayload,
  delivery: DevelopmentCallbackDelivery,
  fence?: number,
  now = new Date().toISOString(),
): Promise<void> {
  const key = keyFor(eventId);
  const payloadHash = await developmentCallbackPayloadHash(payload);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<StoredCallback>(key);
    if (!current || current.payloadHash !== payloadHash) throw new Error("development_callback_conflict");
    if (fence === undefined || current.fence !== fence) {
      throw new TenantBoundaryError("slack_delivery", "REPLY_OWNERSHIP_CONFLICT");
    }
    if (current.status === "completed" || current.status === "accounting_pending") {
      if (JSON.stringify(current.delivery) !== JSON.stringify(delivery)) throw new Error("development_callback_conflict");
      return;
    }
    if (current.status !== "delivery_pending") throw new Error("development_callback_claim_missing");
    await transaction.put(key, {
      status: "accounting_pending",
      payloadHash,
      delivery,
      fence,
      deliveredAt: now,
    } satisfies StoredCallback);
  });
}

export async function completeDevelopmentCallbackState(
  storage: DevelopmentCallbackStorage,
  eventId: string,
  payload: DevelopmentCallbackPayload,
  delivery: DevelopmentCallbackDelivery,
  fence?: number,
  now = new Date().toISOString(),
): Promise<void> {
  const key = keyFor(eventId);
  const payloadHash = await developmentCallbackPayloadHash(payload);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<StoredCallback>(key);
    if (!current || current.payloadHash !== payloadHash
      || JSON.stringify(current.delivery) !== JSON.stringify(delivery)
      || fence === undefined || current.fence !== fence) {
      throw new Error("development_callback_conflict");
    }
    if (current.status === "completed") return;
    if (current.status !== "accounting_pending") throw new Error("development_callback_delivery_missing");
    await transaction.put(key, { ...current, status: "completed", completedAt: now } satisfies StoredCallback);
  });
}

export async function releaseDevelopmentCallbackState(
  storage: DevelopmentCallbackStorage,
  eventId: string,
  payload: DevelopmentCallbackPayload,
  fence?: number,
): Promise<void> {
  const key = keyFor(eventId);
  const payloadHash = await developmentCallbackPayloadHash(payload);
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<StoredCallback>(key);
    if (current?.status === "delivery_pending" && current.payloadHash === payloadHash && current.fence === fence) {
      await transaction.put(key, { ...current, leaseUntil: new Date(0).toISOString() } satisfies StoredCallback);
    }
  });
}
