import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-meeting-minutes-test",
  TMP_DIR: "/tmp/openryoko-meeting-minutes-test/tmp",
}));
vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MeetingMinutesPipeline,
  advanceStatus,
  runKey,
  sha256Hex,
  type MinutesRun,
} from "../meeting-minutes-pipeline.js";
import type { GraphEntityClient } from "../../../shared/brainbase-graph.js";
import type { BrainbaseTaskClient } from "../../../shared/brainbase-tasks.js";

const STATE_DIR = "/tmp/openryoko-meeting-minutes-test";
const STATE_FILE = path.join(STATE_DIR, ".meeting-minutes-runs.json");

const ROUTER = "C_ROUTER";
const OPERATOR = "U_SATO";
const DESTINATIONS = [
  { projectId: "proj_salestailor", name: "SalesTailor", channelId: "C_ST" },
  { projectId: "proj_baao", name: "BAAO", channelId: "C_BAAO" },
];

const TRANSCRIPT = "会議の文字起こし。".repeat(100);
const MINUTES = {
  title: "2026-07-30 定例-要約",
  overview: "2026-07-30 定例-要約\n定例会議\n\n概要です",
  body: "2026-07-30 定例-要約\n本文",
};

function makeApp() {
  let ts = 0;
  const apiCall = vi.fn().mockImplementation(async () => ({ ok: true, ts: `100${++ts}.000001` }));
  const app = {
    client: { apiCall, token: "xoxb-test" },
    message: vi.fn(),
    action: vi.fn(),
  } as unknown as App;
  return { app, apiCall };
}

function makeGraphClient(entities: Record<string, unknown[]> = {}) {
  return {
    listEntities: vi.fn().mockImplementation(async (type: string) => entities[type] ?? []),
  } as unknown as GraphEntityClient;
}

function makeTaskClient() {
  return {
    listTasks: vi.fn().mockResolvedValue({ items: [{ title: "既存タスク" }] }),
  } as unknown as BrainbaseTaskClient;
}

function makePipeline(overrides: {
  config?: Record<string, unknown>;
  fetchTranscript?: ReturnType<typeof vi.fn>;
  classify?: ReturnType<typeof vi.fn>;
  generate?: ReturnType<typeof vi.fn>;
  handoff?: ReturnType<typeof vi.fn> | null;
} = {}) {
  const { app, apiCall } = makeApp();
  const fetchTranscript =
    overrides.fetchTranscript ??
    vi.fn().mockResolvedValue({ text: TRANSCRIPT, fileName: "meeting.txt" });
  const classify =
    overrides.classify ??
    vi.fn().mockResolvedValue({ destination: DESTINATIONS[0], reason: "SalesTailorの話題" });
  const generate = overrides.generate ?? vi.fn().mockResolvedValue({ minutes: MINUTES });
  const handoff =
    overrides.handoff === null ? null : overrides.handoff ?? vi.fn().mockResolvedValue(true);
  const pipeline = new MeetingMinutesPipeline(
    app,
    {
      enabled: true,
      routerChannels: [ROUTER],
      destinations: DESTINATIONS,
      ...overrides.config,
    },
    [OPERATOR],
    {
      fetchTranscript: fetchTranscript as any,
      classifyImpl: classify as any,
      generateImpl: generate as any,
      graphClient: makeGraphClient(),
      taskClientFactory: () => makeTaskClient(),
      taskProposalNotifier: handoff ? { processMinutesText: handoff as any } : null,
    },
  );
  pipeline.register();
  return { pipeline, apiCall, fetchTranscript, classify, generate, handoff };
}

function fileEvent(overrides: Record<string, unknown> = {}) {
  return {
    channel: ROUTER,
    ts: String(Date.now() / 1000),
    subtype: "file_share",
    files: [{ id: "F001", name: "meeting.txt", size: 5000 }],
    ...overrides,
  };
}

function readState(): { runs: Record<string, MinutesRun>; lastMinutesByChannel: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function postedMessages(apiCall: ReturnType<typeof vi.fn>, method = "chat.postMessage") {
  return apiCall.mock.calls
    .filter((call: unknown[]) => call[0] === method)
    .map((call: unknown[]) => call[1] as any);
}

beforeEach(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
  process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
});

afterEach(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  delete process.env.BRAINBASE_TASK_API_BASE_URL;
  delete process.env.BRAINBASE_TASK_API_TOKEN;
});

describe("advanceStatus", () => {
  it("never regresses a completed stage", () => {
    const run = { status: "posted" } as MinutesRun;
    advanceStatus(run, "routed");
    expect(run.status).toBe("posted");
    advanceStatus(run, "tasks_dispatched");
    expect(run.status).toBe("tasks_dispatched");
  });

  it("allows failed markers and recovery from them", () => {
    const run = { status: "routed" } as MinutesRun;
    advanceStatus(run, "failed:generate");
    expect(run.status).toBe("failed:generate");
    advanceStatus(run, "routed");
    expect(run.status).toBe("routed");
  });
});

