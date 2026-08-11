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
  it("renders a project settings state without duplicating the Slack canvas title", () => {
    const md = renderTaskCanvasMarkdown([], {
      projectCodes: [],
      settingsUrl: "https://mana.example/placements/projects?channel=C1",
    });
    expect(md).toContain("projectが未設定");
    expect(md).toContain("[projectを設定](https://mana.example/placements/projects?channel=C1)");
    expect(md).not.toMatch(/^# /m);
  });

  it("renders a compact single-project board and omits empty sections and repeated project tags", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({ id: "1", title: "請求書確認", status: "pending", priority: "high", project_codes: ["back-office"] }),
      makeTask({ id: "2", title: "完了済", status: "completed", project_codes: ["back-office"] }),
    ], {
      projectCodes: ["back-office"],
      settingsUrl: "https://mana.example/projects",
    });
    expect(md).toContain("Brainbase同期（読み取り専用）｜対象project: back-office｜[project設定を変更]");
    expect(md).toContain("未完了 1件｜進行中 0｜保留 0｜未着手 1｜その他 0｜完了 1");
    expect(md).toContain("## 未割当（1件）");
    expect(md).toContain("### 未着手（1件）");
    expect(md).toContain("* **請求書確認**\n  🔴 高");
    expect(md).not.toContain("### 進行中");
    expect(md).not.toContain("### 保留");
    expect(md).not.toContain("* なし");
    expect(md).not.toContain("[back-office]");
    expect(md).not.toMatch(/^# /m);
  });

  it("renders one empty-state line when there are no active tasks", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({ id: "1", status: "completed" }),
    ], { projectCodes: ["back-office"] });
    expect(md).toContain("未完了 0件｜進行中 0｜保留 0｜未着手 0｜その他 0｜完了 1");
    expect(md).toContain("現在の未完了タスクはありません。");
    expect(md).not.toMatch(/^## /m);
    expect(md).not.toMatch(/^### /m);
  });

  it("shows only configured project intersections in binding order and sanitizes user-controlled text", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({
        title: "<!channel> *契約*",
        status: "waiting",
        waiting_on: "<レビュー> #待ち",
        assignee_display_name: "<佐藤> *圭吾*",
        project_codes: ["other", "brainbase", "mana"],
      }),
    ], { projectCodes: ["mana", "brainbase"] });
    expect(md).toContain("## 佐藤 圭吾（1件）");
    expect(md).toContain("* **!channel 契約**");
    expect(md).toContain("🟡 中｜[mana]｜[brainbase]｜待ち レビュー 待ち");
    expect(md).not.toContain("[other]");
    expect(md).not.toContain("<!channel>");
    expect(md).not.toContain("*契約*");
  });

  it("keeps unknown active statuses visible and distinguishes unresolved assignees", () => {
    const md = renderTaskCanvasMarkdown([
      makeTask({
        status: "blocked" as BrainbaseTask["status"],
        assignee_person_id: "person-1",
        assignee_display_name: null,
      }),
    ]);
    expect(md).toContain("その他 1");
    expect(md).toContain("## 担当者名未解決（1件）");
    expect(md).toContain("### その他（1件）");
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
    expect(md).toContain("🚨 緊急｜期限 2026-08-01");
    expect(md).not.toContain("低優先");
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
    expect(calls[0].payload.title).toBe("タスクボード");
    expect((calls[0].payload.document_content as { markdown: string }).markdown).not.toMatch(/^# /m);
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
