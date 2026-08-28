import {
  AUTONOMY_RUN_HISTORY_HOST,
  handleAutonomyRunHistoryRequest,
} from "./autonomy-run-history.js";

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface TaskWriteBudgetNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface AutonomyExperimentGuard {
  id: string;
  actorId: string;
  project: string;
  startsAt: number;
  expiresAt: number;
  maxWrites: number;
  disabled: boolean;
}

export interface TaskWriteBudgetClaim {
  requestId: string;
  nonce: string;
  placementId: string;
  actorId: string;
  project: string;
  operation: string;
  callIndex: number;
  budget: number;
  expiresAt: number;
  fingerprint: string;
  experiment?: AutonomyExperimentGuard;
}

export interface TaskWriteReceipt {
  fingerprint: string;
  requestId: string;
  actorId: string;
  project: string;
  operation: string;
  state: "claimed" | "completed";
  claimedAt: number;
  completedAt?: number;
  resultRef?: string;
}

interface StorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
  transaction<T>(closure: (transaction: Pick<StorageLike, "get" | "put">) => Promise<T>): Promise<T>;
}

interface DurableObjectStateLike {
  storage: StorageLike;
}

function validText(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validExperiment(value: unknown, claim: Record<string, unknown>): value is AutonomyExperimentGuard {
  if (value === undefined) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const experiment = value as Record<string, unknown>;
  return validText(experiment.id)
    && validText(experiment.actorId)
    && validText(experiment.project)
    && experiment.actorId === claim.actorId
    && experiment.project === claim.project
    && Number.isFinite(experiment.startsAt)
    && Number.isFinite(experiment.expiresAt)
    && Number(experiment.expiresAt) > Number(experiment.startsAt)
    && Number(experiment.expiresAt) - Number(experiment.startsAt) <= 24 * 60 * 60 * 1000
    && Number.isInteger(experiment.maxWrites)
    && Number(experiment.maxWrites) >= 1
    && Number(experiment.maxWrites) <= 100
    && typeof experiment.disabled === "boolean";
}

function validClaim(value: unknown): value is TaskWriteBudgetClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return validText(claim.requestId)
    && validText(claim.nonce)
    && validText(claim.placementId)
    && validText(claim.actorId)
    && validText(claim.project)
    && validText(claim.operation)
    && Number.isInteger(claim.callIndex) && Number(claim.callIndex) >= 1
    && Number.isInteger(claim.budget) && Number(claim.budget) >= 1 && Number(claim.budget) <= 3
    && Number(claim.callIndex) <= Number(claim.budget)
    && Number.isFinite(claim.expiresAt) && Number(claim.expiresAt) > Date.now()
    && typeof claim.fingerprint === "string" && /^[a-f0-9]{64}$/.test(claim.fingerprint)
    && (claim.experiment === undefined || validExperiment(claim.experiment, claim));
}

function namespaceKey(claim: TaskWriteBudgetClaim): string {
  return claim.experiment ? `autonomy:${claim.placementId}:${claim.experiment.id}`
    : `${claim.placementId}:${claim.requestId}:${claim.nonce}`;
}

function stub(namespace: TaskWriteBudgetNamespace, key: string): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(key));
}

