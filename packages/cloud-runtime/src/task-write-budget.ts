interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface TaskWriteBudgetNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

interface TaskWriteBudgetClaim {
  requestId: string;
  nonce: string;
  placementId: string;
  callIndex: number;
  budget: number;
  expiresAt: number;
  fingerprint: string;
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

function validClaim(value: unknown): value is TaskWriteBudgetClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.requestId === "string" && claim.requestId.length > 0 && claim.requestId.length <= 128
    && typeof claim.nonce === "string" && claim.nonce.length > 0 && claim.nonce.length <= 128
    && typeof claim.placementId === "string" && claim.placementId.length > 0 && claim.placementId.length <= 128
    && Number.isInteger(claim.callIndex) && Number(claim.callIndex) >= 1
    && Number.isInteger(claim.budget) && Number(claim.budget) >= 1 && Number(claim.budget) <= 3
    && Number(claim.callIndex) <= Number(claim.budget)
    && Number.isFinite(claim.expiresAt) && Number(claim.expiresAt) > Date.now()
    && typeof claim.fingerprint === "string" && /^[a-f0-9]{64}$/.test(claim.fingerprint);
}

export async function claimTaskWriteBudgetSlot(
  namespace: TaskWriteBudgetNamespace,
  claim: TaskWriteBudgetClaim,
): Promise<void> {
  const id = namespace.idFromName(`${claim.placementId}:${claim.requestId}:${claim.nonce}`);
  const response = await namespace.get(id).fetch(new Request("https://task-write-budget.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  }));
  if (response.ok) return;
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof payload?.error === "string" ? payload.error : "task_write_budget_exceeded";
  throw new Error(code);
}

export class TaskWriteBudget {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.hostname !== "task-write-budget.internal" || url.pathname !== "/claim") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const claim = await request.json().catch(() => null);
    if (!validClaim(claim)) return Response.json({ error: "task_write_budget_invalid" }, { status: 400 });

    const outcome = await this.state.storage.transaction(async (storage) => {
      const slotKey = `slot:${claim.callIndex}`;
      const existing = await storage.get(slotKey);
      if (existing === claim.fingerprint) return "replay";
      if (typeof existing === "string") return "reused";
      const storedCount = await storage.get("count");
      const count = typeof storedCount === "number" ? storedCount : 0;
      if (count >= claim.budget) return "exceeded";
      await storage.put(slotKey, claim.fingerprint);
      await storage.put("count", count + 1);
      return "claimed";
    });
    if (outcome === "reused") return Response.json({ error: "task_write_budget_slot_reused" }, { status: 409 });
    if (outcome === "exceeded") return Response.json({ error: "task_write_budget_exceeded" }, { status: 429 });
    await this.state.storage.setAlarm(claim.expiresAt + 60_000);
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
