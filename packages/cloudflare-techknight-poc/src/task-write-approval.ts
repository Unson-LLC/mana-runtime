interface DurableObjectStubLike { fetch(request: Request): Promise<Response> }
export interface TaskWriteApprovalNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface PendingTaskWriteApproval {
  approvalId: string;
  payloadHash: string;
  body: unknown;
  capability: string;
  requesterId: string;
  approvers: string[];
  policyVersion: string;
  expiresAt: number;
}

interface StorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
  transaction<T>(closure: (storage: Pick<StorageLike, "get" | "put">) => Promise<T>): Promise<T>;
}

function stub(namespace: TaskWriteApprovalNamespace, approvalId: string): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(approvalId));
}

export async function createTaskWriteApproval(namespace: TaskWriteApprovalNamespace, pending: PendingTaskWriteApproval): Promise<void> {
  const response = await stub(namespace, pending.approvalId).fetch(new Request("https://task-write-approval.internal/pending", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending),
  }));
  if (!response.ok) throw new Error("task_write_approval_store_failed");
}

export async function peekTaskWriteApproval(namespace: TaskWriteApprovalNamespace, approvalId: string): Promise<PendingTaskWriteApproval> {
  const response = await stub(namespace, approvalId).fetch(new Request("https://task-write-approval.internal/pending"));
  if (!response.ok) throw new Error("task_write_approval_invalid");
  return response.json() as Promise<PendingTaskWriteApproval>;
}

export async function consumeTaskWriteApproval(namespace: TaskWriteApprovalNamespace, input: { approvalId: string; payloadHash: string; approverId: string }): Promise<PendingTaskWriteApproval> {
  const response = await stub(namespace, input.approvalId).fetch(new Request("https://task-write-approval.internal/consume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? "task_write_approval_invalid");
  }
  return response.json() as Promise<PendingTaskWriteApproval>;
}

function validPending(value: unknown): value is PendingTaskWriteApproval {
  const item = value as Partial<PendingTaskWriteApproval> | null;
  return !!item && typeof item.approvalId === "string" && /^[a-f0-9-]{36}$/.test(item.approvalId)
    && typeof item.payloadHash === "string" && /^[a-f0-9]{64}$/.test(item.payloadHash)
    && typeof item.capability === "string" && item.capability.length <= 8192
    && typeof item.requesterId === "string" && item.requesterId.length > 0
    && Array.isArray(item.approvers) && item.approvers.length > 0 && item.approvers.every((id) => typeof id === "string" && id.length > 0)
    && typeof item.policyVersion === "string" && Number.isFinite(item.expiresAt) && item.expiresAt! > Date.now();
}

export class TaskWriteApproval {
  constructor(private readonly state: { storage: StorageLike }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "task-write-approval.internal") return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method === "POST" && url.pathname === "/pending") {
      const pending = await request.json().catch(() => null);
      if (!validPending(pending)) return Response.json({ error: "task_write_approval_invalid" }, { status: 400 });
      const existing = await this.state.storage.get("pending") as PendingTaskWriteApproval | undefined;
      if (existing && existing.payloadHash !== pending.payloadHash) return Response.json({ error: "task_write_approval_conflict" }, { status: 409 });
      await this.state.storage.put("pending", pending);
      await this.state.storage.setAlarm(pending.expiresAt + 60_000);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/pending") {
      const pending = await this.state.storage.get("pending") as PendingTaskWriteApproval | undefined;
      if (!pending || pending.expiresAt <= Date.now()) return Response.json({ error: "task_write_approval_expired" }, { status: 410 });
      return Response.json(pending);
    }
    if (request.method === "POST" && url.pathname === "/consume") {
      const input = await request.json().catch(() => null) as { payloadHash?: unknown; approverId?: unknown } | null;
      const outcome = await this.state.storage.transaction(async (storage) => {
        const pending = await storage.get("pending") as PendingTaskWriteApproval | undefined;
        if (!pending || pending.expiresAt <= Date.now()) return { error: "task_write_approval_expired", status: 410 } as const;
        if (await storage.get("consumed")) return { error: "task_write_approval_consumed", status: 409 } as const;
        if (input?.payloadHash !== pending.payloadHash) return { error: "task_write_approval_payload_mismatch", status: 403 } as const;
        if (typeof input?.approverId !== "string" || !pending.approvers.includes(input.approverId)) return { error: "task_write_approver_forbidden", status: 403 } as const;
        await storage.put("consumed", { approverId: input.approverId, at: Date.now() });
        return { pending } as const;
      });
      if ("error" in outcome) return Response.json({ error: outcome.error }, { status: outcome.status });
      return Response.json(outcome.pending);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> { await this.state.storage.deleteAll(); }
}