export async function claimTaskWriteBudgetSlot(
  namespace: TaskWriteBudgetNamespace,
  claim: TaskWriteBudgetClaim,
): Promise<"claimed" | "replay"> {
  const response = await stub(namespace, namespaceKey(claim)).fetch(new Request("https://task-write-budget.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  }));
  if (response.status === 200) {
    const payload = await response.json().catch(() => null) as { disposition?: unknown } | null;
    if (payload?.disposition === "replay") return "replay";
  }
  if (response.ok) return "claimed";
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof payload?.error === "string" ? payload.error : "task_write_budget_exceeded";
  throw new Error(code);
}

export async function completeTaskWriteReceipt(
  namespace: TaskWriteBudgetNamespace,
  claim: TaskWriteBudgetClaim,
  resultRef?: string,
): Promise<void> {
  const response = await stub(namespace, namespaceKey(claim)).fetch(new Request("https://task-write-budget.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprint: claim.fingerprint, resultRef }),
  }));
  if (!response.ok) throw new Error("task_write_receipt_complete_failed");
}

export async function readTaskWriteReceipt(
  namespace: TaskWriteBudgetNamespace,
  claim: TaskWriteBudgetClaim,
): Promise<TaskWriteReceipt | null> {
  const response = await stub(namespace, namespaceKey(claim)).fetch(new Request(
    `https://task-write-budget.internal/receipt?fingerprint=${claim.fingerprint}`,
  ));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("task_write_receipt_read_failed");
  return response.json() as Promise<TaskWriteReceipt>;
}

export class TaskWriteBudget {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === AUTONOMY_RUN_HISTORY_HOST) {
      return handleAutonomyRunHistoryRequest(this.state, request);
    }
    if (url.hostname !== "task-write-budget.internal") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && url.pathname === "/receipt") {
      const fingerprint = url.searchParams.get("fingerprint") ?? "";
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return Response.json({ error: "invalid_fingerprint" }, { status: 400 });
      const receipt = await this.state.storage.get(`receipt:${fingerprint}`) as TaskWriteReceipt | undefined;
      return receipt ? Response.json(receipt) : Response.json({ error: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await request.json().catch(() => null) as { fingerprint?: unknown; resultRef?: unknown } | null;
      if (!body || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)
        || (body.resultRef !== undefined && !validText(body.resultRef, 500))) {
        return Response.json({ error: "task_write_receipt_invalid" }, { status: 400 });
      }
      const receipt = await this.state.storage.get(`receipt:${body.fingerprint}`) as TaskWriteReceipt | undefined;
      if (!receipt) return Response.json({ error: "task_write_receipt_missing" }, { status: 404 });
      if (receipt.state === "completed") return new Response(null, { status: 204 });
      await this.state.storage.put(`receipt:${body.fingerprint}`, {
        ...receipt,
        state: "completed",
        completedAt: Date.now(),
        ...(body.resultRef ? { resultRef: body.resultRef } : {}),
      } satisfies TaskWriteReceipt);
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST" || url.pathname !== "/claim") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const claim = await request.json().catch(() => null);
    if (!validClaim(claim)) return Response.json({ error: "task_write_budget_invalid" }, { status: 400 });

    const now = Date.now();
    if (claim.experiment) {
      if (claim.experiment.disabled) return Response.json({ error: "autonomy_kill_switch_active" }, { status: 503 });
      if (now < claim.experiment.startsAt) return Response.json({ error: "autonomy_experiment_not_started" }, { status: 403 });
      if (now >= claim.experiment.expiresAt) return Response.json({ error: "autonomy_experiment_expired" }, { status: 403 });
      if (claim.expiresAt > claim.experiment.expiresAt) return Response.json({ error: "autonomy_capability_outlives_experiment" }, { status: 403 });
    }

    const outcome = await this.state.storage.transaction(async (storage) => {
      const requestPrefix = `request:${claim.requestId}:${claim.nonce}`;
      const slotKey = `${requestPrefix}:slot:${claim.callIndex}`;
      const existing = await storage.get(slotKey);
      if (existing === claim.fingerprint) return "replay";
      if (typeof existing === "string") return "reused";
      const storedCount = await storage.get(`${requestPrefix}:count`);
      const count = typeof storedCount === "number" ? storedCount : 0;
      if (count >= claim.budget) return "exceeded";
      if (claim.experiment) {
        const experimentCount = await storage.get("experiment:write-count");
        const total = typeof experimentCount === "number" ? experimentCount : 0;
        if (total >= claim.experiment.maxWrites) return "experiment_exceeded";
        await storage.put("experiment:write-count", total + 1);
      }
      await storage.put(slotKey, claim.fingerprint);
      await storage.put(`${requestPrefix}:count`, count + 1);
      await storage.put(`receipt:${claim.fingerprint}`, {
        fingerprint: claim.fingerprint,
        requestId: claim.requestId,
        actorId: claim.actorId,
        project: claim.project,
        operation: claim.operation,
        state: "claimed",
        claimedAt: now,
      } satisfies TaskWriteReceipt);
      return "claimed";
    });
    if (outcome === "replay") return Response.json({ disposition: "replay" });
    if (outcome === "reused") return Response.json({ error: "task_write_budget_slot_reused" }, { status: 409 });
    if (outcome === "exceeded") return Response.json({ error: "task_write_budget_exceeded" }, { status: 429 });
    if (outcome === "experiment_exceeded") return Response.json({ error: "autonomy_write_budget_exceeded" }, { status: 429 });
    const cleanupAt = Math.max(claim.expiresAt, claim.experiment?.expiresAt ?? 0) + 60_000;
    await this.state.storage.setAlarm(cleanupAt);
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
