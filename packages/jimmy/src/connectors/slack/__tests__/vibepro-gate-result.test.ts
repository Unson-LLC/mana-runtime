import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-vibepro-gate-result-test",
}));
vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  VibeproGateResultNotifier,
  buildGateResultBlocks,
  buildGateDetailChunks,
  gateResultFallbackText,
  ACTION_CONTINUE_GATES,
  ACTION_GATE_DETAILS,
} from "../vibepro-gate-result.js";
import type { DevelopmentCommits, DevelopmentGate } from "../../../shared/types.js";

const STATE_DIR = "/tmp/openryoko-vibepro-gate-result-test";
const STATE_FILE = path.join(STATE_DIR, ".vibepro-gate-results.json");
const ALLOWED_USER = "U_ALLOWED";

const GATES: DevelopmentGate[] = [
  { severity: "critical", text: "必須設計図が不足: threat_model" },
  { severity: "evidence", text: "10 non-critical unresolved gate(s) require evidence or an auditable waiver." },
  { severity: "evidence", text: "review not yet dispatched for gate_evidence" },
];

const COMMITS: DevelopmentCommits = { count: 3, subjects: ["feat: add thing", "fix: adjust thing"] };

function makeApp() {
  const apiCall = vi.fn().mockResolvedValue({ ok: true, ts: "1234.000001" });
  const app = {
    client: { apiCall },
    action: vi.fn(),
    view: vi.fn(),
  } as unknown as App & { action: ReturnType<typeof vi.fn>; view: ReturnType<typeof vi.fn> };
  return { app, apiCall };
}

function makeNotifier(overrides: { allowFrom?: string[]; continueGates?: ReturnType<typeof vi.fn> } = {}) {
  const { app, apiCall } = makeApp();
  const continueGates = overrides.continueGates ?? vi.fn().mockReturnValue(true);
  const notifier = new VibeproGateResultNotifier(app, overrides.allowFrom ?? [ALLOWED_USER], {
    continueGates: continueGates as unknown as (storyId: string, target: any) => boolean,
  });
  notifier.register();
  return { notifier, app, apiCall, continueGates };
}

describe("vibepro-gate-result block builders", () => {
  it("shows the commits section and header when commits are present", () => {
    const blocks = buildGateResultBlocks("story-x", GATES, COMMITS);
    const text = JSON.stringify(blocks);
    expect(text).toContain("実装は進みましたが");
    expect(text).toContain("commit 3件");
    expect(text).toContain("feat: add thing");
    expect(text).toContain("fix: adjust thing");
    expect(text).toContain(ACTION_CONTINUE_GATES);
    expect(text).toContain(ACTION_GATE_DETAILS);
  });

  it("uses the no-commits header and omits the commits section when there are no commits", () => {
    const blocks = buildGateResultBlocks("story-x", GATES, { count: 0, subjects: [] });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Gate未解決のため停止しました");
    expect(text).not.toContain("ここまでの成果");
  });

  it("omits the commits section entirely when commits is undefined", () => {
    const blocks = buildGateResultBlocks("story-x", GATES);
    expect(JSON.stringify(blocks)).not.toContain("ここまでの成果");
  });

  it("shows counts by severity and truncates the card to 3 gates with a details pointer", () => {
    const blocks = buildGateResultBlocks("story-x", GATES);
    const text = JSON.stringify(blocks);
    expect(text).toContain("残Gate 3件（critical 1 / evidence 2）");
    // All 3 fit within the card limit here, so no "他 N 件" pointer.
    expect(text).not.toContain("他 ");

    const manyGates: DevelopmentGate[] = Array.from({ length: 5 }, (_, i) => ({
      severity: "evidence" as const,
      text: `gate ${i}`,
    }));
    const manyBlocks = buildGateResultBlocks("story-x", manyGates);
    const manyText = JSON.stringify(manyBlocks);
    expect(manyText).toContain("他 2 件");
  });

  it("sorts critical gates ahead of evidence gates on the card", () => {
    const gates: DevelopmentGate[] = [
      { severity: "evidence", text: "evidence one" },
      { severity: "critical", text: "critical one" },
    ];
    const blocks = buildGateResultBlocks("story-x", gates);
    const text = JSON.stringify(blocks);
    expect(text.indexOf("critical one")).toBeLessThan(text.indexOf("evidence one"));
  });

  it("splits gate details into severity-grouped chunks", () => {
    const chunks = buildGateDetailChunks(GATES);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("critical（1件）");
    expect(chunks[0]).toContain("evidence（2件）");
    expect(chunks[0]).toContain("必須設計図が不足");
  });

  it("splits into multiple chunks when the combined text exceeds the Slack message limit", () => {
    const bigGates: DevelopmentGate[] = Array.from({ length: 20 }, (_, i) => ({
      severity: "evidence" as const,
      text: "x".repeat(400) + i,
    }));
    const chunks = buildGateDetailChunks(bigGates);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3800);
  });

  it("renders a bounded fallback text with commit and gate counts", () => {
    expect(gateResultFallbackText("story-x", GATES, COMMITS)).toContain("commit 3件");
    expect(gateResultFallbackText("story-x", GATES, COMMITS)).toContain("残Gate 3件");
    expect(gateResultFallbackText("story-x", GATES, { count: 0, subjects: [] })).toContain("実装なし");
  });
});

