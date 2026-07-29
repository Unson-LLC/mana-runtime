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
  candidateIdempotencyKey,
  proposalKey,
  type StoredProposal,
} from "../meeting-task-proposal.js";
import type { BrainbaseTaskClient } from "../../../shared/brainbase-tasks.js";

const STATE_DIR = "/tmp/openryoko-meeting-task-proposal-test";
const STATE_FILE = path.join(STATE_DIR, ".meeting-task-proposals.json");

const CHANNEL = "C0A2L9FEKEJ";
const SOURCE_TS = (Date.now() / 1000).toFixed(6);
const APPROVER = "U_SATO";

function makeApp() {
  const apiCall = vi.fn().mockResolvedValue({ ok: true, ts: "9999.000001" });
  const actionHandlers = new Map<string, Function>();
  const messageHandlers: Function[] = [];
  const app = {
    client: { apiCall },
    message: (handler: Function) => messageHandlers.push(handler),
    action: (id: string, handler: Function) => actionHandlers.set(id, handler),
  } as unknown as App;
  return { app, apiCall, actionHandlers, messageHandlers };
}

function makeTaskClient() {
  const createTask = vi.fn().mockResolvedValue({ id: "task-1", version: 1 });
  return { client: { createTask } as unknown as BrainbaseTaskClient, createTask };
}

function makeNotifier(overrides: {
  extract?: ReturnType<typeof vi.fn>;
  createTask?: ReturnType<typeof vi.fn>;
  config?: Record<string, unknown>;
} = {}) {
  const { app, apiCall } = makeApp();
  const extract = overrides.extract ?? vi.fn().mockResolvedValue([
    { title: "見積書を送付する", assignee: "佐藤", due: "2026-08-05", context: "承認済み" },
    { title: "デモ環境を用意する", assignee: "未定", due: null, context: "" },
  ]);
  const { client, createTask } = makeTaskClient();
  if (overrides.createTask) (client as any).createTask = overrides.createTask;
  const notifier = new MeetingTaskProposalNotifier(
    app,
    { enabled: true, channels: [CHANNEL], ...overrides.config },
    [APPROVER],
    { extractImpl: extract as any, taskClientFactory: () => client },
  );
  notifier.register();
  return { notifier, apiCall, extract, createTask: overrides.createTask ?? createTask };
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
      { index: 0, title: "見積書を送付する", assignee: "佐藤", due: "2026-08-05", context: "承認済み", status: "pending" },
      { index: 1, title: "デモ環境を用意する", assignee: "未定", due: null, context: "", status: "pending" },
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

describe("detection gates", () => {
  it("proposes candidates for a long minutes message in an allowed channel", async () => {
    const { notifier, apiCall, extract } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ ts: SOURCE_TS, }));
    expect(extract).toHaveBeenCalledOnce();
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({ channel: CHANNEL }));
    const state = readState();
    const proposal = state[proposalKey(CHANNEL, SOURCE_TS)];
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.proposalTs).toBe("9999.000001");
  });

  it("ignores non-allowlisted channels, short messages, and file shares", async () => {
    const { notifier, extract } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ channel: "C_OTHER" }));
    await notifier.maybeHandleMessage(messageEvent({ text: "短い" }));
    await notifier.maybeHandleMessage(messageEvent({ files: [{ name: "minutes.txt" }] }));
    expect(extract).not.toHaveBeenCalled();
  });

  it("ignores messages older than boot time", async () => {
    const { notifier, extract } = makeNotifier();
    await notifier.maybeHandleMessage(messageEvent({ ts: "1000000000.000001" }));
    expect(extract).not.toHaveBeenCalled();
  });

  it("does not re-propose for the same message ts", async () => {
    const { notifier, extract } = makeNotifier();
    const event = messageEvent({ ts: SOURCE_TS });
    await notifier.maybeHandleMessage(event);
    await notifier.maybeHandleMessage(event);
    expect(extract).toHaveBeenCalledOnce();
  });

  it("posts nothing when extraction returns no candidates", async () => {
    const { notifier, apiCall } = makeNotifier({ extract: vi.fn().mockResolvedValue([]) });
    await notifier.maybeHandleMessage(messageEvent());
    expect(apiCall).not.toHaveBeenCalled();
  });
});

