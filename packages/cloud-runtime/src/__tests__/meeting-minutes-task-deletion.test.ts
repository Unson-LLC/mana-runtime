import { describe, expect, it, vi } from "vitest";
import { createMeetingMinutesTaskDeleter } from "../meeting-minutes-task-deletion.js";

function setup(responses: Response[]) {
  const credentialFetch = vi.fn<typeof fetch>();
  for (const response of responses) credentialFetch.mockResolvedValueOnce(response);
  const boundary = vi.fn(async (_name: "brainbase_proxy", execute: (fetchImpl: typeof fetch) => Promise<void>) => {
    await execute(credentialFetch);
  });
  const deleteTask = createMeetingMinutesTaskDeleter({ baseUrl: "https://brainbase.example", boundary });
  return { deleteTask, boundary, credentialFetch };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("meeting-minutes redo task deletion", () => {
  it("uses the boundary credential fetch for GET and DELETE, retaining version and idempotency", async () => {
    const { deleteTask, boundary, credentialFetch } = setup([
      json({ id: "task/1", version: 7 }), json({ task_id: "task/1" }),
    ]);
    await deleteTask("task/1", "redo-run-revision-0-task-1");
    expect(boundary).toHaveBeenCalledWith("brainbase_proxy", expect.any(Function));
    expect(credentialFetch.mock.calls).toEqual([
      ["https://brainbase.example/api/companion/tasks/task%2F1", { method: "GET", headers: {} }],
      ["https://brainbase.example/api/companion/tasks/task%2F1", {
        method: "DELETE", headers: { "Content-Type": "application/json", "Idempotency-Key": "redo-run-revision-0-task-1" },
        body: JSON.stringify({ expected_version: 7 }),
      }],
    ]);
  });

  it("does not issue DELETE when GET confirms the task is already absent", async () => {
    const { deleteTask, credentialFetch } = setup([json({ code: "not_found" }, 404)]);
    await expect(deleteTask("task-1", "redo-1")).resolves.toBeUndefined();
    expect(credentialFetch).toHaveBeenCalledOnce();
  });

  it("accepts DELETE 404 after a successful GET for safe replay", async () => {
    const { deleteTask } = setup([json({ id: "task-1", version: 2 }), json({ code: "not_found" }, 404)]);
    await expect(deleteTask("task-1", "redo-1")).resolves.toBeUndefined();
  });

  for (const status of [401, 403, 409, 503]) {
    for (const stage of ["GET", "DELETE"]) {
      it(`propagates ${stage} ${status} without reporting successful cancellation`, async () => {
        const responses = stage === "GET" ? [] : [json({ id: "task-1", version: 3 })];
        responses.push(json({ code: "task_store_error" }, status));
        const { deleteTask, credentialFetch } = setup(responses);
        await expect(deleteTask("task-1", "redo-1")).rejects.toMatchObject({ status });
        expect(credentialFetch).toHaveBeenCalledTimes(stage === "GET" ? 1 : 2);
      });
    }
  }
});
