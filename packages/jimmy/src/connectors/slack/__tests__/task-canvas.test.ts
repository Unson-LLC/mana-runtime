import fs from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { App } from "@slack/bolt";
import {
  TaskCanvasUpdater,
  fetchAllTasks,
  renderTaskCanvasMarkdown,
  taskCanvasConfigsForPlacements,
  placementProjectCodesForChannel,
} from "../task-canvas.js";
import { BrainbaseTaskClient, type BrainbaseTask } from "../../../shared/brainbase-tasks.js";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-task-canvas-test",
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeTask(overrides: Partial<BrainbaseTask> = {}): BrainbaseTask {
  return {
    id: "ct1.x",
    version: 1,
    title: "テストタスク",
    description: null,
    status: "pending",
    priority: "medium",
    assignee_person_id: null,
    assignee_display_name: null,
    due_at: null,
    waiting_on: null,
    completed_at: null,
    project_codes: [],
    ...overrides,
  };
}

function fakeApp(apiCall: (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return { client: { apiCall: vi.fn(apiCall) } } as unknown as App;
}

function fakeTaskClient(tasks: BrainbaseTask[]): () => BrainbaseTaskClient {
  return () =>
    ({
      listTasks: vi.fn(async () => ({ items: tasks, next_cursor: null })),
    }) as unknown as BrainbaseTaskClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync("/tmp/openryoko-task-canvas-test", { recursive: true, force: true });
  fs.mkdirSync("/tmp/openryoko-task-canvas-test", { recursive: true });
  process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
  process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
});

afterEach(() => {
  delete process.env.BRAINBASE_TASK_API_BASE_URL;
  delete process.env.BRAINBASE_TASK_API_TOKEN;
});

describe("renderTaskCanvasMarkdown", () => {
  it("renders a project settings state before a channel is bound", () => {
    const md = renderTaskCanvasMarkdown([], {
      projectCodes: [],
      settingsUrl: "https://mana.example/placements/projects?channel=C1",
    });
    expect(md).toContain("projectが未設定");
    expect(md).toContain("[projectを設定](https://mana.example/placements/projects?channel=C1)");
    expect(md).not.toContain("## 完了");
  });

  it("groups tasks by status with counts and read-only notice", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({ id: "1", title: "着手中", status: "in_progress", priority: "high" }),
      makeTask({ id: "2", title: "未着手A", status: "pending", priority: "low" }),
      makeTask({ id: "3", title: "完了済", status: "completed" }),
      makeTask({ id: "4", title: "待ち中", status: "waiting", waiting_on: "レビュー" }),
    ]);
    expect(md).toContain("# タスクボード");
    expect(md).toContain("読み取り専用ミラー");
    expect(md).toContain("### 進行中（1件）");
    expect(md).toContain("* [高] 着手中");
    expect(md).toContain("### 保留（1件）");
    expect(md).toContain("待ち: レビュー");
    expect(md).toContain("### 未着手（1件）");
    expect(md).toContain("## 完了（累計1件）");
  });

  it("sorts by priority then due date and caps sections", () => {
    const tasks = [
      makeTask({ id: "1", title: "低優先", priority: "low" }),
      makeTask({ id: "2", title: "緊急・期限あり", priority: "urgent", due_at: "2026-08-01T00:00:00Z" }),
      makeTask({ id: "3", title: "高優先", priority: "high" }),
    ];
    const md = renderTaskCanvasMarkdown(tasks, { maxPerSection: 2 });
    const urgentIndex = md.indexOf("緊急・期限あり");
    const highIndex = md.indexOf("高優先");
    expect(urgentIndex).toBeGreaterThan(-1);
    expect(urgentIndex).toBeLessThan(highIndex);
    expect(md).toContain("…ほか1件");
    expect(md).toContain("期限: 2026-08-01");
  });

  it("defangs mention and markdown syntax in task titles", () => {
    const md = renderTaskCanvasMarkdown([makeTask({ title: "<!channel> *強調* #見出し" })]);
    expect(md).not.toContain("<!channel>");
    expect(md).not.toContain("*強調*");
  });

  it("groups by assignee and shows every project tag", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({ id: "1", title: "担当あり", assignee_display_name: "佐藤圭吾", project_codes: ["mana", "brainbase"] }),
      makeTask({ id: "2", title: "担当なし", project_codes: ["mana"] }),
    ]);
    expect(md).toContain("## 佐藤圭吾");
    expect(md).toContain("## 未割当");
    expect(md).toContain("[mana] [brainbase]");
  });
});

