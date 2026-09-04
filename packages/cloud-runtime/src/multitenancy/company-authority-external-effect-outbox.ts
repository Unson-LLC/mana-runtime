import type { AcceptedCompanyAuthorityContext } from "./company-authority-runtime-adapter.js";
import { TenantBoundaryError } from "./errors.js";
import { jcsCanonicalize } from "./jcs.js";

export type ExternalEffectState =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed_terminal"
  | "unknown_requires_reconcile";

export interface ExternalEffectOutboxRecord {
  readonly tenant_id: string;
  readonly effect_id: string;
  readonly provider_key: string;
  readonly payload_hash: string;
  readonly state: ExternalEffectState;
  readonly claim_token?: string;
  /** Observation deadline only; expiry never authorizes an automatic provider resend. */
  readonly claim_expires_at?: number;
  readonly result_ref?: string;
  readonly failure_code?: string;
}

export interface ExternalEffectOutboxStore {
  begin(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    created: boolean;
  }>;
  claim(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    claimed: boolean;
  }>;
  write(record: ExternalEffectOutboxRecord): Promise<void>;
  read(tenantId: string, effectId: string): Promise<ExternalEffectOutboxRecord | null>;
}

export class ExternalEffectOutboxMemoryStore implements ExternalEffectOutboxStore {
  readonly #records = new Map<string, ExternalEffectOutboxRecord>();

  #key(tenantId: string, effectId: string): string {
    return JSON.stringify([tenantId, effectId]);
  }

  async begin(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    created: boolean;
  }> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (existing) {
      assertSameEffect(existing, record);
      return { record: structuredClone(existing), created: false };
    }
    this.#records.set(key, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  async write(record: ExternalEffectOutboxRecord): Promise<void> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (!existing) throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
    assertSameEffect(existing, record);
    assertClaimTokenOwner(existing, record);
    assertValidTransition(existing, record);
    this.#records.set(key, structuredClone(record));
  }

  async claim(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    claimed: boolean;
  }> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (!existing) throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
    assertSameEffect(existing, record);
    if (existing.state !== "pending") {
      return { record: structuredClone(existing), claimed: false };
    }
    assertValidClaim(record);
    assertValidTransition(existing, record);
    this.#records.set(key, structuredClone(record));
    return { record: structuredClone(record), claimed: true };
  }

  async read(tenantId: string, effectId: string): Promise<ExternalEffectOutboxRecord | null> {
    const record = this.#records.get(this.#key(tenantId, effectId));
    return record ? structuredClone(record) : null;
  }
}

export function assertClaimTokenOwner(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  if ((existing.state === "in_flight" || existing.state === "unknown_requires_reconcile")
    && existing.claim_token !== candidate.claim_token) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_CONFLICT");
  }
}

export function assertValidClaim(record: ExternalEffectOutboxRecord): void {
  if (record.state !== "in_flight"
    || typeof record.claim_token !== "string" || record.claim_token.length === 0
    || typeof record.claim_expires_at !== "number" || !Number.isFinite(record.claim_expires_at)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_INVALID");
  }
}

export function assertValidTransition(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  const allowed = existing.state === "pending"
    ? new Set<ExternalEffectState>(["pending", "in_flight"])
    : existing.state === "in_flight"
      ? new Set<ExternalEffectState>(["in_flight", "succeeded", "failed_terminal", "unknown_requires_reconcile"])
      : existing.state === "unknown_requires_reconcile"
        ? new Set<ExternalEffectState>(["unknown_requires_reconcile", "succeeded"])
        : new Set<ExternalEffectState>([existing.state]);
  if (!allowed.has(candidate.state)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
      current_state: existing.state,
      requested_state: candidate.state,
    });
  }
  if (existing.state === candidate.state
    && (existing.result_ref !== candidate.result_ref || existing.failure_code !== candidate.failure_code)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
    });
  }
}

export function assertSameEffect(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  if (existing.provider_key !== candidate.provider_key
    || existing.payload_hash !== candidate.payload_hash
    || existing.tenant_id !== candidate.tenant_id) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
    });
  }
}

