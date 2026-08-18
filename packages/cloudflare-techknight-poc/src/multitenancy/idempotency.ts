import { deny } from "./errors.js";
import { tenantPartitionKey } from "./isolation.js";

export interface IdempotencyTuple {
  protocol_id: string;
  protocol_major: string;
  tenant_id: string;
  connection_id: string;
  slack_event_id: string;
  operation_id: string;
}

export interface IdempotencyClaimInput extends Omit<IdempotencyTuple, "protocol_id" | "protocol_major"> {
  key: string;
  owner?: "brainbase" | "mana_runtime";
  scope?: "credential_lease" | "quota_decision" | "business_effect" | "usage_receipt" | "queue_execution" | "slack_delivery";
  context_hash: string;
  payload_hash: string;
  connection_revision: string;
  updated_at: string;
  /** The claim lease. Queue executions receive a bounded default when omitted. */
  lease_until?: string;
}

export interface IdempotencyClaim extends IdempotencyClaimInput {
  state: "pending" | "claimed" | "succeeded" | "failed_terminal";
  partition_key: string;
  /** Fences a worker which lost its claim to an expired-lease reclaimer. */
  claim_token: string;
  result_ref?: string;
  retained_until?: string;
}

export interface IdempotencyClaimResult {
  disposition: "claimed" | "in_progress" | "succeeded" | "failed_terminal";
  claim: IdempotencyClaim;
}

type Awaitable<T> = T | Promise<T>;

export interface IdempotencyCompleteInput {
  key: string;
  tenant_id: string;
  state: "succeeded" | "failed_terminal";
  result_ref?: string;
  updated_at: string;
  retained_until: string;
  partition_key?: string;
  claim_token?: string;
}

export interface IdempotencyRenewInput {
  key: string;
  tenant_id: string;
  claim_token: string;
  updated_at: string;
  partition_key?: string;
}

export interface IdempotencyStore {
  claim(input: IdempotencyClaimInput): Awaitable<{ created: boolean; value: IdempotencyClaim }>;
  read(key: string): Awaitable<IdempotencyClaim | undefined>;
  release(key: string, tenantId: string, partitionKey?: string, claimToken?: string): Awaitable<void>;
  complete(input: IdempotencyCompleteInput): Awaitable<IdempotencyClaim>;
  renew(input: IdempotencyRenewInput): Awaitable<IdempotencyClaim>;
}

/** Queue work must not remain in_progress forever after a Worker crash. */
export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1_000;

export function idempotencyLeaseUntil(updatedAt: string): string {
  const start = Date.parse(updatedAt);
  if (!Number.isFinite(start)) deny("idempotency", "IDEMPOTENCY_LEASE_INVALID");
  return new Date(start + IDEMPOTENCY_LEASE_MS).toISOString();
}

export function prepareIdempotencyClaimInput(input: IdempotencyClaimInput): IdempotencyClaimInput {
  const normalized = input.scope !== "queue_execution" || input.lease_until !== undefined
    ? structuredClone(input)
    : { ...structuredClone(input), lease_until: idempotencyLeaseUntil(input.updated_at) };
  assertLeaseWindow(normalized);
  return normalized;
}

function assertLeaseWindow(input: IdempotencyClaimInput): void {
  if (input.lease_until === undefined) return;
  const now = Date.parse(input.updated_at);
  const leaseUntil = Date.parse(input.lease_until);
  if (!Number.isFinite(now) || !Number.isFinite(leaseUntil) || leaseUntil <= now) {
    deny("idempotency", "IDEMPOTENCY_LEASE_INVALID");
  }
}

function newClaimToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `ict1_${base64Url(bytes)}`;
}

function claimIdentityMatches(existing: IdempotencyClaim, input: IdempotencyClaimInput): boolean {
  return [
    "tenant_id",
    "connection_id",
    "slack_event_id",
    "operation_id",
    "context_hash",
    "payload_hash",
    "owner",
    "scope",
    "connection_revision",
  ].every((field) => existing[field as keyof IdempotencyClaim] === input[field as keyof IdempotencyClaimInput]);
}

