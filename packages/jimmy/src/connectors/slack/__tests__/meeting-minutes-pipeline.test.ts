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
  ACTION_MM_CHOOSE_DEST_PATTERN,
  ACTION_MM_REFRESH,
  MeetingMinutesPipeline,
  advanceStatus,
  runKey,
  sha256Hex,
  type MinutesRun,
} from "../meeting-minutes-pipeline.js";
import type { GraphEntityClient } from "../../../shared/brainbase-graph.js";
import type { BrainbaseTaskClient } from "../../../shared/brainbase-tasks.js";
import { logger } from "../../../shared/logger.js";

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
  share?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  settingsWebBaseUrl?: string;
  workspaceId?: string;
  /** Test-only convenience: emulate the operator selecting the LLM suggestion. */
  autoConfirm?: boolean;
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
      sourceConnectorInstanceId: "slack",
      shareMinutes: overrides.share as any,
      updateMinutes: overrides.update as any,
      settingsWebBaseUrl: overrides.settingsWebBaseUrl,
      getWorkspaceId: () => overrides.workspaceId,
    },
  );
  pipeline.register();
  if (overrides.autoConfirm !== false) {
    const maybeHandleFileMessage = pipeline.maybeHandleFileMessage.bind(pipeline);
    pipeline.maybeHandleFileMessage = async (message: any) => {
      await maybeHandleFileMessage(message);
      if (!fs.existsSync(STATE_FILE)) return;
      const state = readState();
      const entry = Object.entries(state.runs).find(
        ([, run]) => run.status === "awaiting_destination" && run.suggestedProjectId,
      );
      if (entry) {
        const [key, run] = entry;
        await pipeline.handleChooseDestination(
          { user: { id: OPERATOR }, channel: { id: message.channel } },
          {
            selected_option: {
              value: JSON.stringify({ key, projectId: run.suggestedProjectId }),
            },
          },
        );
      }
    };
  }
  return { pipeline, apiCall, fetchTranscript, classify, generate, handoff, share: overrides.share, update: overrides.update };
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

