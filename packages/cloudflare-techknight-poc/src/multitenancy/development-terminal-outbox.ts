import type { DevelopmentJobOwner } from "./development-job-owner.js";
import { TenantBoundaryError } from "./errors.js";

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
}

export interface DevelopmentTerminalOutboxRecord extends DevelopmentTerminalOutboxSubmission {
  state: "pending" | "completed";
  attempts: number;
  updated_at: string;
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
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class DevelopmentTerminalOutboxHandler {
  constructor(
    private readonly storage: DevelopmentTerminalOutboxStorage,
    private readonly scheduler: DevelopmentTerminalAlarmScheduler,
  ) {}

  async submit(input: DevelopmentTerminalOutboxSubmission): Promise<DevelopmentTerminalOutboxRecord> {
    validateSubmission(input);
    const record = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (current) {
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
      const completed = { ...current, state: "completed" as const, updated_at: now };
      await transaction.put(RECORD_KEY, completed);
      return clone(completed);
    });
  }

  async alarm(now: string,
    deliver: (record: DevelopmentTerminalOutboxRecord) => Promise<DevelopmentTerminalDeliveryResult>): Promise<void> {
    const current = await this.read();
    if (!current || current.state === "completed") return;
    const result = await deliver(current).catch(() => ({ state: "retry" as const, error: "UPSTREAM_UNAVAILABLE" }));
    if (result.state === "completed") {
      await this.complete(now);
      return;
    }
    const next = await this.storage.transaction(async (transaction) => {
      const stored = await transaction.get<DevelopmentTerminalOutboxRecord>(RECORD_KEY);
      if (!stored || stored.state === "completed") return undefined;
      const updated = { ...stored, attempts: stored.attempts + 1, updated_at: now };
      await transaction.put(RECORD_KEY, updated);
      return updated;
    });
    if (!next) return;
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
      if (url.pathname === "/read") return Response.json({ result: await this.read() ?? null });
      if (url.pathname === "/complete") {
        const input = await request.json() as { now?: unknown };
        if (typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) {
          throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
        }
        return Response.json({ result: await this.complete(input.now) });
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
    submit: (input: DevelopmentTerminalOutboxSubmission) =>
      call<DevelopmentTerminalOutboxRecord>(stub, "submit", input),
    read: () => call<DevelopmentTerminalOutboxRecord | null>(stub, "read", {}).then((value) => value ?? undefined),
    complete: (now: string) => call<DevelopmentTerminalOutboxRecord>(stub, "complete", { now }),
  };
}
