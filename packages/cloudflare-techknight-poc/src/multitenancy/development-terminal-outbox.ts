import type { DevelopmentJobOwner } from "./development-job-owner.js";
import type {
  ExpectedTenantScope,
  OperationOutcome,
  QuotaDecision,
  TenantContextEnvelope,
} from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

const HOST = "development-terminal-outbox.internal";
const RECORD_KEY = "development-terminal-outbox-v1";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface DevelopmentTerminalOutboxSubmission {
  job_id: string;
  payload_hash: string;
  callback_body: string;
  tenant_boundary_handle: string;
  owner: DevelopmentJobOwner;
  owner_claim: { key: string; partition_key: string };
  terminal_deadline_at: string;
  observed_at: string;
  terminal_accounting?: DevelopmentTerminalAccountingPlan;
}

export interface DevelopmentTerminalAccountingPlan {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  quota_decision: QuotaDecision["decision"];
  unit: string;
  outcome: OperationOutcome;
  failure_code: string | null;
  reply_state: "not_attempted" | "delivered" | "failed" | "unknown";
  recorded_at: string;
  accounting_effect_id: string;
}

export interface DevelopmentTerminalOutboxArm extends DevelopmentTerminalOutboxSubmission {
  activate_at: string;
  container_id: string;
}

export interface DevelopmentTerminalOutboxRecord extends DevelopmentTerminalOutboxSubmission {
  state: "awaiting_terminal" | "pending" | "completed" | "failed_terminal";
  attempts: number;
  updated_at: string;
  activate_at?: string;
  failure_code?: string;
  failed_at?: string;
  collection_state?: "not_collected";
  terminal_outcome?: "timed_out";
  owner_finalized?: boolean;
  container_id?: string;
  container_destroyed_at?: string;
}

export interface DevelopmentTerminalOutboxTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface DevelopmentTerminalOutboxStorage extends DevelopmentTerminalOutboxTransaction {
  transaction<T>(callback: (transaction: DevelopmentTerminalOutboxTransaction) => Promise<T>): Promise<T>;
}

export interface DevelopmentTerminalAlarmScheduler {
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

export interface DevelopmentTerminalOutboxNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export type DevelopmentTerminalDeliveryResult =
  | { state: "completed" }
  | { state: "retry"; error: string };

function validateSubmission(input: DevelopmentTerminalOutboxSubmission): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.job_id)
    || !HASH_PATTERN.test(input.payload_hash)
    || typeof input.callback_body !== "string" || input.callback_body.length === 0
    || !/^tb_[A-Za-z0-9_-]{32,128}$/.test(input.tenant_boundary_handle)
    || !input.owner || input.owner.jobId !== input.job_id
    || !input.owner_claim?.key || !input.owner_claim.partition_key
    || !Number.isFinite(Date.parse(input.observed_at))
    || !Number.isFinite(Date.parse(input.terminal_deadline_at))
    || Date.parse(input.terminal_deadline_at) <= Date.parse(input.observed_at)) {
    throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
  }
  if (input.terminal_accounting) {
    const accounting = assertSecretArtifactFree(input.terminal_accounting);
    if (accounting.tenant_context.tenant.tenant_id !== input.owner.tenantId
      || accounting.tenant_context.workspace_connection.connection_id !== input.owner.connectionId
      || accounting.tenant_context.operation_id !== input.owner.operationId
      || accounting.tenant_context.workspace_connection.workspace_id !== input.owner.workspaceId
      || accounting.tenant_context.slack.channel_id !== input.owner.channelId
      || (accounting.tenant_context.slack.thread_ts ?? "") !== input.owner.threadTs
      || !accounting.unit.trim()
      || (accounting.outcome === "succeeded"
        ? accounting.failure_code !== null
        : !accounting.failure_code?.trim())
      || !accounting.accounting_effect_id.trim()
      || !Number.isFinite(Date.parse(accounting.recorded_at))) {
      throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
    }
  }
}