export function isIdempotencyClaimLeaseExpired(existing: IdempotencyClaim, now: string): boolean {
  if (existing.state !== "claimed") return false;
  // Claims written before lease support have no lease_until. Treat their
  // updated_at as the lease start during migration so they cannot remain
  // permanently in_progress; all new queue claims persist lease_until.
  const leaseUntil = existing.lease_until
    ? Date.parse(existing.lease_until)
    : existing.scope === "queue_execution"
      ? Date.parse(existing.updated_at) + IDEMPOTENCY_LEASE_MS
      : Number.NaN;
  const nowMs = Date.parse(now);
  return Number.isFinite(leaseUntil) && Number.isFinite(nowMs) && leaseUntil <= nowMs;
}

function assertClaimToken(existing: IdempotencyClaim, claimToken: string | undefined, key: string): void {
  // business_effect outboxes persisted only key/partition_key before fencing
  // was introduced. Keep those records compatible while requiring a token for
  // queue executions and for callers that explicitly provide one.
  if (existing.claim_token !== undefined
    && (existing.scope === "queue_execution" || claimToken !== undefined)
    && existing.claim_token !== claimToken) {
    deny("idempotency", "IDEMPOTENCY_CONFLICT", { key });
  }
}

export function shouldReclaimIdempotencyClaim(
  existing: IdempotencyClaim,
  input: IdempotencyClaimInput,
): boolean {
  const normalized = prepareIdempotencyClaimInput(input);
  return claimIdentityMatches(existing, normalized) && isIdempotencyClaimLeaseExpired(existing, normalized.updated_at);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function createIdempotencyKey(tuple: IdempotencyTuple): Promise<string> {
  const encoder = new TextEncoder();
  const frames = [
    tuple.protocol_id,
    tuple.protocol_major,
    tuple.tenant_id,
    tuple.connection_id,
    tuple.slack_event_id,
    tuple.operation_id,
  ].map((value) => {
    const body = encoder.encode(value);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, false);
    frame.set(body, 4);
    return frame;
  });
  const framed = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    framed.set(frame, offset);
    offset += frame.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", framed);
  return `ik1_${base64Url(new Uint8Array(digest))}`;
}

export class IdempotencyMemoryStore implements IdempotencyStore {
  readonly #claims = new Map<string, IdempotencyClaim>();

  claim(input: IdempotencyClaimInput): { created: boolean; value: IdempotencyClaim } {
    const normalized = prepareIdempotencyClaimInput(input);
    const existing = this.#claims.get(normalized.key);
    if (existing) {
      if (shouldReclaimIdempotencyClaim(existing, normalized)) {
        const reclaimed = this.#createStoredClaim(normalized);
        this.#claims.set(normalized.key, reclaimed);
        return { created: true, value: structuredClone(reclaimed) };
      }
      return { created: false, value: structuredClone(existing) };
    }
    const stored = this.#createStoredClaim(normalized);
    this.#claims.set(normalized.key, stored);
    return { created: true, value: structuredClone(stored) };
  }

