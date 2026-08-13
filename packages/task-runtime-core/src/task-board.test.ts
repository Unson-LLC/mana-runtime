import { describe, expect, it, vi } from "vitest";
import { fetchBoundedTaskBoard, TaskApiError } from "./index.js";

function task(id: string, status: string, projects = ["back-office"]) {
  return {
    id,
    version: 1,
    title: `task-${id}`,
    description: null,
    status,
    priority: "low",
    project_codes: projects,
    assignee_person_id: null,
    assignee_display_name: null,
    due_at: null,
    waiting_on: null,
    completed_at: null,
  };
}

describe("bounded task board", () => {
  it("uses four fixed requests without following cursors", async () => {
    const listTasks = vi.fn().mockImplementation(async ({ status }) => ({
      items: [task(String(status), String(status))],
      next_cursor: status === "pending" ? "next" : null,
    }));
    const result = await fetchBoundedTaskBoard({ listTasks }, ["back-office"], 20);

    expect(listTasks).toHaveBeenCalledTimes(4);
    expect(listTasks.mock.calls.map(([query]) => query)).toEqual([
      { status: "in_progress", limit: 21, project_code: ["back-office"] },
      { status: "waiting", limit: 21, project_code: ["back-office"] },
      { status: "pending", limit: 21, project_code: ["back-office"] },
      { status: "completed", limit: 21, project_code: ["back-office"] },
    ]);
    expect(result).toMatchObject({ hasMore: true, observedLowerBound: 5, requestCount: 4 });
  });

  it("caps the combined display and reports only a lower bound", async () => {
    const listTasks = vi.fn().mockImplementation(async ({ status }) => ({
      items: Array.from({ length: 6 }, (_, index) => task(`${status}-${index}`, String(status))),
      next_cursor: null,
    }));
    const result = await fetchBoundedTaskBoard({ listTasks }, ["back-office"], 20);
    expect(result.items).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.observedLowerBound).toBe(21);
  });

  it("fails closed when any task project escapes the trusted union", async () => {
    const listTasks = vi.fn()
      .mockResolvedValueOnce({ items: [task("1", "in_progress", ["back-office", "outside"])], next_cursor: null })
      .mockResolvedValue({ items: [task("1", "pending", ["back-office", "outside"])], next_cursor: null });
    await expect(fetchBoundedTaskBoard({ listTasks }, ["back-office"], 20)).rejects.toMatchObject<Partial<TaskApiError>>({
      code: "task_board_scope_violation",
    });
  });

  it("fails closed on a projectless or cross-project-only task", async () => {
    const listTasks = vi.fn().mockResolvedValue({ items: [task("1", "pending", ["outside"])], next_cursor: null });
    await expect(fetchBoundedTaskBoard({ listTasks }, ["back-office"], 20)).rejects.toMatchObject<Partial<TaskApiError>>({
      code: "task_board_scope_violation",
    });
  });
});
