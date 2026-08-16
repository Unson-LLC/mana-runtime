import { jcsCanonicalize } from "./envelope.js";
import { deny } from "./errors.js";

export interface IdempotencyTuple {
  protocol_id: string;
  protocol_major: string;
  tenant_id: string;
  connection_id: string;
  slack_event_id: string;
  operation_id: string;
}

export interface IdempotencyClaim extends Omit<IdempotencyTuple, "protocol_id" | "protocol_major"> {
  key: string;
  context_hash: string;
  payload_hash: string;
  connection_revision: string;
  updated_at: string;
}

export interface IdempotencyClaimResult {
  disposition: "claimed" | "in_progress";
  claim: IdempotencyClaim;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function createIdempotencyKey(tuple: IdempotencyTuple): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jcsCanonicalize(tuple)));
  return `ik1_${base64Url(new Uint8Array(digest))}`;
}

export class IdempotencyMemoryStore {
  readonly #claims = new Map<string, IdempotencyClaim>();

  claim(input: IdempotencyClaim): { created: boolean; value: IdempotencyClaim } {
    const existing = this.#claims.get(input.key);
    if (existing) return { created: false, value: structuredClone(existing) };
    const stored = structuredClone(input);
    this.#claims.set(input.key, stored);
    return { created: true, value: structuredClone(stored) };
  }
}

export async function claimIdempotency(
  store: IdempotencyMemoryStore,
  claim: IdempotencyClaim,
): Promise<IdempotencyClaimResult> {
  const result = store.claim(claim);
  if (result.created) return { disposition: "claimed", claim: result.value };
  const existing = result.value;
  const invariantFields: (keyof IdempotencyClaim)[] = [
    "tenant_id",
    "connection_id",
    "slack_event_id",
    "operation_id",
    "context_hash",
    "payload_hash",
    "connection_revision",
  ];
  if (invariantFields.some((field) => existing[field] !== claim[field])) {
    deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: claim.key });
  }
  return { disposition: "in_progress", claim: existing };
}
