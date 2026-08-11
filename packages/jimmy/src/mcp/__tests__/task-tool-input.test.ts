import { describe, expect, it } from "vitest";

import {
  buildCreateTaskRequestBody,
  buildUpdateTaskRequestBody,
  TASK_ASSIGNEE_NAME_SCHEMA,
  withTaskAssigneeNameSchema,
} from "../task-tool-input.js";

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
});
