import { describe, it, expect, vi } from "vitest";

import {
  BrainbaseTaskClient,
  BrainbaseTaskError,
  isBrainbaseTaskStoreConfigured,
} from "../brainbase-tasks.js";

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const options = { baseUrl: "https://bb.example", token: "bbsvc_test" };

describe("isBrainbaseTaskStoreConfigured", () => {
  it("requires both base URL and token", () => {
    expect(isBrainbaseTaskStoreConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isBrainbaseTaskStoreConfigured({ BRAINBASE_TASK_API_BASE_URL: "https://bb.example" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isBrainbaseTaskStoreConfigured({
        BRAINBASE_TASK_API_BASE_URL: "https://bb.example",
        BRAINBASE_TASK_API_TOKEN: "bbsvc_x",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("BrainbaseTaskClient", () => {
  it("fails loud when not configured", () => {
    expect(() => new BrainbaseTaskClient({ baseUrl: "", token: "", fetchImpl: fakeFetch(() => ({ status: 200, body: {} })) }))
      .toThrowError(BrainbaseTaskError);
  });

  it("creates a task with bearer auth and an idempotency key", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://bb.example/api/companion/tasks");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bbsvc_test");
      expect(headers["Idempotency-Key"]).toMatch(/^openryoko:/);
      expect(JSON.parse(String(init.body))).toEqual({ title: "t", priority: "low" });
      return { status: 201, body: { id: "ct1.x", version: 1, title: "t" } };
    });
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    const task = await client.createTask({ title: "t", priority: "low" });
    expect(task.id).toBe("ct1.x");
  });

  it("passes an explicit idempotency key through unchanged", async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("slack:C1:123.456");
      return { status: 201, body: { id: "ct1.x", version: 1 } };
    });
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    await client.createTask({ title: "t" }, "slack:C1:123.456");
  });

  it("lists tasks with query filters", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://bb.example/api/companion/tasks?status=pending&limit=5");
      expect(init.method).toBe("GET");
      return { status: 200, body: { items: [] } };
    });
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    const result = await client.listTasks({ status: "pending", limit: 5 });
    expect(result.items).toEqual([]);
  });

  it("transitions a task through the transitions endpoint", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://bb.example/api/companion/tasks/ct1.x/transitions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({ expected_version: 2, to_status: "completed" });
      return { status: 200, body: { id: "ct1.x", version: 3, status: "completed" } };
    });
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    const task = await client.transitionTask("ct1.x", { expected_version: 2, to_status: "completed" });
    expect(task.status).toBe("completed");
  });

  it("surfaces the API error code and status on failure", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 503,
      body: { code: "canonical_task_mutation_not_ready", message: "Canonical Task mutation is not ready" },
    }));
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    await expect(client.createTask({ title: "t" })).rejects.toMatchObject({
      name: "BrainbaseTaskError",
      status: 503,
      code: "canonical_task_mutation_not_ready",
    });
  });

  it("deletes with expected_version in the body", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://bb.example/api/companion/tasks/ct1.x");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(String(init.body))).toEqual({ expected_version: 1 });
      return { status: 200, body: { task_id: "ct1.x" } };
    });
    const client = new BrainbaseTaskClient({ ...options, fetchImpl });
    const result = await client.deleteTask("ct1.x", 1);
    expect(result.task_id).toBe("ct1.x");
  });
});
