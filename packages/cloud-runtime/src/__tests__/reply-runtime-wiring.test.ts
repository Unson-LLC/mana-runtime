import {
  resolveReplyTaskSearchOptions,
  runWithReplyTaskSearchBinding,
  RuntimeBindingError,
} from "../runtime-config.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "unson-business",
    eventId: "EvSearch",
    workspaceId: "T_UNSON",
    channelId: "C_BACK_OFFICE",
    threadTs: "1.0",
    messageTs: "2.0",
    userId: "U_USER",
    eventType: "app_mention",
    text: "契約更新タスクを探して",
    receivedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

const configured = {
  tenantId: "unson-business",
  workspaceId: "T_UNSON",
  channelId: "C_BACK_OFFICE",
  projectCodes: "back-office,brainbase",
  taskSearchEnabled: "true",
  brainbaseApiBaseUrl: "https://bb.example.test",
  brainbaseTaskToken: "brainbase-secret-canary",
};

describe("reply task-search runtime wiring", () => {
  it("resolves the canonical binding before enabling task search", () => {
    expect(resolveReplyTaskSearchOptions(event(), configured)).toEqual({
      taskSearchEnabled: true,
      binding: {
        tenantId: "unson-business",
        workspaceId: "T_UNSON",
        channelId: "C_BACK_OFFICE",
        projectCodes: ["back-office", "brainbase"],
      },
    });
  });

  it.each([
    ["workspace mismatch", event({ workspaceId: "T_OTHER" }), configured, "workspace_not_allowed"],
    ["missing project", event(), { ...configured, projectCodes: "" }, "project_binding_missing"],
    ["missing base URL", event(), { ...configured, brainbaseApiBaseUrl: "" }, "task_search_config_missing"],
    ["missing token", event(), { ...configured, brainbaseTaskToken: "" }, "task_search_config_missing"],
  ])("fails closed for %s", (_name, input, config, code) => {
    expect(() => resolveReplyTaskSearchOptions(input, config)).toThrow(
      expect.objectContaining<Partial<RuntimeBindingError>>({ code }),
    );
  });

  it("does not require a task binding while the feature is off", () => {
    expect(resolveReplyTaskSearchOptions(event(), {
      ...configured,
      taskSearchEnabled: undefined,
      projectCodes: undefined,
      brainbaseApiBaseUrl: undefined,
      brainbaseTaskToken: undefined,
    })).toEqual({ taskSearchEnabled: false });
  });

  it("fails before creating a sandbox when the task project binding is missing", () => {
    const createReplyPipeline = vi.fn();

    expect(() => runWithReplyTaskSearchBinding(event(), {
      ...configured,
      projectCodes: "",
    }, createReplyPipeline)).toThrowError("project_binding_missing");
    expect(createReplyPipeline).not.toHaveBeenCalled();
  });
});
