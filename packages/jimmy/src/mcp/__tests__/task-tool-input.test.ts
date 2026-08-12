import { describe, expect, it } from "vitest";

import {
  buildCreateTaskRequestBody,
  buildTaskListPath,
  buildTaskSearchPath,
  TASK_LIST_DESCRIPTION,
  buildUpdateTaskRequestBody,
  TASK_LIST_QUERY_SCHEMA,
  TASK_SEARCH_DESCRIPTION,
  TASK_SEARCH_QUERY_SCHEMA,
  TASK_ASSIGNEE_NAME_SCHEMA,
  withTaskAssigneeNameSchema,
} from "../task-tool-input.js";

// VibePro traceability: story-slack-task-bounded-search:ac:1, story-slack-task-bounded-search:ac:5, story-slack-task-bounded-search:ac:6, story-slack-task-bounded-search:ac:8.

describe("task MCP input", () => {
  it("defines the optional assignee_name schema shared by create and update", () => {
    expect(TASK_ASSIGNEE_NAME_SCHEMA).toEqual({
      type: "string",
      description: expect.stringContaining("Graph"),
    });
    expect(withTaskAssigneeNameSchema({ title: { type: "string" } })).toEqual({
      title: { type: "string" },
      assignee_name: TASK_ASSIGNEE_NAME_SCHEMA,
    });
  });

  it("forwards assignee_name unchanged on create", () => {
    expect(buildCreateTaskRequestBody({
      title: "担当者付きタスク",
      description: "説明",
      assignee_name: "Haruka Umeda",
    })).toEqual({
      title: "担当者付きタスク",
      description: "説明",
      assignee_name: "Haruka Umeda",
    });
  });

  it("rebuilds update bodies from an allowlist", () => {
    expect(buildUpdateTaskRequestBody({
      task_id: "ct1.test",
      expected_version: 3,
      title: "更新",
      assignee_name: "梅田 遼",
      assignee_person_id: "per_spoofed",
      idempotency_key: "idem-1",
      arbitrary: "must-not-leak",
    })).toEqual({
      expected_version: 3,
      title: "更新",
      assignee_name: "梅田 遼",
    });
  });

  it("exposes explicit list continuation and server-side search filters", () => {
    expect(TASK_LIST_QUERY_SCHEMA).toMatchObject({
      cursor: { type: "string" },
      assignee_person_id: { type: "string" },
      project_code: { type: "array" },
    });
    expect(TASK_SEARCH_QUERY_SCHEMA).toMatchObject({
      query: { type: "string" },
      limit: { type: "number", maximum: 20 },
      cursor: { type: "string" },
      project_code: { type: "array" },
    });
    expect(TASK_LIST_DESCRIPTION).toContain("one page");
    expect(TASK_LIST_DESCRIPTION).toContain("next_cursor");
    expect(TASK_LIST_DESCRIPTION).toContain("never infer absence");
    expect(TASK_SEARCH_DESCRIPTION).toContain("next_cursor");
    expect(TASK_SEARCH_DESCRIPTION).toContain("has_more");
    expect(TASK_SEARCH_DESCRIPTION).toContain("never infer absence");
  });

  it("builds bounded list and search paths without scanning all pages", () => {
    expect(buildTaskListPath({
      status: "pending",
      assignee_person_id: "per_umeda",
      cursor: "next",
      project_code: ["back-office", "shared"],
      limit: 50,
    })).toBe(
      "/api/tasks?status=pending&assignee_person_id=per_umeda&cursor=next&project_code=back-office&project_code=shared&limit=50",
    );
    expect(buildTaskSearchPath({
      query: "月次 締め",
      status: "pending",
      project_code: ["back-office"],
      limit: 20,
    })).toBe(
      "/api/tasks/search?query=%E6%9C%88%E6%AC%A1+%E7%B7%A0%E3%82%81&status=pending&project_code=back-office&limit=20",
    );
  });
});
