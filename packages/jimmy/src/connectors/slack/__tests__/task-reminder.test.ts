import fs from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { App } from "@slack/bolt";
import {
  TaskReminderNotifier,
  classifyDueTasks,
  renderReminderMessage,
} from "../task-reminder.js";
import { BrainbaseTaskClient, type BrainbaseTask } from "../../../shared/brainbase-tasks.js";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-task-reminder-test",
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const NOW = Date.parse("2026-07-29T09:00:00Z");
const HOUR = 3_600_000;

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

function fakeApp(apiCall?: (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return { client: { apiCall: vi.fn(apiCall ?? (async () => ({}))) } } as unknown as App;
}

function fakeTaskClient(tasks: () => BrainbaseTask[]): () => BrainbaseTaskClient {
  return () =>
    ({
      listTasks: vi.fn(async () => ({ items: tasks(), next_cursor: null })),
    }) as unknown as BrainbaseTaskClient;
}

function apiCalls(app: App): Array<{ method: string; payload: Record<string, unknown> }> {
  const mock = (app.client as unknown as { apiCall: ReturnType<typeof vi.fn> }).apiCall;
  return mock.mock.calls.map(([method, payload]) => ({ method, payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync("/tmp/openryoko-task-reminder-test", { recursive: true, force: true });
  fs.mkdirSync("/tmp/openryoko-task-reminder-test", { recursive: true });
  process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
  process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
});

afterEach(() => {
  delete process.env.BRAINBASE_TASK_API_BASE_URL;
  delete process.env.BRAINBASE_TASK_API_TOKEN;
});

describe("classifyDueTasks", () => {
  it("splits open tasks into overdue and due-soon and ignores the rest", () => {
    const entries = classifyDueTasks(
      [
        makeTask({ id: "overdue", due_at: new Date(NOW - HOUR).toISOString() }),
        makeTask({ id: "soon", status: "in_progress", due_at: new Date(NOW + 6 * HOUR).toISOString() }),
        makeTask({ id: "far", due_at: new Date(NOW + 48 * HOUR).toISOString() }),
        makeTask({ id: "no-due" }),
        makeTask({ id: "done", status: "completed", due_at: new Date(NOW - HOUR).toISOString() }),
      ],
      NOW,
      24,
    );
    expect(entries.map((e) => [e.task.id, e.kind])).toEqual([
      ["overdue", "overdue"],
      ["soon", "due_soon"],
    ]);
  });
});

describe("renderReminderMessage", () => {
  it("renders overdue and due-soon sections with relative time", () => {
    const message = renderReminderMessage(
      [
        { task: makeTask({ title: "超過分", priority: "high", due_at: new Date(NOW - 25 * HOUR).toISOString() }), kind: "overdue" },
        { task: makeTask({ title: "接近分", due_at: new Date(NOW + 6 * HOUR).toISOString() }), kind: "due_soon" },
      ],
      NOW,
    );
    expect(message).toContain("タスク期限リマインド");
    expect(message).toContain("*期限超過（1件）*");
    expect(message).toContain("[高] 超過分");
    expect(message).toContain("2日超過");
    expect(message).toContain("*期限接近（1件）*");
    expect(message).toContain("あと6時間");
  });

  it("returns null when there is nothing to remind", () => {
    expect(renderReminderMessage([], NOW)).toBeNull();
  });

  it("defangs mention syntax in task titles", () => {
    const message = renderReminderMessage(
      [{ task: makeTask({ title: "<!channel> 注意", due_at: new Date(NOW - HOUR).toISOString() }), kind: "overdue" }],
      NOW,
    );
    expect(message).not.toContain("<!channel>");
  });
});

describe("TaskReminderNotifier", () => {
  it("posts a reminder once and does not re-post the same state", async () => {
    const app = fakeApp();
    const notifier = new TaskReminderNotifier(
      app,
      { enabled: true, channelId: "C0REMIND" },
      fakeTaskClient(() => [makeTask({ id: "t1", due_at: new Date(NOW - HOUR).toISOString() })]),
    );

    await notifier.tick(NOW);
    await notifier.tick(NOW + HOUR);

    const calls = apiCalls(app);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("chat.postMessage");
    expect(calls[0].payload.channel).toBe("C0REMIND");
    expect(String(calls[0].payload.text)).toContain("期限超過");
  });

  it("notifies again when a due-soon task crosses into overdue", async () => {
    const dueAt = new Date(NOW + 6 * HOUR).toISOString();
    const app = fakeApp();
    const notifier = new TaskReminderNotifier(
      app,
      { enabled: true, channelId: "C0REMIND" },
      fakeTaskClient(() => [makeTask({ id: "t1", due_at: dueAt })]),
    );

    await notifier.tick(NOW); // due_soon
    await notifier.tick(NOW + 7 * HOUR); // now overdue

    const calls = apiCalls(app);
    expect(calls).toHaveLength(2);
    expect(String(calls[0].payload.text)).toContain("期限接近");
    expect(String(calls[1].payload.text)).toContain("期限超過");
  });

  it("re-arms notification when the due date is pushed out and comes back", async () => {
    let due = new Date(NOW - HOUR).toISOString();
    const app = fakeApp();
    const notifier = new TaskReminderNotifier(
      app,
      { enabled: true, channelId: "C0REMIND" },
      fakeTaskClient(() => [makeTask({ id: "t1", due_at: due })]),
    );

    await notifier.tick(NOW); // overdue → notified
    due = new Date(NOW + 100 * HOUR).toISOString();
    await notifier.tick(NOW); // outside window → state pruned
    due = new Date(NOW + 2 * HOUR).toISOString();
    await notifier.tick(NOW); // due soon again → notified again

    expect(apiCalls(app)).toHaveLength(2);
  });

  it("persists notified state across instances", async () => {
    const tasks = () => [makeTask({ id: "t1", due_at: new Date(NOW - HOUR).toISOString() })];
    const first = new TaskReminderNotifier(fakeApp(), { enabled: true, channelId: "C0REMIND" }, fakeTaskClient(tasks));
    await first.tick(NOW);

    const app2 = fakeApp();
    const second = new TaskReminderNotifier(app2, { enabled: true, channelId: "C0REMIND" }, fakeTaskClient(tasks));
    await second.tick(NOW + HOUR);

    expect(apiCalls(app2)).toHaveLength(0);
  });

  it("does not start without channelId or task store configuration", () => {
    const app = fakeApp();
    const noChannel = new TaskReminderNotifier(app, { enabled: true }, fakeTaskClient(() => []));
    noChannel.start();
    noChannel.stop();

    delete process.env.BRAINBASE_TASK_API_BASE_URL;
    const noStore = new TaskReminderNotifier(app, { enabled: true, channelId: "C0REMIND" }, fakeTaskClient(() => []));
    noStore.start();
    noStore.stop();

    expect(apiCalls(app)).toHaveLength(0);
  });
});