  #createStoredClaim(input: IdempotencyClaimInput): IdempotencyClaim {
    const stored: IdempotencyClaim = {
      ...structuredClone(input),
      state: "claimed",
      claim_token: newClaimToken(),
      partition_key: tenantPartitionKey({
        tenant_id: input.tenant_id,
        resource_type: "idempotency",
        connection_id: input.connection_id,
        workspace_id: "",
        channel_id: "",
        thread_ts: "",
        resource_id: input.key,
      }),
    };
    return stored;
  }

  read(key: string): IdempotencyClaim | undefined {
    const value = this.#claims.get(key);
    return value ? structuredClone(value) : undefined;
  }

  release(key: string, tenantId: string, _partitionKey?: string, claimToken?: string): void {
    const current = this.#claims.get(key);
    if (!current) return;
    if (current.tenant_id !== tenantId) deny("idempotency", "CROSS_TENANT_CANDIDATE");
    assertClaimToken(current, claimToken, key);
    if (current.state === "claimed") this.#claims.delete(key);
  }

  complete(input: IdempotencyCompleteInput): IdempotencyClaim {
    const current = this.#claims.get(input.key);
    if (!current) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
    if (current.tenant_id !== input.tenant_id) deny("idempotency", "CROSS_TENANT_CANDIDATE");
    assertClaimToken(current, input.claim_token, input.key);
    const updatedAt = Date.parse(input.updated_at);
    const retainedUntil = Date.parse(input.retained_until);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(retainedUntil)
      || retainedUntil - updatedAt < 30 * 24 * 60 * 60 * 1_000) {
      deny("idempotency", "IDEMPOTENCY_RETENTION_INVALID");
    }
    const completed: IdempotencyClaim = {
      ...current,
      state: input.state,
      ...(input.result_ref ? { result_ref: input.result_ref } : {}),
      updated_at: input.updated_at,
      retained_until: input.retained_until,
    };
    this.#claims.set(input.key, completed);
    return structuredClone(completed);
  }

  renew(input: IdempotencyRenewInput): IdempotencyClaim {
    const current = this.#claims.get(input.key);
    if (!current) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
    if (current.tenant_id !== input.tenant_id) deny("idempotency", "CROSS_TENANT_CANDIDATE");
    if (input.partition_key !== undefined && current.partition_key !== input.partition_key) {
      deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
    }
    if (current.scope !== "queue_execution" || current.state !== "claimed") {
      deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
    }
    assertClaimToken(current, input.claim_token, input.key);
    if (isIdempotencyClaimLeaseExpired(current, input.updated_at)) {
      deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
    }
    const currentUpdatedAt = Date.parse(current.updated_at);
    const updatedAt = Date.parse(input.updated_at);
    if (!Number.isFinite(updatedAt) || (Number.isFinite(currentUpdatedAt) && updatedAt < currentUpdatedAt)) {
      deny("idempotency", "IDEMPOTENCY_LEASE_INVALID", { key: input.key });
    }
    const renewed: IdempotencyClaim = {
      ...current,
      updated_at: input.updated_at,
      lease_until: idempotencyLeaseUntil(input.updated_at),
    };
    this.#claims.set(input.key, renewed);
    return structuredClone(renewed);
  }
}

export async function claimIdempotency(
  store: IdempotencyStore,
  claim: IdempotencyClaimInput,
): Promise<IdempotencyClaimResult> {
  const normalized = prepareIdempotencyClaimInput(claim);
  const result = await store.claim(normalized);
  if (result.created) return { disposition: "claimed", claim: result.value };
  const existing = result.value;
  if (existing.connection_revision !== normalized.connection_revision) {
    deny("idempotency", "WORKSPACE_CONNECTION_STALE_REVISION", { key: normalized.key });
  }
  const invariantFields: (keyof IdempotencyClaimInput)[] = [
    "tenant_id",
    "connection_id",
    "slack_event_id",
    "operation_id",
    "context_hash",
    "payload_hash",
    "owner",
    "scope",
  ];
  if (invariantFields.some((field) => existing[field] !== normalized[field])) {
    deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: normalized.key });
  }
  return {
    disposition: existing.state === "succeeded" || existing.state === "failed_terminal"
      ? existing.state
      : "in_progress",
    claim: existing,
  };
}

export function releaseIdempotency(
  store: IdempotencyStore,
  key: string,
  tenantId: string,
  partitionKey?: string,
  claimToken?: string,
): Awaitable<void> {
  return store.release(key, tenantId, partitionKey, claimToken);
}

export function completeIdempotency(
  store: IdempotencyStore,
  input: IdempotencyCompleteInput,
): Awaitable<IdempotencyClaim> {
  return store.complete(input);
}

export function renewIdempotency(
  store: IdempotencyStore,
  input: IdempotencyRenewInput,
): Awaitable<IdempotencyClaim> {
  return store.renew(input);
}