describe("minutes refresh", () => {
  it("shows the overview and refresh button, then regenerates the same file and updates posts without redispatching tasks", async () => {
    const refreshed = {
      title: "更新後定例",
      overview: "更新後の概要",
      body: "更新後の本文",
    };
    const generate = vi.fn()
      .mockResolvedValueOnce({ minutes: MINUTES })
      .mockResolvedValueOnce({ minutes: refreshed });
    const { pipeline, apiCall, fetchTranscript, handoff } = makePipeline({ generate });
    await pipeline.maybeHandleFileMessage(fileEvent());
    const [key, before] = Object.entries(readState().runs)[0];

    const successUpdate = apiCall.mock.calls
      .filter((call: unknown[]) => call[0] === "chat.update")
      .at(-1)?.[1] as { blocks?: any[] };
    expect(JSON.stringify(successUpdate.blocks)).toContain("📝 会議の概要");
    expect(successUpdate.blocks?.some((block: any) => block.text?.text?.includes(MINUTES.overview))).toBe(true);
    expect(JSON.stringify(successUpdate.blocks)).toContain(ACTION_MM_REFRESH);

    const fetchCountBeforeRefresh = fetchTranscript.mock.calls.length;
    apiCall.mockClear();
    await pipeline.handleRefresh(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { value: JSON.stringify({ key }) },
    );

    expect(fetchTranscript).toHaveBeenCalledTimes(fetchCountBeforeRefresh + 1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledTimes(1);
    const destinationUpdates = apiCall.mock.calls
      .filter((call: unknown[]) => call[0] === "chat.update")
      .map((call: unknown[]) => call[1] as any)
      .filter((payload: any) => payload.channel === "C_ST");
    expect(destinationUpdates.some((payload: any) => payload.ts === before.postedParentTs && payload.text === refreshed.overview)).toBe(true);
    expect(destinationUpdates.some((payload: any) => before.postedThreadTs?.includes(payload.ts) && payload.text === refreshed.body)).toBe(true);
    const after = readState().runs[key];
    expect(after.minutes).toEqual(refreshed);
    expect(after.refresh?.status).toBe("completed");
    expect(readState().lastMinutesByChannel.C_ST).toMatchObject({ overview: refreshed.overview });
  });

  it("rejects unauthorized refreshes before fetching or generating", async () => {
    const { pipeline, fetchTranscript, generate, apiCall } = makePipeline();
    await pipeline.maybeHandleFileMessage(fileEvent());
    const key = Object.keys(readState().runs)[0];
    fetchTranscript.mockClear();
    generate.mockClear();
    await pipeline.handleRefresh(
      { user: { id: "U_INTRUDER" }, channel: { id: ROUTER } },
      { value: JSON.stringify({ key }) },
    );
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(postedMessages(apiCall, "chat.postEphemeral").at(-1)?.text).toContain("権限");
  });

  it("restores the overview and refresh button when regeneration fails", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ minutes: MINUTES })
      .mockResolvedValueOnce({ error: "temporary generation failure" });
    const { pipeline, apiCall } = makePipeline({ generate });
    await pipeline.maybeHandleFileMessage(fileEvent());
    const key = Object.keys(readState().runs)[0];
    apiCall.mockClear();

    await pipeline.handleRefresh(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { value: JSON.stringify({ key }) },
    );

    const controlUpdates = apiCall.mock.calls
      .filter((call: unknown[]) => call[0] === "chat.update")
      .map((call: unknown[]) => call[1] as any)
      .filter((payload: any) => payload.channel === ROUTER);
    const restored = controlUpdates.at(-1);
    expect(restored.text).toContain("既存の議事録は保持");
    expect(JSON.stringify(restored.blocks)).toContain("2026-07-30 定例-要約");
    expect(JSON.stringify(restored.blocks)).toContain(ACTION_MM_REFRESH);
    expect(readState().runs[key].refresh?.status).toBe("failed");
  });

  it("serializes double clicks with the common run lock", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn()
      .mockResolvedValueOnce({ minutes: MINUTES })
      .mockImplementationOnce(async () => { await blocked; return { minutes: { ...MINUTES, overview: "new" } }; });
    const { pipeline, apiCall } = makePipeline({ generate });
    await pipeline.maybeHandleFileMessage(fileEvent());
    const key = Object.keys(readState().runs)[0];
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };
    const action = { value: JSON.stringify({ key }) };
    const first = pipeline.handleRefresh(body, action);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await pipeline.handleRefresh(body, action);
    expect(postedMessages(apiCall, "chat.postEphemeral").at(-1)?.text).toContain("更新中");
    release();
    await first;
    expect(generate).toHaveBeenCalledTimes(2);
  });
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

  it('fails closed when routerChannels contains "*"', async () => {
    const { pipeline, fetchTranscript } = makePipeline({
      config: { routerChannels: ["*", ROUTER] },
    });
    await pipeline.maybeHandleFileMessage(fileEvent());
    expect(fetchTranscript).not.toHaveBeenCalled();
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
    const callsAfterFirstDelivery = fetchTranscript.mock.calls.length;
    await pipeline.maybeHandleFileMessage(event);
    expect(fetchTranscript).toHaveBeenCalledTimes(callsAfterFirstDelivery);
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
    const completedControl = postedMessages(apiCall, "chat.update").at(-1);
    const reroute = completedControl.blocks
      .flatMap((block: any) => block.elements ?? [])
      .find((element: any) => element.action_id === "meeting_minutes_reroute");
    expect(reroute.type).toBe("static_select");
    expect(reroute.confirm).toBeDefined();
    expect(reroute.options[0].text.text).toBe("📁 BAAO");
    expect(JSON.stringify(reroute.options.map((option: any) => option.text))).not.toMatch(/C_BAAO|C_ST/);

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
    const control = postedMessages(apiCall, "chat.update")
      .filter((p) => p.channel === ROUTER)
      .at(-1);
    expect(control?.text).toContain("タスク自動登録は未接続");
  });
});