describe("fetchAllTasks", () => {
  it("queries the placement project union and deduplicates task ids", async () => {
    const listTasks = vi.fn()
      .mockResolvedValueOnce({ items: [makeTask({ id: "one" })], next_cursor: "next" })
      .mockResolvedValueOnce({ items: [makeTask({ id: "one" }), makeTask({ id: "two" })], next_cursor: null });
    const tasks = await fetchAllTasks({ listTasks } as unknown as BrainbaseTaskClient, ["mana", "brainbase"]);
    expect(listTasks).toHaveBeenNthCalledWith(1, { limit: 50, project_code: ["mana", "brainbase"], cursor: undefined });
    expect(tasks.map((task) => task.id)).toEqual(["one", "two"]);
  });
});

describe("taskCanvasConfigsForPlacements", () => {
  it("creates a setup canvas for a placement whose projects are not configured", () => {
    const configs = taskCanvasConfigsForPlacements({
      enabled: true,
      settingsWebBaseUrl: "https://mana.example",
    }, [{
      id: "p1",
      connector: "slack",
      workspaceId: "T1",
      channelId: "C1",
      audience: { type: "project-team", allowedUsers: ["U1"] },
    }], "slack", "T1");
    expect(configs).toEqual([
      expect.objectContaining({
        channelId: "C1",
        projectCodes: [],
        settingsUrl: "https://mana.example/placements/projects?connector=slack&workspace=T1&channel=C1",
      }),
    ]);
  });

  it("creates one channel canvas per placement and unions duplicate-channel projects", () => {
    const base = { workspaceId: "T1", audience: { type: "project-team" as const, allowedUsers: ["U1"] } };
    const configs = taskCanvasConfigsForPlacements({ enabled: true }, [
      { ...base, id: "p1", connector: "slack", channelId: "C1", projects: ["mana"] },
      { ...base, id: "p2", connector: "slack", channelId: "C1", projects: ["brainbase", "mana"] },
      { ...base, id: "p3", connector: "slack", channelId: "C2", projects: ["staye"] },
      { ...base, id: "p4", connector: "slack-other", channelId: "C3", projects: ["other"] },
    ], "slack", "T1");
    expect(configs).toEqual([
      expect.objectContaining({ channelId: "C1", projectCodes: ["mana", "brainbase"] }),
      expect.objectContaining({ channelId: "C2", projectCodes: ["staye"] }),
    ]);
  });

  it("separates workspaces and excludes placements with Task Canvas disabled", () => {
    const base = { connector: "slack", channelId: "C1", audience: { type: "project-team" as const } };
    const placements = [
      { ...base, id: "default", workspaceId: "T_DEFAULT", projects: ["brainbase"] },
      { ...base, id: "biz", workspaceId: "T_BIZ", projects: ["unson"] },
      { ...base, id: "disabled", workspaceId: "T_BIZ", channelId: "C2", projects: ["mana"], taskCanvas: { enabled: false } },
    ];
    expect(taskCanvasConfigsForPlacements({ enabled: true }, placements, "slack", "T_BIZ"))
      .toEqual([expect.objectContaining({ channelId: "C1", projectCodes: ["unson"] })]);
    expect(taskCanvasConfigsForPlacements({ enabled: true }, placements, "slack", null)).toEqual([]);
  });

  it("fails closed instead of creating an unscoped canvas when placements exist but do not match", () => {
    const configs = taskCanvasConfigsForPlacements({ enabled: true }, [{
      id: "other",
      connector: "slack-other",
      workspaceId: "T2",
      channelId: "C2",
      projects: ["other"],
      audience: { type: "project-team", allowedUsers: ["U1"] },
    }], "slack-biz", "T1");
    expect(configs).toEqual([]);
  });
});

