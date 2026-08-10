import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-meeting-task-proposal-test",
}));
vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MeetingTaskProposalNotifier,
  buildProposalBlocks,
  buildEditModalView,
  candidateIdempotencyKey,
  proposalKey,
  type StoredProposal,
} from "../meeting-task-proposal.js";
import type { BrainbaseTaskClient } from "../../../shared/brainbase-tasks.js";
import { GraphPeopleClient } from "../../../shared/brainbase-graph.js";

const STATE_DIR = "/tmp/openryoko-meeting-task-proposal-test";
const STATE_FILE = path.join(STATE_DIR, ".meeting-task-proposals.json");

const CHANNEL = "C0A2L9FEKEJ";
const SOURCE_TS = (Date.now() / 1000).toFixed(6);
const APPROVER = "U_SATO";

const PEOPLE = [
  { id: "per_sato_keigo", name: "佐藤 圭吾", aliases: ["佐藤", "sato"] },
  { id: "per_tanaka", name: "田中 太郎", aliases: [] },
];

function makePeopleClient(people = PEOPLE) {
  return { listPeople: vi.fn().mockResolvedValue(people) } as unknown as GraphPeopleClient;
}

function makeApp() {
  const apiCall = vi.fn().mockResolvedValue({ ok: true, ts: "9999.000001" });
  const app = {
    client: { apiCall },
    message: vi.fn(),
    action: vi.fn(),
    view: vi.fn(),
  } as unknown as App;
  return { app, apiCall };
}

function makeTaskClient() {
  let seq = 0;
  const createTask = vi.fn().mockImplementation(async () => ({ id: `task-${++seq}`, version: 1 }));
  const getTask = vi.fn().mockImplementation(async (id: string) => ({ id, version: 4 }));
  const deleteTask = vi.fn().mockResolvedValue({ task_id: "x" });
  const updateTask = vi.fn().mockImplementation(async (id: string) => ({ id, version: 5 }));
  const client = { createTask, getTask, deleteTask, updateTask } as unknown as BrainbaseTaskClient;
  return { client, createTask, getTask, deleteTask, updateTask };
}

function makeNotifier(overrides: {
  extract?: ReturnType<typeof vi.fn>;
  taskClient?: ReturnType<typeof makeTaskClient>;
  people?: typeof PEOPLE;
  config?: Record<string, unknown>;
  projectCodes?: string[];
} = {}) {
  const { app, apiCall } = makeApp();
  const extract = overrides.extract ?? vi.fn().mockResolvedValue([
    { title: "見積書を送付する", assignee: "佐藤", due: "2026-08-05", context: "承認済み" },
    { title: "デモ環境を用意する", assignee: "未定", due: null, context: "" },
  ]);
  const taskClient = overrides.taskClient ?? makeTaskClient();
  const notifier = new MeetingTaskProposalNotifier(
    app,
    { enabled: true, channels: [CHANNEL], ...overrides.config },
    [APPROVER],
    {
      extractImpl: extract as any,
      taskClientFactory: () => taskClient.client,
      peopleClient: makePeopleClient(overrides.people),
      projectCodesForChannel: () => overrides.projectCodes ?? [],
    },
  );
  notifier.register();
  return { notifier, apiCall, extract, ...taskClient };
}

const longMinutes = "議事録: " + "決定事項とアクションについて話し合った。".repeat(20);

function messageEvent(overrides: Record<string, unknown> = {}) {
  return {
    channel: CHANNEL,
    ts: String(Date.now() / 1000),
    text: longMinutes,
    subtype: "bot_message",
    ...overrides,
  };
}

function actionBody(index?: number, user = APPROVER) {
  return {
    body: {
      user: { id: user },
      channel: { id: CHANNEL },
      trigger_id: "trigger-1",
    },
    action: {
      value: JSON.stringify(
        index === undefined
          ? { key: proposalKey(CHANNEL, SOURCE_TS) }
          : { key: proposalKey(CHANNEL, SOURCE_TS), index },
      ),
    },
  };
}