describe("routing fallback", () => {
  it("requires operator confirmation by default", async () => {
    const { pipeline, apiCall, generate } = makePipeline({
      autoConfirm: false,
    });
    await pipeline.maybeHandleFileMessage(fileEvent());

    expect(Object.values(readState().runs)[0].status).toBe("awaiting_destination");
    expect(generate).not.toHaveBeenCalled();
    expect(postedMessages(apiCall).some((p) => p.channel === "C_ST")).toBe(false);
  });

  it("treats an LLM match as a proposal until an operator confirms it", async () => {
    const { pipeline, apiCall, generate } = makePipeline({
      autoConfirm: false,
    });
    await pipeline.maybeHandleFileMessage(fileEvent());

    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("awaiting_destination");
    expect(run.suggestedProjectId).toBe("proj_salestailor");
    expect(generate).not.toHaveBeenCalled();
    expect(postedMessages(apiCall).some((p) => p.channel === "C_ST")).toBe(false);
  });

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

  it("renders human-readable destination buttons in rows of five", async () => {
    const destinations = Array.from({ length: 6 }, (_, index) => ({
      destinationId: `dest-${index}`,
      projectId: `project-${index}`,
      name: `Project ${index}`,
      ...(index === 0 ? { emoji: "🛡️" } : {}),
      connectorInstanceId: `slack-${index}`,
      workspaceId: `T_INTERNAL_${index}`,
      channelId: `C_INTERNAL_${index}`,
    }));
    const { pipeline, apiCall } = makePipeline({
      autoConfirm: false,
      classify: vi.fn().mockResolvedValue(null),
      config: { destinations },
    });
    await pipeline.maybeHandleFileMessage(fileEvent());

    const control = postedMessages(apiCall).find((p) => p.channel === ROUTER);
    const rows = control.blocks.filter((block: any) => block.type === "actions");
    expect(rows.map((row: any) => row.elements.length)).toEqual([5, 1]);
    const buttons = rows.flatMap((row: any) => row.elements);
    expect(buttons).toHaveLength(6);
    expect(buttons.map((button: any) => button.action_id)).toEqual([
      "meeting_minutes_choose_destination:0:0",
      "meeting_minutes_choose_destination:0:1",
      "meeting_minutes_choose_destination:0:2",
      "meeting_minutes_choose_destination:0:3",
      "meeting_minutes_choose_destination:0:4",
      "meeting_minutes_choose_destination:1:0",
    ]);
    expect(new Set(buttons.map((button: any) => button.action_id)).size).toBe(6);
    expect(buttons.every((button: any) => ACTION_MM_CHOOSE_DEST_PATTERN.test(button.action_id))).toBe(true);
    expect(buttons.every((button: any) => button.type === "button" && button.style === "primary")).toBe(true);
    expect(buttons[0].text).toEqual({ type: "plain_text", text: "🛡️ Project 0", emoji: true });
    expect(buttons[1].text).toEqual({ type: "plain_text", text: "📁 Project 1", emoji: true });
    expect(JSON.parse(buttons[0].value)).toEqual({ key: expect.any(String), destinationId: "dest-0" });
    const visibleText = buttons.map((button: any) => button.text.text).join("\n");
    expect(visibleText).not.toMatch(/T_INTERNAL|C_INTERNAL|slack-|dest-/);
    expect(buttons.some((button: any) => button.type === "static_select")).toBe(false);
  });

  it("registers only the anchored destination-button action pattern", () => {
    expect(ACTION_MM_CHOOSE_DEST_PATTERN.test("meeting_minutes_choose_destination:2:4")).toBe(true);
    expect(ACTION_MM_CHOOSE_DEST_PATTERN.test("xmeeting_minutes_choose_destination:2:4")).toBe(false);
    expect(ACTION_MM_CHOOSE_DEST_PATTERN.test("meeting_minutes_choose_destination:2:4:x")).toBe(false);
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
    expect(run.destinationApprovedBy).toBe(OPERATOR);
    expect(run.destinationApprovedAt).toEqual(expect.any(Number));
    expect(postedMessages(apiCall).some((p) => p.channel === "C_BAAO")).toBe(true);
  });

  it("posts directly to a pre-selected cross-workspace destination without a source copy", async () => {
    const share = vi.fn().mockImplementation(async ({ onProgress }) => {
      onProgress({ parentTs: "9000.1", threadTs: ["9000.2"] });
      return { parentTs: "9000.1" };
    });
    const remote = {
      shareId: "baao-business",
      projectId: "proj_baao",
      name: "事業運営 / BAAO",
      connectorInstanceId: "slack-biz",
      workspaceId: "T_BIZ",
      channelId: "C_BIZ_BAAO",
    };
    const { pipeline, apiCall } = makePipeline({
      autoConfirm: false,
      share,
      classify: vi.fn().mockResolvedValue(null),
      config: { shareDestinations: [remote] },
    });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);

    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, destinationId: remote.shareId }) } },
    );

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ destination: remote }));
    expect(postedMessages(apiCall).some((message) => message.channel === "C_BAAO")).toBe(false);
    expect(postedMessages(apiCall).some((message) => message.channel === "C_BIZ_BAAO")).toBe(false);
    expect(JSON.stringify(postedMessages(apiCall, "chat.update").at(-1)?.blocks)).not.toContain(
      "meeting_minutes_share",
    );
    expect(readState().runs[key]).toMatchObject({
      status: "posted",
      destinationId: remote.shareId,
      destinationConnectorInstanceId: "slack-biz",
      destinationWorkspaceId: "T_BIZ",
      destinationChannelId: "C_BIZ_BAAO",
      postedParentTs: "9000.1",
    });
  });

  it("refreshes a pre-selected cross-workspace destination through the dedicated update port", async () => {
    const remote = {
      shareId: "techknight",
      projectId: "proj_techknight",
      name: "Tech Knight / 議事録",
      connectorInstanceId: "slack-techknight",
      workspaceId: "T_TECH",
      channelId: "C_TECH_MINUTES",
    };
    const share = vi.fn().mockImplementation(async ({ onProgress }) => {
      onProgress({ parentTs: "9000.1", threadTs: ["9000.2"] });
      return { parentTs: "9000.1" };
    });
    const update = vi.fn().mockImplementation(async ({ existing, onProgress }) => {
      onProgress(existing);
      return existing;
    });
    const generate = vi.fn()
      .mockResolvedValueOnce({ minutes: MINUTES })
      .mockResolvedValueOnce({ minutes: { ...MINUTES, overview: "Tech Knight更新概要" } });
    const { pipeline, handoff } = makePipeline({
      autoConfirm: false, share, update, generate,
      classify: vi.fn().mockResolvedValue(null),
      config: { shareDestinations: [remote] },
    });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };
    await pipeline.handleChooseDestination(body, {
      selected_option: { value: JSON.stringify({ key, destinationId: remote.shareId }) },
    });
    await pipeline.handleRefresh(body, { value: JSON.stringify({ key }) });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      destination: remote,
      existing: { parentTs: "9000.1", threadTs: ["9000.2"] },
    }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(handoff).not.toHaveBeenCalled();
    expect(readState().runs[key]).toMatchObject({
      minutes: { overview: "Tech Knight更新概要" },
      refresh: { status: "completed" },
    });
  });

  it("uses the operator choice instead of the LLM proposal", async () => {
    const { pipeline, apiCall, generate } = makePipeline({
      autoConfirm: false,
    });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);

    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(postedMessages(apiCall).some((p) => p.channel === "C_ST")).toBe(false);
    expect(postedMessages(apiCall).some((p) => p.channel === "C_BAAO")).toBe(true);
    expect(readState().runs[key].routingReason).toBe("operator選択");
  });

  it("rejects an action replayed from a different source channel", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const { pipeline, apiCall, generate } = makePipeline({ classify });
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    apiCall.mockClear();

    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: "C_OTHER_ROUTER" } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(postedMessages(apiCall).some((p) => p.channel === "C_BAAO")).toBe(false);
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
  it("never writes raw exception secrets to application logs", async () => {
    const secret = "xoxb-must-not-appear-in-logs";
    const generate = vi.fn().mockRejectedValue(new Error(`provider rejected ${secret}`));
    const { pipeline, apiCall } = makePipeline({ generate });

    await pipeline.maybeHandleFileMessage(fileEvent());

    const logText = [logger.info, logger.warn, logger.error, logger.debug]
      .flatMap((method) => vi.mocked(method).mock.calls)
      .flat()
      .map(String)
      .join("\n");
    expect(logText).not.toContain(secret);
    expect(JSON.stringify(apiCall.mock.calls)).not.toContain(secret);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("code=generation_attempt_failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("code=run_failed"));
  });

  it("does not post thread content when the parent timestamp is missing", async () => {
    const { pipeline, apiCall } = makePipeline();
    apiCall.mockImplementation(async (method: string, payload: any) => {
      if (method === "chat.postMessage" && payload.channel === "C_ST") return { ok: true };
      return { ok: true, ts: "5000.000001" };
    });

    await pipeline.maybeHandleFileMessage(fileEvent());

    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("failed:post");
    expect(postedMessages(apiCall).filter((p) => p.channel === "C_ST")).toHaveLength(1);
  });
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
    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_salestailor" }) } },
    );
    expect(readState().runs[key].status).toBe("tasks_dispatched");
  });

  it("regenerates once on contract violations, then fails loud", async () => {
    const generate = vi.fn().mockResolvedValue({ error: { reason: "body too short" } });
    const { pipeline, apiCall } = makePipeline({
      generate,
      settingsWebBaseUrl: "https://mana.example.com",
      workspaceId: "T_SOURCE",
    });
    await pipeline.maybeHandleFileMessage(fileEvent());
    expect(generate).toHaveBeenCalledTimes(2);
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("failed:generate");
    const control = postedMessages(apiCall, "chat.update")
      .filter((p) => p.channel === ROUTER)
      .at(-1);
    expect(JSON.stringify(control?.blocks)).toContain("meeting_minutes_retry");
    expect(control?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "actions",
        elements: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ text: "構成を確認" }),
            url: "https://mana.example.com/settings/meeting-minutes?workspace=T_SOURCE&project=proj_salestailor&channel=C_ST",
          }),
        ]),
      }),
    ]));
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
      {
        enabled: true,
        routerChannels: [ROUTER],
        destinations: DESTINATIONS,
      },
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
    const event = fileEvent();
    await pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    await pipeline.handleChooseDestination(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_salestailor" }) } },
    );
    const run = Object.values(readState().runs)[0];
    expect(run.status).toBe("failed:post");
    expect(run.minutes?.body).toBe(MINUTES.body);
  });
});

