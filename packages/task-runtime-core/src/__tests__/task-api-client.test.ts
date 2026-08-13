import { describe, expect, it, vi } from "vitest";

import {
  TaskApiClient,
  TaskApiError,
  type CreateTaskInput,
} from "../index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("TaskApiClient", () => {
  it("story-shared-task-runtime-core:ac:1 provides the canonical task HTTP contract without platform defaults", async () => {
    const task = { id: "task-1", version: 1, title: "確認する" };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(task));
    const client = new TaskApiClient({
      baseUrl: "https://brainbase.example/",
      token: "service-token",
      fetchImpl,
    });
    const input: CreateTaskInput = { title: "確認する", project_codes: ["back-office"] };

    await expect(client.createTask(input, "event-1:create:task-1")).resolves.toMatchObject(task);
    expect(fetchImpl).toHaveBeenCalledWith("https://brainbase.example/api/companion/tasks", {
      method: "POST",
      headers: {
        Authorization: "Bearer service-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "event-1:create:task-1",
      },
      body: JSON.stringify(input),
    });
  });

  it("encodes repeated project filters and keeps page completeness metadata", async () => {
    const page = {
      items: [],
      total_count: null,
      count_status: "not_requested",
      has_more: true,
      next_cursor: "next-page",
      read_status: "partial",
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page));
    const client = new TaskApiClient({ baseUrl: "https://brainbase.example", token: "token", fetchImpl });

    await expect(client.searchTasks({
      query: "梅田",
      limit: 20,
      project_code: ["back-office", "accounting"],
    })).resolves.toEqual(page);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    const params = new URL(url).searchParams;
    expect(params.getAll("project_code")).toEqual(["back-office", "accounting"]);
    expect(params.get("query")).toBe("梅田");
    expect(params.get("limit")).toBe("20");
  });

  it("normalizes Brainbase failures and invalid successful JSON", async () => {
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { code: "version_conflict", message: "stale task" },
      { status: 409 },
    ));
    const failedClient = new TaskApiClient({
      baseUrl: "https://brainbase.example",
      token: "token",
      fetchImpl: failedFetch,
    });
    await expect(failedClient.getTask("task/1")).rejects.toMatchObject({
      name: "BrainbaseTaskError",
      status: 409,
      code: "version_conflict",
      message: "stale task",
    } satisfies Partial<TaskApiError>);

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 }));
    const invalidClient = new TaskApiClient({
      baseUrl: "https://brainbase.example",
      token: "token",
      fetchImpl: invalidFetch,
    });
    await expect(invalidClient.getTask("task-1")).rejects.toMatchObject({
      code: "task_store_invalid_response",
      status: 502,
    });
  });

  it("requires explicit credentials and an idempotency key for writes", async () => {
    expect(() => new TaskApiClient({ baseUrl: "", token: "token" })).toThrowError(
      expect.objectContaining({ code: "task_store_not_configured" }),
    );
    const client = new TaskApiClient({ baseUrl: "https://brainbase.example", token: "token" });
    await expect(client.createTask({ title: "x" }, "")).rejects.toMatchObject({
      code: "idempotency_key_required",
      status: 400,
    });
  });
});