function readState(): Record<string, StoredProposal> {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function seedProposal(partial: Partial<StoredProposal> = {}): StoredProposal {
  const proposal: StoredProposal = {
    channelId: CHANNEL,
    sourceTs: SOURCE_TS,
    proposalTs: "9999.000001",
    createdAt: Date.now(),
    expiresAt: Date.now() + 72 * 3_600_000,
    candidates: [
      {
        index: 0,
        title: "見積書を送付する",
        assignee: "佐藤",
        due: "2026-08-05",
        context: "承認済み",
        status: "registered",
        taskId: "task-1",
        assigneePersonId: "per_sato_keigo",
        assigneePersonName: "佐藤 圭吾",
      },
      {
        index: 1,
        title: "デモ環境を用意する",
        assignee: "未定",
        due: null,
        context: "",
        status: "registered",
        taskId: "task-2",
      },
    ],
    ...partial,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify({ [proposalKey(CHANNEL, SOURCE_TS)]: proposal }));
  return proposal;
}

beforeEach(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
  process.env.BRAINBASE_TASK_API_TOKEN = "token";
});

afterEach(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  delete process.env.BRAINBASE_TASK_API_BASE_URL;
  delete process.env.BRAINBASE_TASK_API_TOKEN;
});

describe("default registration on detection", () => {
  it("registers all candidates immediately with deterministic idempotency keys", async () => {
    const { notifier, apiCall, createTask } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS }));

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0][1]).toBe(`meeting:${CHANNEL}:${SOURCE_TS}:0`);
    expect(createTask.mock.calls[1][1]).toBe(`meeting:${CHANNEL}:${SOURCE_TS}:1`);
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({ channel: CHANNEL }));

    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates.every((c) => c.status === "registered")).toBe(true);
    expect(stored.candidates[0].taskId).toBe("task-1");
  });

  it("resolves assignee via Graph aliases and passes assignee_person_id", async () => {
    const { notifier, createTask } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS }));
    expect(createTask.mock.calls[0][0]).toMatchObject({ assignee_person_id: "per_sato_keigo" });
    // 未定 → no resolution attempted
    expect(createTask.mock.calls[1][0]).not.toHaveProperty("assignee_person_id");
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates[0].assigneePersonName).toBe("佐藤 圭吾");
  });

  it("binds registered tasks to the channel placement project union", async () => {
    const { notifier, createTask } = makeNotifier({ projectCodes: ["mana", "brainbase"] });
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS }));
    expect(createTask.mock.calls[0][0]).toMatchObject({ project_codes: ["mana", "brainbase"] });
  });

  it("skips assignee when the Graph is unavailable (empty people)", async () => {
    const { notifier, createTask } = makeNotifier({ people: [] });
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS }));
    expect(createTask.mock.calls[0][0]).not.toHaveProperty("assignee_person_id");
  });

  it("keeps failed registrations pending with a retry path", async () => {
    const taskClient = makeTaskClient();
    taskClient.createTask
      .mockImplementationOnce(async () => ({ id: "task-1", version: 1 }))
      .mockRejectedValueOnce(new Error("api down"));
    const { notifier } = makeNotifier({ taskClient });
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS }));
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates[0].status).toBe("registered");
    expect(stored.candidates[1].status).toBe("pending");
  });

  it("ignores non-allowlisted channels, short messages, file shares, and pre-boot messages", async () => {
    const { notifier, extract } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ channel: "C_OTHER" }));
    await notifier.maybeHandleMessage(messageEvent({ text: "短い" }));
    await notifier.maybeHandleMessage(messageEvent({ files: [{ name: "minutes.txt" }] }));
    await notifier.maybeHandleMessage(messageEvent({ ts: "1000000000.000001" }));
    expect(extract).not.toHaveBeenCalled();
  });

  it("does not re-process the same message ts", async () => {
    const { notifier, extract } = makeNotifier();
    const event = messageEvent({ ts: SOURCE_TS });
    await notifier.maybeHandleMessage(event);
    await notifier.maybeHandleMessage(event);
    expect(extract).toHaveBeenCalledOnce();
  });

  it("posts nothing when extraction returns no candidates", async () => {
    const { notifier, apiCall, createTask } = makeNotifier({ extract: vi.fn().mockResolvedValue([]) });
    await notifier.maybeHandleMessage(messageEvent());
    expect(apiCall).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("cancel / retry actions", () => {
  it("cancels a registered task by deleting it from the canonical store", async () => {
    const { notifier, apiCall, getTask, deleteTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleCancelAction(body, action);
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(deleteTask).toHaveBeenCalledWith("task-1", 4);
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[0].status).toBe("removed");
    expect(apiCall).toHaveBeenCalledWith("chat.update", expect.objectContaining({ ts: "9999.000001" }));
  });

  it("keeps the task registered when deletion fails", async () => {
    const taskClient = makeTaskClient();
    taskClient.deleteTask.mockRejectedValue(new Error("boom"));
    const { notifier } = makeNotifier({ taskClient });
    seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleCancelAction(body, action);
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[0].status).toBe("registered");
  });

  it("denies unauthorized users with an ephemeral notice", async () => {
    const { notifier, apiCall, deleteTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(0, "U_EVIL");
    await notifier.handleCancelAction(body, action);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({ user: "U_EVIL" }));
  });

  it("tells the user when the proposal has expired", async () => {
    const { notifier, apiCall, deleteTask } = makeNotifier();
    seedProposal({ expiresAt: Date.now() - 1000 });
    const { body, action } = actionBody(0);
    await notifier.handleCancelAction(body, action);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith(
      "chat.postEphemeral",
      expect.objectContaining({ text: expect.stringContaining("期限切れ") }),
    );
  });

  it("retries a pending registration with the same idempotency key", async () => {
    const { notifier, createTask } = makeNotifier();
    const proposal = seedProposal();
    proposal.candidates[1].status = "pending";
    delete proposal.candidates[1].taskId;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ [proposalKey(CHANNEL, SOURCE_TS)]: proposal }));
    const { body, action } = actionBody(1);
    await notifier.handleRetryAction(body, action);
    expect(createTask).toHaveBeenCalledWith(expect.anything(), candidateIdempotencyKey(proposal, 1));
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[1].status).toBe("registered");
  });

  it("cancel-all deletes every registered task", async () => {
    const { notifier, deleteTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody();
    await notifier.handleCancelAllAction(body, action);
    expect(deleteTask).toHaveBeenCalledTimes(2);
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates.every((c) => c.status === "removed")).toBe(true);
  });
});