describe("VibeproGateResultNotifier", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("does not register Bolt listeners when allowFrom is empty (fail-closed)", () => {
    const { app } = makeNotifier({ allowFrom: [] });
    expect(app.action).not.toHaveBeenCalled();
  });

  it("posts the gate result card and persists the pending result", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);

    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      channel: "C1",
      thread_ts: "T1",
      blocks: expect.any(Array),
    }));
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    expect(state["story-x"].gates).toEqual(GATES);
    expect(state["story-x"].commits).toEqual(COMMITS);
  });

  it("posts a plain-text fallback when inactive (no allowFrom)", async () => {
    const { app, apiCall } = makeApp();
    const notifier = new VibeproGateResultNotifier(app, [], { continueGates: vi.fn() });
    // Not registered / inactive because allowFrom is empty.
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      channel: "C1",
      thread_ts: "T1",
      text: expect.stringContaining("Gate未解決"),
    }));
    expect(apiCall.mock.calls[0][1].blocks).toBeUndefined();
  });

  it("starts the continue-gates round for an authorized user and marks it started", async () => {
    const continueGates = vi.fn().mockReturnValue(true);
    const { notifier, apiCall } = makeNotifier({ continueGates });
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);

    await notifier.handleContinue(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" } },
      { value: "story-x" },
    );

    expect(continueGates).toHaveBeenCalledWith("story-x", { channel: "C1", thread: "T1" });
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      text: expect.stringContaining("Gate解消ラウンドを開始します"),
    }));
    const stored = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))["story-x"];
    expect(stored.continueRequestedAt).toEqual(expect.any(Number));
  });

  it("rejects a continue request from a user outside allowFrom", async () => {
    const continueGates = vi.fn();
    const { notifier, apiCall } = makeNotifier({ continueGates });
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);

    await notifier.handleContinue(
      { user: { id: "U_STRANGER" }, channel: { id: "C1" } },
      { value: "story-x" },
    );

    expect(continueGates).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      user: "U_STRANGER",
      text: expect.stringContaining("権限がありません"),
    }));
  });

  it("tells the user the session expired when no pending result matches the storyId", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.handleContinue(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" } },
      { value: "story-unknown" },
    );
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      text: expect.stringContaining("期限切れ"),
    }));
  });

  it("tells the user development is busy when continueGates reports it could not start", async () => {
    const continueGates = vi.fn().mockReturnValue(false);
    const { notifier, apiCall } = makeNotifier({ continueGates });
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);

    await notifier.handleContinue(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" } },
      { value: "story-x" },
    );

    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      text: expect.stringContaining("続行できません"),
    }));
  });

  it("reports already-started (not expired) on a second continue press", async () => {
    const continueGates = vi.fn().mockReturnValue(true);
    const { notifier, apiCall } = makeNotifier({ continueGates });
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);
    await notifier.handleContinue({ user: { id: ALLOWED_USER }, channel: { id: "C1" } }, { value: "story-x" });
    apiCall.mockClear();
    continueGates.mockClear();

    await notifier.handleContinue({ user: { id: ALLOWED_USER }, channel: { id: "C1" } }, { value: "story-x" });

    expect(continueGates).not.toHaveBeenCalled();
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      text: expect.stringContaining("開始済み"),
    }));
  });

  it("posts the full gate detail chunks for an authorized user", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);

    await notifier.handleDetails(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" } },
      { value: "story-x" },
    );

    const detailCalls = apiCall.mock.calls.filter((call) => call[0] === "chat.postMessage" && !call[1].blocks);
    expect(detailCalls.length).toBeGreaterThan(0);
    expect(detailCalls[0][1].text).toContain("必須設計図が不足");
  });

  it("rejects a details request from a user outside allowFrom", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postResult({ channel: "C1", thread: "T1" }, "story-x", GATES, COMMITS);
    apiCall.mockClear();

    await notifier.handleDetails(
      { user: { id: "U_STRANGER" }, channel: { id: "C1" } },
      { value: "story-x" },
    );

    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({ user: "U_STRANGER" }));
    expect(apiCall).not.toHaveBeenCalledWith("chat.postMessage", expect.anything());
  });
});