describe("approval actions", () => {
  it("registers an approved candidate with a deterministic idempotency key", async () => {
    const { notifier, apiCall, createTask } = makeNotifier();
    const proposal = seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleSingleAction(body, action, true);

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "見積書を送付する",
        due_at: "2026-08-05T00:00:00+09:00",
      }),
      candidateIdempotencyKey(proposal, 0),
    );
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates[0].status).toBe("approved");
    expect(stored.candidates[0].taskId).toBe("task-1");
    expect(stored.candidates[1].status).toBe("pending");
    expect(apiCall).toHaveBeenCalledWith("chat.update", expect.objectContaining({ ts: "9999.000001" }));
  });

  it("never passes assignee_person_id", async () => {
    const { notifier, createTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleSingleAction(body, action, true);
    expect(createTask.mock.calls[0][0]).not.toHaveProperty("assignee_person_id");
  });

  it("rejects without registering", async () => {
    const { notifier, createTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(1);
    await notifier.handleSingleAction(body, action, false);
    expect(createTask).not.toHaveBeenCalled();
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[1].status).toBe("rejected");
  });

  it("denies unauthorized users with an ephemeral notice", async () => {
    const { notifier, apiCall, createTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody(0, "U_EVIL");
    await notifier.handleSingleAction(body, action, true);
    expect(createTask).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({ user: "U_EVIL" }));
  });

  it("tells the user when the proposal has expired", async () => {
    const { notifier, apiCall, createTask } = makeNotifier();
    seedProposal({ expiresAt: Date.now() - 1000 });
    const { body, action } = actionBody(0);
    await notifier.handleSingleAction(body, action, true);
    expect(createTask).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith(
      "chat.postEphemeral",
      expect.objectContaining({ text: expect.stringContaining("期限切れ") }),
    );
  });

  it("keeps a candidate pending when registration fails, allowing retry", async () => {
    const createTask = vi.fn().mockRejectedValue(new Error("api down"));
    const { notifier } = makeNotifier({ createTask });
    seedProposal();
    const { body, action } = actionBody(0);
    await notifier.handleSingleAction(body, action, true);
    expect(readState()[proposalKey(CHANNEL, SOURCE_TS)].candidates[0].status).toBe("pending");
  });

  it("does not double-register an already approved candidate", async () => {
    const { notifier, createTask } = makeNotifier();
    const proposal = seedProposal();
    proposal.candidates[0].status = "approved";
    fs.writeFileSync(STATE_FILE, JSON.stringify({ [proposalKey(CHANNEL, SOURCE_TS)]: proposal }));
    const { body, action } = actionBody(0);
    await notifier.handleSingleAction(body, action, true);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("approve-all registers every pending candidate and reports partial failures", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValueOnce({ id: "task-1", version: 1 })
      .mockRejectedValueOnce(new Error("boom"));
    const { notifier, apiCall } = makeNotifier({ createTask });
    seedProposal();
    const { body, action } = actionBody();
    await notifier.handleBulkAction(body, action, true);
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(stored.candidates[0].status).toBe("approved");
    expect(stored.candidates[1].status).toBe("pending");
    expect(apiCall).toHaveBeenCalledWith(
      "chat.postEphemeral",
      expect.objectContaining({ text: expect.stringContaining("失敗") }),
    );
  });

  it("reject-all rejects every pending candidate", async () => {
    const { notifier, createTask } = makeNotifier();
    seedProposal();
    const { body, action } = actionBody();
    await notifier.handleBulkAction(body, action, false);
    const stored = readState()[proposalKey(CHANNEL, SOURCE_TS)];
    expect(createTask).not.toHaveBeenCalled();
    expect(stored.candidates.every((c) => c.status === "rejected")).toBe(true);
  });
});

describe("buildProposalBlocks", () => {
  it("renders buttons only for pending candidates and bulk buttons for 2+ pending", () => {
    const proposal = seedProposal();
    const blocks = buildProposalBlocks(proposal) as any[];
    const actionBlocks = blocks.filter((b) => b.type === "actions");
    expect(actionBlocks).toHaveLength(3); // 2 per-candidate + 1 bulk

    proposal.candidates[0].status = "approved";
    const after = buildProposalBlocks(proposal) as any[];
    expect(after.filter((b) => b.type === "actions")).toHaveLength(1); // 1 pending, no bulk
    expect(JSON.stringify(after)).toContain("登録済み");
  });

  it("defangs mention syntax in LLM-derived text", () => {
    const proposal = seedProposal();
    proposal.candidates[0].title = "<!channel> を騙すタイトル";
    const rendered = JSON.stringify(buildProposalBlocks(proposal));
    expect(rendered).not.toContain("<!channel>");
  });
});