function sameOwner(current: DevelopmentTerminalOutboxRecord, input: DevelopmentTerminalOutboxSubmission): boolean {
  return current.job_id === input.job_id
    && current.owner.tenantId === input.owner.tenantId
    && current.owner_claim.key === input.owner_claim.key
    && current.owner_claim.partition_key === input.owner_claim.partition_key;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class DevelopmentTerminalOutboxHandler {
  constructor(
    private readonly storage: DevelopmentTerminalOutboxStorage,
    private readonly scheduler: DevelopmentTerminalAlarmScheduler,
  ) {}

  async arm(input: DevelopmentTerminalOutboxArm): Promise<DevelopmentTerminalOutboxRecord> {
    validateSubmission(input);
    const activateAt = Date.parse(input.activate_at);
    if (!Number.isFinite(activateAt)
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.container_id)
      || activateAt <= Date.parse(input.observed_at)
      || activateAt >= Date.parse(input.terminal_deadline_at)) {
      throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
    }
    const record = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (current) {
        if (!sameOwner(current, input)) {
          throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
        }
        if (current.state !== "awaiting_terminal") return current;
        if (current.payload_hash !== input.payload_hash
          || current.callback_body !== input.callback_body
          || current.container_id !== input.container_id) {
          throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
        }
        return current;
      }
      const created: DevelopmentTerminalOutboxRecord = {
        ...clone(input),
        state: "awaiting_terminal",
        attempts: 0,
        updated_at: input.observed_at,
      };
      await transaction.put(RECORD_KEY, created);
      return created;
    });
    if (record.state === "awaiting_terminal") await this.scheduler.setAlarm(activateAt);
    return clone(record);
  }

  async submit(input: DevelopmentTerminalOutboxSubmission): Promise<DevelopmentTerminalOutboxRecord> {
    validateSubmission(input);
    const record = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (current) {
        if (current.state === "awaiting_terminal") {
          if (!sameOwner(current, input)) {
            throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
          }
          const replacement: DevelopmentTerminalOutboxRecord = {
            ...clone(input),
            ...(input.terminal_accounting
              ? { terminal_accounting: clone(input.terminal_accounting) }
              : current.terminal_accounting ? { terminal_accounting: clone(current.terminal_accounting) } : {}),
            container_id: current.container_id,
            state: "pending",
            attempts: 0,
            updated_at: input.observed_at,
          };
          await transaction.put(RECORD_KEY, replacement);
          return replacement;
        }
        if (current.job_id !== input.job_id || current.payload_hash !== input.payload_hash
          || current.callback_body !== input.callback_body) {
          throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
        }
        return current;
      }
      const created: DevelopmentTerminalOutboxRecord = {
        ...clone(input),
        state: "pending",
        attempts: 0,
        updated_at: input.observed_at,
      };
      await transaction.put(RECORD_KEY, created);
      return created;
    });
    if (record.state === "pending") await this.scheduler.setAlarm(Date.parse(record.observed_at));
    return clone(record);
  }

  async read(): Promise<DevelopmentTerminalOutboxRecord | undefined> {
    const record = await this.storage.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
    return record ? clone(record) : undefined;
  }

  async complete(now: string): Promise<DevelopmentTerminalOutboxRecord> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (!current) throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CLAIM_MISSING");
      if (current.state === "completed") return clone(current);
      if (current.state === "failed_terminal") {
        throw new TenantBoundaryError("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
      }
      const completed = { ...current, state: "completed" as const, updated_at: now };
      await transaction.put(RECORD_KEY, completed);
      return clone(completed);
    });
  }

  async recordContainerDestroyed(now: string): Promise<DevelopmentTerminalOutboxRecord> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (!current) throw new TenantBoundaryError("container_launch", "IDEMPOTENCY_CLAIM_MISSING");
      if (!current.container_id) {
        throw new TenantBoundaryError("container_launch", "CONTAINER_SANITIZATION_UNPROVEN");
      }
      if (current.container_destroyed_at) return clone(current);
      const destroyed = { ...current, container_destroyed_at: now, updated_at: now };
      await transaction.put(RECORD_KEY, destroyed);
      return clone(destroyed);
    });
  }

  async cancel(jobId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (current?.job_id === jobId && current.state === "awaiting_terminal") {
        await transaction.delete(RECORD_KEY);
      }
    });
  }

  private async finalizeFailure(
    current: DevelopmentTerminalOutboxRecord,
    now: string,
    finalize: (record: DevelopmentTerminalOutboxRecord) => Promise<void>,
  ): Promise<void> {
    try {
      await finalize(current);
      await this.storage.transaction(async (transaction) => {
        const stored = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
        if (stored?.state === "failed_terminal") {
          await transaction.put(RECORD_KEY, { ...stored, owner_finalized: true, updated_at: now });
        }
      });
    } catch (error) {
      // Keep the exact terminal artifact and owner claim pending. An explicit
      // alarm makes recovery independent of the platform's unhandled-alarm
      // retry policy and survives a fresh isolate.
      await this.scheduler.setAlarm(Date.parse(now) + 2_000);
      throw error;
    }
  }

  async alarm(now: string,
    deliver: (record: DevelopmentTerminalOutboxRecord) => Promise<DevelopmentTerminalDeliveryResult>,
    finalizeFailure: (record: DevelopmentTerminalOutboxRecord) => Promise<void> = async () => undefined,
  ): Promise<void> {
    let current = await this.read();
    if (!current || current.state === "completed") return;
    if (current.state === "failed_terminal") {
      if (!current.owner_finalized) {
        await this.finalizeFailure(current, now, finalizeFailure);
      }
      return;
    }
    if (current.state === "awaiting_terminal") {
      if (Date.parse(now) < Date.parse(current.activate_at ?? "")) {
        await this.scheduler.setAlarm(Date.parse(current.activate_at ?? ""));
        return;
      }
      current = await this.storage.transaction(async (transaction) => {
        const stored = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
        if (!stored || stored.state !== "awaiting_terminal") return stored ?? current;
        const activated = { ...stored, state: "pending" as const, updated_at: now };
        await transaction.put(RECORD_KEY, activated);
        return activated;
      });
    }
    if (!current) return;
    const result = await deliver(current).catch(() => ({ state: "retry" as const, error: "UPSTREAM_UNAVAILABLE" }));
    if (result.state === "completed") {
      await this.complete(now);
      return;
    }
    const next = await this.storage.transaction(async (transaction) => {
      const stored = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (!stored || stored.state === "completed" || stored.state === "failed_terminal") return undefined;
      const deadlineReached = Date.parse(now) >= Date.parse(stored.terminal_deadline_at);
      const updated: DevelopmentTerminalOutboxRecord = deadlineReached
        ? { ...stored, state: "failed_terminal", attempts: stored.attempts + 1, updated_at: now,
            failure_code: result.error, failed_at: now, collection_state: "not_collected",
            terminal_outcome: "timed_out", owner_finalized: false }
        : { ...stored, attempts: stored.attempts + 1, updated_at: now };
      await transaction.put(RECORD_KEY, updated);
      return updated;
    });
    if (!next) return;
    if (next.state === "failed_terminal") {
      await this.finalizeFailure(next, now, finalizeFailure);
      return;
    }
    const retryAt = Math.min(Date.parse(now) + 2_000, Date.parse(next.terminal_deadline_at));
    await this.scheduler.setAlarm(retryAt);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== HOST || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      if (url.pathname === "/submit") {
        return Response.json({ result: await this.submit(await request.json() as DevelopmentTerminalOutboxSubmission) });
      }
      if (url.pathname === "/arm") {
        return Response.json({ result: await this.arm(await request.json() as DevelopmentTerminalOutboxArm) });
      }
      if (url.pathname === "/read") return Response.json({ result: await this.read() ?? null });
      if (url.pathname === "/cancel") {
        const input = await request.json() as { job_id?: unknown };
        if (typeof input.job_id !== "string") throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
        await this.cancel(input.job_id);
        return Response.json({ result: null });
      }
      if (url.pathname === "/complete") {
        const input = await request.json() as { now?: unknown };
        if (typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
          throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
        }
        return Response.json({ result: await this.complete(input.now) });
      }
      if (url.pathname === "/container-destroyed") {
        const input = await request.json() as { now?: unknown };
        if (typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
          throw new TenantBoundaryError("container_launch", "SCHEMA_INVALID");
        }
        return Response.json({ result: await this.recordContainerDestroyed(input.now) });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
      return Response.json({ error: code }, { status: code === "UPSTREAM_UNAVAILABLE" ? 503 : 409 });
    }
  }
}