export type ExternalEffectProviderResult =
  | {
    readonly applied: true;
    readonly response_observed: true;
    readonly result_ref: string;
  }
  | {
    readonly applied: true;
    readonly response_observed: false;
  }
  | {
    readonly applied: false;
    readonly response_observed: true;
    readonly failure_code: string;
  };

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function effectIdentity(context: AcceptedCompanyAuthorityContext): { effect_id: string; tenant_id: string } {
  const tenantContext = context.tenant_context as {
    idempotency_key?: unknown;
    tenant?: { tenant_id?: unknown };
  };
  if (typeof tenantContext.idempotency_key !== "string" || tenantContext.idempotency_key.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  if (typeof tenantContext.tenant?.tenant_id !== "string" || tenantContext.tenant.tenant_id.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  return { effect_id: tenantContext.idempotency_key, tenant_id: tenantContext.tenant.tenant_id };
}

/**
 * Persists an external effect before calling its provider. Once a provider call
 * starts, an exception or an unobserved response is ambiguous and must be
 * reconciled by provider_key; it is never converted into a blind Queue retry,
 * even after the claim observation deadline has elapsed.
 */
export async function processCompanyAuthorityExternalEffect<T>(input: {
  readonly context: AcceptedCompanyAuthorityContext;
  readonly payload: T;
  readonly outbox: ExternalEffectOutboxStore;
  provider_send(input: {
    readonly provider_key: string;
    readonly payload: T;
  }): Promise<ExternalEffectProviderResult>;
  readonly claim_lease_ms?: number;
  readonly now?: () => number;
  readonly create_claim_token?: () => string;
}): Promise<ExternalEffectOutboxRecord> {
  const { effect_id, tenant_id } = effectIdentity(input.context);
  const payload_hash = await sha256(input.payload);
  const provider_key = await sha256({ tenant_id, effect_id, payload_hash });
  const pending: ExternalEffectOutboxRecord = {
    tenant_id,
    effect_id,
    provider_key,
    payload_hash,
    state: "pending",
  };
  await input.outbox.begin(pending);
  const now = input.now ?? Date.now;
  const claimLeaseMs = input.claim_lease_ms ?? 60_000;
  if (!Number.isFinite(claimLeaseMs) || claimLeaseMs <= 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_INVALID");
  }
  const inFlight: ExternalEffectOutboxRecord = {
    ...pending,
    state: "in_flight",
    claim_token: (input.create_claim_token ?? (() => crypto.randomUUID()))(),
    claim_expires_at: now() + claimLeaseMs,
  };
  let claimed: Awaited<ReturnType<ExternalEffectOutboxStore["claim"]>>;
  try {
    claimed = await input.outbox.claim(inFlight);
  } catch (claimError) {
    const observed = await input.outbox.read(tenant_id, effect_id).catch(() => null);
    if (observed?.state === "in_flight" && observed.claim_token === inFlight.claim_token) {
      claimed = { record: observed, claimed: true };
    } else {
      throw claimError;
    }
  }
  if (!claimed.claimed) {
    if (claimed.record.state === "in_flight") {
      throw new TenantBoundaryError("external_effect", "UPSTREAM_UNAVAILABLE", undefined, {
        effect_id,
        reason: "external_effect_claim_active",
      });
    }
    return claimed.record;
  }

  let result: ExternalEffectProviderResult;
  try {
    result = await input.provider_send({
      provider_key,
      payload: structuredClone(input.payload),
    });
  } catch {
    const unknown = { ...inFlight, state: "unknown_requires_reconcile" as const };
    try {
      await input.outbox.write(unknown);
    } catch {
      return inFlight;
    }
    return unknown;
  }

  const completed: ExternalEffectOutboxRecord = result.applied
    ? result.response_observed
      ? { ...inFlight, state: "succeeded", result_ref: result.result_ref }
      : { ...inFlight, state: "unknown_requires_reconcile" }
    : { ...inFlight, state: "failed_terminal", failure_code: result.failure_code };
  try {
    await input.outbox.write(completed);
    return completed;
  } catch {
    // The provider has already been invoked. Preserve the durable in_flight
    // marker and ACK this delivery; a reconciler must resolve it by provider_key.
    return inFlight;
  }
}

export async function reconcileCompanyAuthorityExternalEffect(input: {
  readonly tenant_id: string;
  readonly effect_id: string;
  readonly outbox: ExternalEffectOutboxStore;
  provider_reconcile(input: {
    readonly provider_key: string;
  }): Promise<{ readonly state: "succeeded"; readonly result_ref: string } | { readonly state: "unknown" }>;
}): Promise<ExternalEffectOutboxRecord | null> {
  const current = await input.outbox.read(input.tenant_id, input.effect_id);
  if (!current
    || (current.state !== "unknown_requires_reconcile" && current.state !== "in_flight")) return current;
  let reconciliation: { readonly state: "succeeded"; readonly result_ref: string } | { readonly state: "unknown" };
  try {
    reconciliation = await input.provider_reconcile({ provider_key: current.provider_key });
  } catch {
    return current;
  }
  if (reconciliation.state === "unknown") return current;
  const succeeded: ExternalEffectOutboxRecord = {
    ...current,
    state: "succeeded",
    result_ref: reconciliation.result_ref,
  };
  try {
    await input.outbox.write(succeeded);
    return succeeded;
  } catch {
    return current;
  }
}
