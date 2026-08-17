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
}

export interface IdempotencyClaim extends IdempotencyClaimInput {
  state: "pending" | "claimed" | "succeeded" | "failed_terminal";
  partition_key: string;
  lease_until?: string;
  result_ref?: string;
  retained_until?: string;
}

export interface IdempotencyClaimResult {
  disposition: "claimed" | "in_progress" | "succeeded" | "failed_terminal";
  claim: IdempotencyClaim;
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

export class IdempotencyMemoryStore {
  readonly #claims = new Map<string, IdempotencyClaim>();

  claim(input: IdempotencyClaimInput): { created: boolean; value: IdempotencyClaim } {
    const existing = this.#claims.get(input.key);
    if (existing) return { created: false, value: structuredClone(existing) };
    const stored: IdempotencyClaim = {
      ...structuredClone(input),
      state: "claimed",
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
    this.#claims.set(input.key, stored);
    return { created: true, value: structuredClone(stored) };
  }

  read(key: string): IdempotencyClaim | undefined {
    const value = this.#claims.get(key);
    return value ? structuredClone(value) : undefined;
  }

  release(key: string, tenantId: string): void {
    const current = this.#claims.get(key);
    if (!current) return;
    if (current.tenant_id !== tenantId) deny("idempotency", "CROSS_TENANT_CANDIDATE");
    if (current.state === "claimed") this.#claims.delete(key);
  }

  complete(input: {
    key: string;
    tenant_id: string;
    state: "succeeded" | "failed_terminal";
    result_ref?: string;
    updated_at: string;
    retained_until: string;
  }): IdempotencyClaim {
    const current = this.#claims.get(input.key);
    if (!current) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
    if (current.tenant_id !== input.tenant_id) deny("idempotency", "CROSS_TENANT_CANDIDATE");
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
}

export async function claimIdempotency(
  store: IdempotencyMemoryStore,
  claim: IdempotencyClaimInput,
): Promise<IdempotencyClaimResult> {
  const result = store.claim(claim);
  if (result.created) return { disposition: "claimed", claim: result.value };
  const existing = result.value;
  if (existing.connection_revision !== claim.connection_revision) {
    deny("idempotency", "WORKSPACE_CONNECTION_STALE_REVISION", { key: claim.key });
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
  if (invariantFields.some((field) => existing[field] !== claim[field])) {
    deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: claim.key });
  }
  return {
    disposition: existing.state === "succeeded" || existing.state === "failed_terminal"
      ? existing.state
      : "in_progress",
    claim: existing,
  };
}

export function releaseIdempotency(store: IdempotencyMemoryStore, key: string, tenantId: string): void {
  store.release(key, tenantId);
}

export function completeIdempotency(
  store: IdempotencyMemoryStore,
  input: Parameters<IdempotencyMemoryStore["complete"]>[0],
): IdempotencyClaim {
  return store.complete(input);
}