describe("detection gates", () => {
  it("ignores channels outside the router allowlist", async () => {
    const { pipeline, fetchTranscript } = makePipeline();
    await pipeline.maybeHandleFileMessage(fileEvent({ channel: "C_OTHER" }));
    expect(fetchTranscript).not.toHaveBeenCalled();
  });

  it('watches every channel when routerChannels contains "*"', async () => {
    const { pipeline, fetchTranscript } = makePipeline({
      config: { routerChannels: ["*"] },
    });
    await pipeline.maybeHandleFileMessage(fileEvent({ channel: "C_ANYWHERE" }));
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("ignores non-file_share messages and non-.txt files", async () => {
    const { pipeline, fetchTranscript } = makePipeline();
    await pipeline.maybeHandleFileMessage(fileEvent({ subtype: undefined }));
    await pipeline.maybeHandleFileMessage(
      fileEvent({ files: [{ id: "F002", name: "recording.mp3", size: 100 }] }),
    );
    expect(fetchTranscript).not.toHaveBeenCalled();
  });

  it("skips oversized files with a notice", async () => {
    const { pipeline, apiCall, fetchTranscript } = makePipeline({ config: { maxFileBytes: 1000 } });
    await pipeline.maybeHandleFileMessage(fileEvent({ files: [{ id: "F1", name: "big.txt", size: 5000 }] }));
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(postedMessages(apiCall)[0].text).toContain("大きすぎます");
  });

  it("dedupes Slack redeliveries by run key", async () => {
    const { pipeline, fetchTranscript } = makePipeline();
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    await pipeline.maybeHandleFileMessage(event);
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it("skips re-uploads of the same transcript by hash", async () => {
    const { pipeline, apiCall, generate } = makePipeline();
    await pipeline.maybeHandleFileMessage(fileEvent({ ts: String(Date.now() / 1000 - 2) }));
    await pipeline.maybeHandleFileMessage(
      fileEvent({
        ts: String(Date.now() / 1000 - 1),
        files: [{ id: "F999", name: "same.txt", size: 5000 }],
      }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    const notices = postedMessages(apiCall).filter((p) => String(p.text).includes("処理済み"));
    expect(notices.length).toBe(1);
  });

  it("stays off without routerChannels / destinations / operators (fail closed)", async () => {
    for (const config of [
      { routerChannels: [] },
      { destinations: [] },
    ]) {
      const { pipeline, fetchTranscript } = makePipeline({ config });
      await pipeline.maybeHandleFileMessage(fileEvent());
      expect(fetchTranscript).not.toHaveBeenCalled();
    }
  });
});

describe("happy path", () => {
  it("routes, generates, posts parent+thread, hands off tasks, offers reroute", async () => {
    const { pipeline, apiCall, handoff } = makePipeline();
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);

    const posts = postedMessages(apiCall);
    // Parent in destination channel with the overview.
    const parent = posts.find((p) => p.channel === "C_ST" && !p.thread_ts);
    expect(parent?.text).toContain("概要です");
    // Body chunks threaded under the parent.
    const bodyPosts = posts.filter((p) => p.channel === "C_ST" && p.thread_ts);
    expect(bodyPosts.length).toBeGreaterThan(0);
    // Task handoff got the posted parent ts and the full body.
    expect(handoff).toHaveBeenCalledWith("C_ST", expect.any(String), MINUTES.body, expect.any(Number));
    // Control message in the router thread with the reroute select.
    const control = posts.find((p) => p.channel === ROUTER && p.thread_ts === event.ts);
    expect(control).toBeDefined();

    const state = readState();
    const run = Object.values(state.runs)[0];
    expect(run.status).toBe("tasks_dispatched");
    expect(run.sourceTextHash).toBe(sha256Hex(TRANSCRIPT));
    expect(state.lastMinutesByChannel["C_ST"]).toMatchObject({ title: MINUTES.title });
  });

  it("records handoff-disabled without failing the run", async () => {
    const { pipeline, apiCall } = makePipeline({ handoff: null });
    await pipeline.maybeHandleFileMessage(fileEvent());
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("posted");
    const control = postedMessages(apiCall).find((p) => p.channel === ROUTER);
    expect(control?.text).toContain("タスク自動登録は未接続");
  });
});

describe("routing fallback", () => {
  it("posts a destination select instead of auto-posting when unroutable", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const { pipeline, apiCall, generate } = makePipeline({ classify });
    await pipeline.maybeHandleFileMessage(fileEvent());
    expect(generate).not.toHaveBeenCalled();
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("awaiting_destination");
    const control = postedMessages(apiCall).find((p) => p.channel === ROUTER);
    expect(JSON.stringify(control?.blocks)).toContain("meeting_minutes_choose_destination");
  });

  it("resumes when the operator picks a destination", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const { pipeline, apiCall, generate } = makePipeline({ classify });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);

    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    const run = Object.values(readState().runs)[0];
    expect(run.projectId).toBe("proj_baao");
    expect(run.status).toBe("tasks_dispatched");
    expect(postedMessages(apiCall).some((p) => p.channel === "C_BAAO")).toBe(true);
  });

  it("rejects unauthorized users", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const { pipeline, apiCall, generate } = makePipeline({ classify });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);

    await pipeline.handleChooseDestination(
      { user: { id: "U_INTRUDER" }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    expect(generate).not.toHaveBeenCalled();
    const ephemeral = apiCall.mock.calls.filter(([m]) => m === "chat.postEphemeral");
    expect(ephemeral.length).toBe(1);
  });
});

describe("failures and retry", () => {
  it("marks failed:download and retries from the failed stage", async () => {
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ text: TRANSCRIPT, fileName: "meeting.txt" });
    const { pipeline } = makePipeline({ fetchTranscript });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    expect(readState().runs[key].status).toBe("failed:download");

    await pipeline.handleRetry(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { value: JSON.stringify({ key }) },
    );
    expect(readState().runs[key].status).toBe("tasks_dispatched");
  });

  it("regenerates once on contract violations, then fails loud", async () => {
    const generate = vi.fn().mockResolvedValue({ error: { reason: "body too short" } });
    const { pipeline, apiCall } = makePipeline({ generate });
    await pipeline.maybeHandleFileMessage(fileEvent());
    expect(generate).toHaveBeenCalledTimes(2);
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("failed:generate");
    const control = postedMessages(apiCall).find((p) => p.channel === ROUTER);
    expect(JSON.stringify(control?.blocks)).toContain("meeting_minutes_retry");
  });

  it("marks failed:post when the destination post fails, minutes survive for retry", async () => {
    const { app, apiCall } = makeApp();
    apiCall.mockImplementation(async (method: string, payload: any) => {
      if (method === "chat.postMessage" && payload.channel === "C_ST") {
        throw new Error("not_in_channel");
      }
      return { ok: true, ts: "5000.000001" };
    });
    const pipeline = new MeetingMinutesPipeline(
      app,
      { enabled: true, routerChannels: [ROUTER], destinations: DESTINATIONS },
      [OPERATOR],
      {
        fetchTranscript: vi.fn().mockResolvedValue({ text: TRANSCRIPT, fileName: "m.txt" }) as any,
        classifyImpl: vi.fn().mockResolvedValue({ destination: DESTINATIONS[0], reason: "x" }) as any,
        generateImpl: vi.fn().mockResolvedValue({ minutes: MINUTES }) as any,
        graphClient: makeGraphClient(),
        taskClientFactory: () => makeTaskClient(),
        taskProposalNotifier: { processMinutesText: vi.fn().mockResolvedValue(true) as any },
      },
    );
    pipeline.register();
    await pipeline.maybeHandleFileMessage(fileEvent());
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("failed:post");
    expect(run.minutes?.body).toBe(MINUTES.body);
  });
});

