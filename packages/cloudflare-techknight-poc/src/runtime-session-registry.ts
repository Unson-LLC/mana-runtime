import { DurableObject } from "cloudflare:workers";

export interface RuntimeSessionRecord {
  sessionId: string;
  placementId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterId?: string;
  status: "active" | "idle";
  updatedAt: string;
}

const KEY_PREFIX = "session:";
export class RuntimeSessionRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/sessions") {
      const value = await request.json() as RuntimeSessionRecord;
      if (!value.sessionId || !value.placementId || !value.workspaceId || !value.channelId || !value.threadTs) return Response.json({ error: "invalid_session" }, { status: 400 });
      await this.ctx.storage.put(`${KEY_PREFIX}${value.sessionId}`, value);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      const values = await this.ctx.storage.list<RuntimeSessionRecord>({ prefix: KEY_PREFIX });
      const status = url.searchParams.get("status");
      const sessions = [...values.values()].filter((value) => !status || value.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Response.json({ sessions });
    }
    if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      const value = await this.ctx.storage.get<RuntimeSessionRecord>(`${KEY_PREFIX}${id}`);
      return value ? Response.json(value) : Response.json({ error: "session_not_found" }, { status: 404 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function upsertRuntimeSession(namespace: {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}, record: RuntimeSessionRecord): Promise<void> {
  const stub = namespace.get(namespace.idFromName(record.placementId));
  const response = await stub.fetch("https://session-registry.internal/sessions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
  if (!response.ok) throw new Error("session_registry_write_failed");
}
