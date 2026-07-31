import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-development-reconciler-test",
  DEVELOPMENT_PENDING_FILE: "/tmp/openryoko-development-reconciler-test/state/development-pending.json",
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { recordPendingDevelopmentRun, listPendingDevelopmentRuns } from "../development-pending.js";
import { findSpoolFile, reconcilePendingDevelopmentRuns } from "../development-reconciler.js";
import type { Connector, JinnConfig, Target } from "../../shared/types.js";
import type { DevelopmentResult } from "../development-runner.js";

const STATE_DIR = "/tmp/openryoko-development-reconciler-test";
const SPOOL_DIR = path.join(STATE_DIR, "spool");

function baseConfig(overrides: Partial<NonNullable<JinnConfig["developmentRunner"]>> = {}): JinnConfig {
  return {
    developmentRunner: {
      enabled: true,
      bin: "/usr/bin/sudo",
      allowedSlackChannels: ["C1"],
      resultsSpoolDir: SPOOL_DIR,
      ...overrides,
    },
  } as unknown as JinnConfig;
}

function fakeConnector(name = "slack") {
  return {
    name,
    replyMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connector & { replyMessage: ReturnType<typeof vi.fn> };
}

function writeSpool(storyId: string, result: Record<string, unknown>, finishedAt = new Date().toISOString()) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true });
  fs.writeFileSync(path.join(SPOOL_DIR, `${storyId}.json`), JSON.stringify({ ...result, storyId, finishedAt, runnerPid: 1 }));
}

describe("development-reconciler", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("no-ops entirely when resultsSpoolDir is not configured", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-a",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig({ resultsSpoolDir: undefined }), {
      connectorProvider: () => new Map([["slack", fakeConnector()]]),
      isInFlight: () => false,
      deliverResult,
    });
    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  it("delivers a needs_decision result found by direct storyId spool lookup and removes the pending record", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-decide",
      connectorName: "slack",
      channel: "C1",
      thread: "T1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-decide", {
      status: "needs_decision",
      summary: "need answers",
      questions: [{ id: "q1", question: "which?", options: [], allow_free_text: true }],
    });

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(1);
    const [result, deliveredConnector, target] = deliverResult.mock.calls[0] as [DevelopmentResult, Connector, Target];
    expect(result.status).toBe("needs_decision");
    expect(result.storyId).toBe("story-decide");
    expect(deliveredConnector).toBe(connector);
    expect(target).toEqual({ channel: "C1", thread: "T1" });
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("delivers a needs_input gate-result and a pr_ready result the same way", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-gates",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "continue",
    });
    recordPendingDevelopmentRun({
      storyId: "story-ready",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-gates", {
      status: "needs_input",
      summary: "1 gate(s) remain",
      gates: [{ severity: "critical", text: "missing evidence" }],
      commits: { count: 1, subjects: ["fix: x"] },
    });
    writeSpool("story-ready", {
      status: "pr_ready",
      summary: "ready",
      commits: { count: 2, subjects: ["fix: y"] },
    });

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(2);
    const statuses = deliverResult.mock.calls.map((call) => (call[0] as DevelopmentResult).status).sort();
    expect(statuses).toEqual(["needs_input", "pr_ready"]);
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("matches a brand-new pending run's spool file by the request digest embedded in the generated Story id", async () => {
    recordPendingDevelopmentRun({
      storyId: null,
      requestDigest: "deadbeef",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "new",
    });
    // Also write a decoy with a different digest to prove exact matching.
    writeSpool("story-slack-20260731000000-cafef00d", { status: "pr_ready", summary: "decoy" });
    writeSpool("story-slack-20260731000000-deadbeef", { status: "pr_ready", summary: "matched" });

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(1);
    const [result] = deliverResult.mock.calls[0] as [DevelopmentResult];
    expect(result.storyId).toBe("story-slack-20260731000000-deadbeef");
    expect(result.summary).toBe("matched");
  });

  it("falls back to the newest finishedAt-after-startedAt spool file when no digest match exists", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    recordPendingDevelopmentRun({
      storyId: null,
      requestDigest: "notfound",
      connectorName: "slack",
      channel: "C1",
      startedAt,
      kind: "new",
    });
    // A spool result that finished BEFORE this run started must be ignored.
    writeSpool("story-slack-old-11111111", { status: "pr_ready", summary: "stale" }, new Date(Date.now() - 120_000).toISOString());
    // The only candidate that finished after startedAt.
    writeSpool("story-slack-new-22222222", { status: "pr_ready", summary: "fallback match" }, new Date().toISOString());

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(1);
    const [result] = deliverResult.mock.calls[0] as [DevelopmentResult];
    expect(result.summary).toBe("fallback match");
  });

  it("skips the currently in-flight run so pipe delivery and the reconciler never race", async () => {
    const runId = recordPendingDevelopmentRun({
      storyId: "story-live",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-live", { status: "pr_ready", summary: "should not be delivered by the sweep" });

    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", fakeConnector()]]),
      isInFlight: (run) => run.runId === runId,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  it("keeps the pending record when the connector is not currently registered", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-orphan-connector",
      connectorName: "discord",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-orphan-connector", { status: "pr_ready", summary: "ok" });

    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map(), // discord not registered
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  it("posts an interruption notice and gives up on the pending record once the timeout + grace period has elapsed with no spool", async () => {
    const longAgo = new Date(Date.now() - (90 * 60 * 1000 + 11 * 60 * 1000)).toISOString();
    recordPendingDevelopmentRun({
      storyId: "story-orphaned",
      connectorName: "slack",
      channel: "C1",
      thread: "T9",
      startedAt: longAgo,
      kind: "resume",
    });

    const connector = fakeConnector();
    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(connector.replyMessage).toHaveBeenCalledTimes(1);
    expect((connector.replyMessage.mock.calls[0] as unknown[])[1]).toContain("中断されました");
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("does not time out a run that is still well within the timeout window", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-recent",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });

    const connector = fakeConnector();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult: vi.fn(),
    });

    expect(connector.replyMessage).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  it("leaves an unparseable spool file and its pending record in place for operator inspection", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-corrupt",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    fs.writeFileSync(path.join(SPOOL_DIR, "story-corrupt.json"), "{ not valid json");

    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", fakeConnector()]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });
});

describe("findSpoolFile", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("returns null for a known storyId with no matching spool file", async () => {
    const found = await findSpoolFile(SPOOL_DIR, {
      runId: "r1",
      storyId: "story-missing",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    expect(found).toBeNull();
  });

  it("returns null when the spool directory itself does not exist", async () => {
    const found = await findSpoolFile(path.join(SPOOL_DIR, "does-not-exist"), {
      runId: "r1",
      storyId: null,
      requestDigest: "abc",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "new",
    });
    expect(found).toBeNull();
  });
});