describe("reroute", () => {
  async function postedRun() {
    const built = makePipeline();
    const event = fileEvent();
    await built.pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    built.apiCall.mockClear();
    return { ...built, key };
  }

  it("reposts to the new destination, annotates the old parent, keeps tasks untouched", async () => {
    const { pipeline, apiCall, handoff, key } = await postedRun();
    (handoff as ReturnType<typeof vi.fn>).mockClear();

    await pipeline.handleReroute(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    const posts = postedMessages(apiCall);
    expect(posts.some((p) => p.channel === "C_BAAO" && !p.thread_ts)).toBe(true);
    const updates = postedMessages(apiCall, "chat.update");
    const annotation = updates.find((p) => p.channel === "C_ST");
    expect(annotation?.text).toContain("移動しました");
    // The task handoff must NOT re-run (idempotency keys are bound to the old posting).
    expect(handoff).not.toHaveBeenCalled();

    const run = readState().runs[key];
    expect(run.projectId).toBe("proj_baao");
    expect(run.destinationChannelId).toBe("C_BAAO");
  });

  it("refuses reroute to the run's current destination or from unauthorized users", async () => {
    const { pipeline, apiCall, key } = await postedRun();
    await pipeline.handleReroute(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_salestailor" }) } },
    );
    expect(postedMessages(apiCall).length).toBe(0);

    await pipeline.handleReroute(
      { user: { id: "U_INTRUDER" }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );
    expect(postedMessages(apiCall).length).toBe(0);
  });

  it("refuses reroute before the run is posted", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const { pipeline, apiCall } = makePipeline({ classify });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    apiCall.mockClear();

    await pipeline.handleReroute(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );
    const ephemeral = apiCall.mock.calls.filter(([m]) => m === "chat.postEphemeral");
    expect(ephemeral.length).toBe(1);
    expect(postedMessages(apiCall).some((p) => p.channel === "C_BAAO")).toBe(false);
  });
});