describe("edit modal", () => {
  it("opens the modal with Graph people options and current values", async () => {
    const { notifier, apiCall } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleEditOpenAction(body, action);
    expect(apiCall).toHaveBeenCalledWith(
      "views.open",
      expect.objectContaining({ trigger_id: "trigger-1" }),
    );
    const view = (apiCall.mock.calls.find((c) => c[0] === "views.open")![1] as any).view;
    const rendered = JSON.stringify(view);
    expect(rendered).toContain("見積書を送付する");
    expect(rendered).toContain("per_sato_keigo");
    expect(rendered).toContain("per_tanaka");
    expect(rendered).toContain("2026-08-05");
  });

  it("applies a submitted edit to the canonical task with a fresh version", async () => {
    const { notifier, getTask, updateTask } = makeNotifier();
    seedProposal();
    const view = {
      private_metadata: JSON.stringify({ key: proposalKey(CHANNEL, SOURCE_TS), index: 0 }),
      state: {
        values: {
          title: { value: { value: "見積書を修正して送付する" } },
          due: { value: { selected_date: "2026-08-10" } },
          assignee: { value: { selected_option: { value: "per_tanaka" } } },
        },
      },
    };
    await notifier.handleEditSubmit({ user: { id: APPROVER } }, view);
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      expected_version: 4,
      title: "見積書を修正して送付する",
      due_at: "2026-08-10T00:00:00+09:00",
      assignee_person_id: "per_tanaka",
    });
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[0];
    expect(stored.title).toBe("見積書を修正して送付する");
    expect(stored.due).toBe("2026-08-10");
    expect(stored.assigneePersonName).toBe("田中 太郎");
  });

  it("clears the assignee when （担当なし） is selected", async () => {
    const { notifier, updateTask } = makeNotifier();
    seedProposal();
    const view = {
      private_metadata: JSON.stringify({ key: proposalKey(CHANNEL, SOURCE_TS), index: 0 }),
      state: {
        values: {
          title: { value: { value: "見積書を送付する" } },
          assignee: { value: { selected_option: { value: "__none__" } } },
        },
      },
    };
    await notifier.handleEditSubmit({ user: { id: APPROVER } }, view);
    expect(updateTask.mock.calls[0][1]).toMatchObject({ assignee_person_id: null });
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[0].assigneePersonId).toBeUndefined();
  });

  it("ignores edit submissions from unauthorized users", async () => {
    const { notifier, updateTask } = makeNotifier();
    seedProposal();
    const view = {
      private_metadata: JSON.stringify({ key: proposalKey(CHANNEL, SOURCE_TS), index: 0 }),
      state: { values: { title: { value: { value: "乗っ取り" } } } },
    };
    await notifier.handleEditSubmit({ user: { id: "U_EVIL" } }, view);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("buildProposalBlocks", () => {
  it("renders cancel/edit for registered, retry for pending, nothing for removed", () => {
    const proposal = seedProposal();
    proposal.candidates[1].status = "pending";
    const rendered = JSON.stringify(buildProposalBlocks(proposal));
    expect(rendered).toContain("meeting_task_cancel");
    expect(rendered).toContain("meeting_task_edit");
    expect(rendered).toContain("meeting_task_retry");

    proposal.candidates[0].status = "removed";
    proposal.candidates[1].status = "removed";
    const after = JSON.stringify(buildProposalBlocks(proposal));
    expect(after).not.toContain("meeting_task_cancel");
    expect(after).toContain("取り消し済み");
  });

  it("shows the bulk cancel button only with 2+ registered tasks", () => {
    const proposal = seedProposal();
    expect(JSON.stringify(buildProposalBlocks(proposal))).toContain("meeting_task_cancel_all");
    proposal.candidates[1].status = "removed";
    expect(JSON.stringify(buildProposalBlocks(proposal))).not.toContain("meeting_task_cancel_all");
  });

  it("prefers the Graph-resolved assignee name and defangs mention syntax", () => {
    const proposal = seedProposal();
    proposal.candidates[0].title = "<!channel> を騙すタイトル";
    const rendered = JSON.stringify(buildProposalBlocks(proposal));
    expect(rendered).not.toContain("<!channel>");
    expect(rendered).toContain("佐藤 圭吾");
  });
});

describe("buildEditModalView", () => {
  it("caps options at 100 and marks the current assignee as initial", () => {
    const proposal = seedProposal();
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, aliases: [] }));
    const view = buildEditModalView(proposal, proposal.candidates[0], [
      { id: "per_sato_keigo", name: "佐藤 圭吾", aliases: [] },
      ...many,
    ]) as any;
    const assigneeBlock = view.blocks.find((b: any) => b.block_id === "assignee");
    expect(assigneeBlock.element.options.length).toBeLessThanOrEqual(100);
    expect(assigneeBlock.element.initial_option.value).toBe("per_sato_keigo");
  });
});