describe("reroute", () => {
  async function postedRun(overrides: Parameters<typeof makePipeline>[0] = {}) {
    const built = makePipeline(overrides);
    const event = fileEvent();
    await built.pipeline.maybeHandleFileMessage(event);
    const key = runKey(ROUTER, "F001", event.ts as string);
    built.apiCall.mockClear();
    return { ...built, key };
  }

  it("reposts to the new destination, scrubs the old post, keeps tasks untouched", async () => {
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
    expect(JSON.stringify(updates.filter((p) => p.channel === "C_ST"))).not.toContain(MINUTES.overview);
    expect(JSON.stringify(updates.filter((p) => p.channel === "C_ST"))).not.toContain(MINUTES.body);
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

  it("adds a safe configuration link for unauthorized and channel-mismatch actions", async () => {
    const { pipeline, apiCall, key } = await postedRun({
      settingsWebBaseUrl: "https://mana.example.com?token=must-not-leak",
      workspaceId: "T_PRIMARY",
    });

    await pipeline.handleReroute(
      { user: { id: "U_INTRUDER" }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );
    await pipeline.handleReroute(
      { user: { id: OPERATOR }, channel: { id: "C_WRONG" } },
      { selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) } },
    );

    const notices = postedMessages(apiCall, "chat.postEphemeral");
    expect(notices).toHaveLength(2);
    expect(notices[0].text).toContain("https://mana.example.com/settings/meeting-minutes?workspace=T_PRIMARY&channel=C_ROUTER");
    expect(notices[1].text).toContain("workspace=T_PRIMARY&project=proj_salestailor&channel=C_ROUTER");
    expect(notices.map((notice) => notice.text).join("\n")).not.toContain("must-not-leak");
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

  it("persists partial reroute progress and refuses an automatic duplicate retry", async () => {
    const { pipeline, apiCall, key } = await postedRun({
      settingsWebBaseUrl: "https://mana.example.com",
      workspaceId: "T_PRIMARY",
    });
    let oldUpdates = 0;
    apiCall.mockImplementation(async (method: string, payload: any) => {
      if (method === "chat.update" && payload.channel === "C_ST" && ++oldUpdates === 2) {
        throw new Error("scrub failed");
      }
      return { ok: true, ts: "7000.000001" };
    });
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };
    const action = {
      selected_option: { value: JSON.stringify({ key, projectId: "proj_baao" }) },
    };

    await pipeline.handleReroute(body, action);
    expect(readState().runs[key].reroute).toMatchObject({
      status: "failed",
      scrubbedMessageTs: [expect.any(String)],
    });
    const callsAfterFailure = apiCall.mock.calls.length;
    await pipeline.handleReroute(body, action);
    expect(apiCall.mock.calls.slice(callsAfterFailure).some(([m]) => m === "chat.update")).toBe(false);
    expect(apiCall.mock.calls.slice(callsAfterFailure).some(([m]) => m === "chat.postMessage")).toBe(false);
    const failureNotice = postedMessages(apiCall, "chat.postEphemeral")
      .find((notice) => notice.text.includes("振り直しに失敗"));
    expect(failureNotice?.text).toContain("workspace=T_PRIMARY&project=proj_baao&channel=C_BAAO");
    expect(failureNotice?.text).not.toContain("scrub failed");
  });
});

describe("explicit cross-workspace share", () => {
  const SHARE_DESTINATION = {
    shareId: "baao-business",
    projectId: "proj_baao",
    name: "事業運営 / BAAO",
    connectorInstanceId: "slack-biz",
    workspaceId: "T_BIZ",
    channelId: "C_BIZ_BAAO",
  };

  async function shareableRun(
    share: ReturnType<typeof vi.fn>,
    shareDestinations = [SHARE_DESTINATION],
  ) {
    const built = makePipeline({
      share,
      classify: vi.fn().mockResolvedValue({ destination: DESTINATIONS[1], reason: "BAAO" }),
      config: { shareDestinations },
      settingsWebBaseUrl: "https://mana.example.com?token=must-not-leak",
      workspaceId: "T_PRIMARY",
    });
    const event = fileEvent();
    await built.pipeline.maybeHandleFileMessage(event);
    return { ...built, key: runKey(ROUTER, "F001", event.ts as string) };
  }

  it("never invokes the target gateway without an explicit operator action", async () => {
    const share = vi.fn().mockResolvedValue({ parentTs: "9000.1" });
    await shareableRun(share);
    expect(share).not.toHaveBeenCalled();
  });

  it("shares generated minutes through the exact target connector after approval", async () => {
    const share = vi.fn().mockResolvedValue({ parentTs: "9000.1" });
    const { pipeline, key } = await shareableRun(share);

    await pipeline.handleShareMinutes(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      { selected_option: { value: JSON.stringify({ key, shareId: SHARE_DESTINATION.shareId }) } },
    );

    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      sourceConnectorInstanceId: "slack",
      destination: SHARE_DESTINATION,
      minutes: MINUTES,
      onProgress: expect.any(Function),
    }));
    expect(JSON.stringify(share.mock.calls)).not.toContain(TRANSCRIPT);
    expect(readState().runs[key].shares?.[SHARE_DESTINATION.shareId]).toMatchObject({
      status: "posted",
      postedParentTs: "9000.1",
      approvedBy: OPERATOR,
    });
  });

  it("fails closed for an unknown destination and dedupes a completed share", async () => {
    const share = vi.fn().mockResolvedValue({ parentTs: "9000.1" });
    const { pipeline, apiCall, key } = await shareableRun(share);
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };

    await pipeline.handleShareMinutes(body, {
      selected_option: { value: JSON.stringify({ key, shareId: "tampered" }) },
    });
    expect(share).not.toHaveBeenCalled();
    const rejected = postedMessages(apiCall, "chat.postEphemeral").at(-1);
    expect(rejected?.text).toContain("workspace=T_PRIMARY&project=proj_baao&channel=C_BAAO");
    expect(rejected?.text).not.toContain("must-not-leak");

    const action = {
      selected_option: { value: JSON.stringify({ key, shareId: SHARE_DESTINATION.shareId }) },
    };
    await pipeline.handleShareMinutes(body, action);
    await pipeline.handleShareMinutes(body, action);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous approvals so the target is called once", async () => {
    let release!: (value: { parentTs: string }) => void;
    const share = vi.fn().mockImplementation(
      () => new Promise<{ parentTs: string }>((resolve) => { release = resolve; }),
    );
    const { pipeline, key } = await shareableRun(share);
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };
    const action = {
      selected_option: { value: JSON.stringify({ key, shareId: SHARE_DESTINATION.shareId }) },
    };

    const first = pipeline.handleShareMinutes(body, action);
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await pipeline.handleShareMinutes(body, action);
    release({ parentTs: "9000.1" });
    await first;

    expect(share).toHaveBeenCalledTimes(1);
  });

  it("locks the whole run when two different share targets are clicked together", async () => {
    const secondDestination = {
      ...SHARE_DESTINATION,
      shareId: "baao-second",
      name: "事業運営 / BAAO backup",
      channelId: "C_BIZ_BAAO_2",
    };
    let release!: (value: { parentTs: string }) => void;
    const share = vi.fn().mockImplementation(
      () => new Promise<{ parentTs: string }>((resolve) => { release = resolve; }),
    );
    const { pipeline, key } = await shareableRun(share, [SHARE_DESTINATION, secondDestination]);
    const body = { user: { id: OPERATOR }, channel: { id: ROUTER } };
    const action = (shareId: string) => ({
      selected_option: { value: JSON.stringify({ key, shareId }) },
    });

    const first = pipeline.handleShareMinutes(body, action(SHARE_DESTINATION.shareId));
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await pipeline.handleShareMinutes(body, action(secondDestination.shareId));
    release({ parentTs: "9000.1" });
    await first;

    expect(share).toHaveBeenCalledTimes(1);
    expect(readState().runs[key].shares?.[secondDestination.shareId]).toBeUndefined();
  });

  it("retains target timestamps when a shared body fails partway", async () => {
    const share = vi.fn().mockImplementation(async (request: any) => {
      request.onProgress({ parentTs: "9000.1", threadTs: ["9000.2"] });
      throw new Error("second chunk failed");
    });
    const { pipeline, apiCall, key } = await shareableRun(share);

    await pipeline.handleShareMinutes(
      { user: { id: OPERATOR }, channel: { id: ROUTER } },
      {
        selected_option: {
          value: JSON.stringify({ key, shareId: SHARE_DESTINATION.shareId }),
        },
      },
    );

    expect(readState().runs[key].shares?.[SHARE_DESTINATION.shareId]).toMatchObject({
      status: "failed",
      postedParentTs: "9000.1",
      postedThreadTs: ["9000.2"],
    });
    const failure = postedMessages(apiCall).at(-1);
    expect(failure?.text).toContain("workspace=T_BIZ&project=proj_baao&channel=C_BIZ_BAAO");
    expect(failure?.text).not.toContain("second chunk failed");
  });
});