describe("placementProjectCodesForChannel", () => {
  it("uses connector type and exact workspace for meeting task projects", () => {
    const placements = [
      { id: "default", connector: "slack", workspaceId: "T_DEFAULT", channelId: "C1", projects: ["brainbase"], audience: { type: "project-team" as const } },
      { id: "biz", connector: "slack", workspaceId: "T_BIZ", channelId: "C1", projects: ["unson"], audience: { type: "project-team" as const } },
    ];
    expect(placementProjectCodesForChannel(placements, "slack", "C1", "T_BIZ")).toEqual(["unson"]);
    expect(placementProjectCodesForChannel(placements, "slack", "C1", null)).toEqual([]);
  });
});

describe("TaskCanvasUpdater", () => {
  it("publishes setup canvas without querying Brainbase when project binding is empty", async () => {
    const taskFactory = vi.fn(fakeTaskClient([]));
    const app = fakeApp(async (method) => method === "conversations.canvases.create" ? { canvas_id: "FSETUP" } : {});
    const updater = new TaskCanvasUpdater(app, {
      enabled: true,
      channelId: "C0TEST",
      projectCodes: [],
      settingsUrl: "https://mana.example/placements/projects?channel=C0TEST",
    }, taskFactory);

    await updater.tick();

    expect(taskFactory).not.toHaveBeenCalled();
    const apiCall = (app.client as unknown as { apiCall: ReturnType<typeof vi.fn> }).apiCall;
    expect(apiCall).toHaveBeenCalledWith("conversations.canvases.create", expect.objectContaining({
      document_content: expect.objectContaining({ markdown: expect.stringContaining("projectが未設定") }),
    }));
  });

  it("creates a channel canvas on first tick and persists its id", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const app = fakeApp(async (method, payload) => {
      calls.push({ method, payload });
      if (method === "conversations.canvases.create") return { canvas_id: "F0CANVAS1" };
      return {};
    });
    const updater = new TaskCanvasUpdater(
      app,
      { enabled: true, channelId: "C0TEST" },
      fakeTaskClient([makeTask()]),
    );

    await updater.tick();

    expect(calls.map((c) => c.method)).toEqual(["conversations.canvases.create"]);
    expect(calls[0].payload.channel_id).toBe("C0TEST");
    const state = JSON.parse(fs.readFileSync("/tmp/openryoko-task-canvas-test/.task-canvas-state.json", "utf-8"));
    expect(state.canvases.C0TEST).toBe("F0CANVAS1");
  });

  it("edits the existing canvas and skips no-op updates", async () => {
    const calls: string[] = [];
    const app = fakeApp(async (method) => {
      calls.push(method);
      if (method === "conversations.canvases.create") return { canvas_id: "F0CANVAS1" };
      return {};
    });
    const updater = new TaskCanvasUpdater(
      app,
      { enabled: true, channelId: "C0TEST" },
      fakeTaskClient([makeTask()]),
    );

    await updater.tick();
    await updater.tick(); // same markdown → no API call

    expect(calls).toEqual(["conversations.canvases.create"]);
  });

  it("adopts an existing channel canvas when creation conflicts", async () => {
    const calls: string[] = [];
    const app = fakeApp(async (method) => {
      calls.push(method);
      if (method === "conversations.canvases.create") {
        const err = new Error("channel_canvas_already_exists") as Error & { data: { error: string } };
        err.data = { error: "channel_canvas_already_exists" };
        throw err;
      }
      if (method === "conversations.info") {
        return { channel: { properties: { canvas: { file_id: "F0EXISTING" } } } };
      }
      return {};
    });
    const updater = new TaskCanvasUpdater(
      app,
      { enabled: true, channelId: "C0TEST" },
      fakeTaskClient([makeTask()]),
    );

    await updater.tick();

    expect(calls).toEqual(["conversations.canvases.create", "conversations.info", "canvases.edit"]);
  });

  it("does not start when the Brainbase task store is not configured", () => {
    delete process.env.BRAINBASE_TASK_API_BASE_URL;
    const app = fakeApp(async () => ({}));
    const updater = new TaskCanvasUpdater(app, { enabled: true, channelId: "C0TEST" }, fakeTaskClient([]));
    updater.start();
    updater.stop();
    expect((app.client as unknown as { apiCall: ReturnType<typeof vi.fn> }).apiCall).not.toHaveBeenCalled();
  });
});