async function call<T>(stub: { fetch(request: Request): Promise<Response> }, path: string, input: unknown): Promise<T> {
  const response = await stub.fetch(new Request(`https://${HOST}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  const body = await response.json().catch(() => null) as { result?: T; error?: string } | null;
  if (!response.ok) throw new TenantBoundaryError("brainbase_proxy", body?.error ?? "UPSTREAM_UNAVAILABLE");
  return body?.result as T;
}

export function createDevelopmentTerminalOutboxClient(
  namespace: DevelopmentTerminalOutboxNamespace,
  partitionKey: string,
) {
  const stub = namespace.get(namespace.idFromName(`development-terminal:${partitionKey}`));
  return {
    arm: (input: DevelopmentTerminalOutboxArm) =>
      call<DevelopmentTerminalOutboxRecord>(stub, "arm", input),
    submit: (input: DevelopmentTerminalOutboxSubmission) =>
      call<DevelopmentTerminalOutboxRecord>(stub, "submit", input),
    read: () => call<DevelopmentTerminalOutboxRecord | null>(stub, "read", {}).then((value) => value ?? undefined),
    complete: (now: string) => call<DevelopmentTerminalOutboxRecord>(stub, "complete", { now }),
    recordContainerDestroyed: (now: string) =>
      call<DevelopmentTerminalOutboxRecord>(stub, "container-destroyed", { now }),
    cancel: (jobId: string) => call<null>(stub, "cancel", { job_id: jobId }).then(() => undefined),
  };
}
