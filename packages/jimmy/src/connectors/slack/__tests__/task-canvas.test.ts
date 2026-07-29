import fs from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { App } from "@slack/bolt";
import { TaskCanvasUpdater, renderTaskCanvasMarkdown } from "../task-canvas.js";
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
  it("groups tasks by status with counts and read-only notice", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({ title: "着手中", status: "in_progress", priority: "high" }),
      makeTask({ title: "未着手A", status: "pending", priority: "low" }),
      makeTask({ title: "完了済", status: "completed" }),
      makeTask({ title: "待ち中", status: "waiting", waiting_on: "レビュー" }),
    ]);
    expect(md).toContain("# タスクボード");
    expect(md).toContain("読み取り専用ミラー");
    expect(md).toContain("## 進行中（1件）");
    expect(md).toContain("* [高] 着手中");
    expect(md).toContain("## 保留（1件）");
    expect(md).toContain("待ち: レビュー");
    expect(md).toContain("## 未着手（1件）");
    expect(md).toContain("## 完了（累計1件）");
  });

  it("sorts by priority then due date and caps sections", () => {
    const tasks = [
      makeTask({ title: "低優先", priority: "low" }),
      makeTask({ title: "緊急・期限あり", priority: "urgent", due_at: "2026-08-01T00:00:00Z" }),
      makeTask({ title: "高優先", priority: "high" }),
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
});

describe("TaskCanvasUpdater", () => {
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
    expect(state.canvasId).toBe("F0CANVAS1");
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
