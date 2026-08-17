const ID = /^[A-Z0-9]{2,32}$/;
const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface TaskBoardBindingNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface TaskBoardBindingCoordinates {
  tenantId: string;
  targetId: string;
  workspaceId: string;
  channelId: string;
  bindingRevision: number;
}

export type TaskBoardBindingReservation =
  | { status: "reserved" }
  | { status: "provisioning" }
  | { status: "bound"; canvasId: string };

interface TaskBoardBindingRecord extends TaskBoardBindingCoordinates {
  status: "provisioning" | "bound";
  canvasId?: string;
  updatedAt: string;
}

interface StorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(closure: (storage: Pick<StorageLike, "get" | "put" | "delete">) => Promise<T>): Promise<T>;
}

function validCoordinates(value: unknown): value is TaskBoardBindingCoordinates {
  const candidate = value as Partial<TaskBoardBindingCoordinates> | null;
  return Boolean(candidate
    && typeof candidate.tenantId === "string" && TENANT_ID.test(candidate.tenantId)
    && typeof candidate.targetId === "string" && TARGET_ID.test(candidate.targetId)
    && typeof candidate.workspaceId === "string" && ID.test(candidate.workspaceId)
    && typeof candidate.channelId === "string" && ID.test(candidate.channelId)
    && Number.isSafeInteger(candidate.bindingRevision) && Number(candidate.bindingRevision) >= 1);
}

function sameCoordinates(record: TaskBoardBindingRecord, coordinates: TaskBoardBindingCoordinates): boolean {
  return record.tenantId === coordinates.tenantId
    && record.targetId === coordinates.targetId
    && record.workspaceId === coordinates.workspaceId
    && record.channelId === coordinates.channelId
    && record.bindingRevision === coordinates.bindingRevision;
}

function stub(namespace: TaskBoardBindingNamespace, coordinates: TaskBoardBindingCoordinates): DurableObjectStubLike {
  const name = [
    coordinates.tenantId,
    coordinates.workspaceId,
    coordinates.targetId,
    String(coordinates.bindingRevision),
  ].join(":");
  return namespace.get(namespace.idFromName(name));
}

async function bindingRequest(
  namespace: TaskBoardBindingNamespace,
  coordinates: TaskBoardBindingCoordinates,
  path: string,
  body: unknown,
): Promise<Response> {
  return stub(namespace, coordinates).fetch(new Request(`https://task-board-binding.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function reserveTaskBoardBinding(
  namespace: TaskBoardBindingNamespace,
  coordinates: TaskBoardBindingCoordinates,
): Promise<TaskBoardBindingReservation> {
  const response = await bindingRequest(namespace, coordinates, "/reserve", coordinates);
  if (!response.ok) throw new Error("task_board_binding_reserve_failed");
  return response.json() as Promise<TaskBoardBindingReservation>;
}

export async function completeTaskBoardBinding(
  namespace: TaskBoardBindingNamespace,
  coordinates: TaskBoardBindingCoordinates,
  canvasId: string,
): Promise<void> {
  const response = await bindingRequest(namespace, coordinates, "/complete", { ...coordinates, canvasId });
  if (!response.ok) throw new Error("task_board_binding_complete_failed");
}

export async function releaseTaskBoardBinding(
  namespace: TaskBoardBindingNamespace,
  coordinates: TaskBoardBindingCoordinates,
): Promise<void> {
  const response = await bindingRequest(namespace, coordinates, "/release", coordinates);
  if (!response.ok) throw new Error("task_board_binding_release_failed");
}

export class TaskBoardBinding {
  constructor(private readonly state: { storage: StorageLike }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.hostname !== "task-board-binding.internal") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const input = await request.json().catch(() => null) as
      (TaskBoardBindingCoordinates & { canvasId?: string }) | null;
    if (!validCoordinates(input)) {
      return Response.json({ error: "task_board_binding_invalid" }, { status: 400 });
    }
    if (url.pathname === "/reserve") {
      const outcome = await this.state.storage.transaction(async (storage) => {
        const existing = await storage.get("binding") as TaskBoardBindingRecord | undefined;
        if (existing && !sameCoordinates(existing, input)) return { error: "task_board_binding_conflict" } as const;
        if (existing?.status === "bound" && existing.canvasId) {
          return { status: "bound", canvasId: existing.canvasId } as const;
        }
        if (existing?.status === "provisioning") return { status: "provisioning" } as const;
        await storage.put("binding", {
          ...input,
          status: "provisioning",
          updatedAt: new Date().toISOString(),
        } satisfies TaskBoardBindingRecord);
        return { status: "reserved" } as const;
      });
      if ("error" in outcome) return Response.json({ error: outcome.error }, { status: 409 });
      return Response.json(outcome);
    }
    if (url.pathname === "/complete") {
      if (typeof input.canvasId !== "string" || !ID.test(input.canvasId)) {
        return Response.json({ error: "task_board_canvas_id_invalid" }, { status: 400 });
      }
      const outcome = await this.state.storage.transaction(async (storage) => {
        const existing = await storage.get("binding") as TaskBoardBindingRecord | undefined;
        if (!existing || !sameCoordinates(existing, input)) return "conflict";
        if (existing.status === "bound") return existing.canvasId === input.canvasId ? "complete" : "conflict";
        await storage.put("binding", {
          ...existing,
          status: "bound",
          canvasId: input.canvasId,
          updatedAt: new Date().toISOString(),
        } satisfies TaskBoardBindingRecord);
        return "complete";
      });
      return outcome === "complete"
        ? new Response(null, { status: 204 })
        : Response.json({ error: "task_board_binding_conflict" }, { status: 409 });
    }
    if (url.pathname === "/release") {
      const outcome = await this.state.storage.transaction(async (storage) => {
        const existing = await storage.get("binding") as TaskBoardBindingRecord | undefined;
        if (!existing) return "released";
        if (!sameCoordinates(existing, input) || existing.status === "bound") return "conflict";
        await storage.delete("binding");
        return "released";
      });
      return outcome === "released"
        ? new Response(null, { status: 204 })
        : Response.json({ error: "task_board_binding_conflict" }, { status: 409 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
