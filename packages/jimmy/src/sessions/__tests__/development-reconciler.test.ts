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
import { findSpoolFile, reconcilePendingDevelopmentRuns, resolveTargetConnector } from "../development-reconciler.js";
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

function fakeConnector(name = "slack", instanceId?: string) {
  return {
    name,
    ...(instanceId ? { instanceId } : {}),
    replyMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connector & { replyMessage: ReturnType<typeof vi.fn> };
}

function readPersistedState(): Record<string, { deliveryAttempts?: number }> {
  return JSON.parse(fs.readFileSync(path.join(STATE_DIR, "state", "development-pending.json"), "utf-8"));
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

describe("multi-instance connector resolution (e.g. two Slack workspaces)", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("delivers to the exact instance by connectorInstanceId even though multiple connectors share the same name", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-biz",
      connectorName: "slack",
      connectorInstanceId: "slack-biz",
      channel: "C-biz",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-biz", { status: "pr_ready", summary: "ready" });

    // Both instances report name "slack" (real SlackConnector behavior) —
    // only the registry key ("slack" vs "slack-biz") tells them apart.
    const defaultInstance = fakeConnector("slack", "slack");
    const bizInstance = fakeConnector("slack", "slack-biz");
    const deliverResult = vi.fn().mockResolvedValue(undefined);
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", defaultInstance], ["slack-biz", bizInstance]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(1);
    const [, deliveredConnector] = deliverResult.mock.calls[0] as [DevelopmentResult, Connector, Target];
    expect(deliveredConnector).toBe(bizInstance);
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("holds the record when connectorInstanceId is set but that instance is no longer registered, instead of guessing by name", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-biz-gone",
      connectorName: "slack",
      connectorInstanceId: "slack-biz",
      channel: "C-biz",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-biz-gone", { status: "pr_ready", summary: "ready" });

    // Only the default "slack" instance is registered — "slack-biz" is gone.
    // A name-based fallback would wrongly pick the default instance here.
    const defaultInstance = fakeConnector("slack", "slack");
    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", defaultInstance]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  it("holds a legacy record (no connectorInstanceId) when multiple registered connectors share its connectorName", async () => {
    recordPendingDevelopmentRun({
      storyId: "story-ambiguous",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-ambiguous", { status: "pr_ready", summary: "ready" });

    const defaultInstance = fakeConnector("slack", "slack");
    const bizInstance = fakeConnector("slack", "slack-biz");
    const deliverResult = vi.fn();
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", defaultInstance], ["slack-biz", bizInstance]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).not.toHaveBeenCalled();
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
  });

  describe("resolveTargetConnector (unit)", () => {
    it("resolves strictly by connectorInstanceId, ignoring name-sharing connectors", () => {
      const a = fakeConnector("slack", "slack");
      const b = fakeConnector("slack", "slack-biz");
      const map = new Map([["slack", a], ["slack-biz", b]]);
      expect(resolveTargetConnector(map, {
        runId: "r1", storyId: null, connectorName: "slack", connectorInstanceId: "slack-biz",
        channel: "C1", startedAt: new Date().toISOString(), kind: "resume",
      })).toBe(b);
    });

    it("returns undefined when connectorInstanceId is set but absent from the map", () => {
      const map = new Map([["slack", fakeConnector("slack", "slack")]]);
      expect(resolveTargetConnector(map, {
        runId: "r1", storyId: null, connectorName: "slack", connectorInstanceId: "slack-biz",
        channel: "C1", startedAt: new Date().toISOString(), kind: "resume",
      })).toBeUndefined();
    });

    it("falls back to a unique name match when connectorInstanceId is absent", () => {
      const only = fakeConnector("discord");
      const map = new Map([["discord", only]]);
      expect(resolveTargetConnector(map, {
        runId: "r1", storyId: null, connectorName: "discord",
        channel: "C1", startedAt: new Date().toISOString(), kind: "resume",
      })).toBe(only);
    });

    it("returns undefined for an ambiguous or absent name match when connectorInstanceId is unset", () => {
      const map = new Map([["slack", fakeConnector("slack")], ["slack-biz", fakeConnector("slack")]]);
      expect(resolveTargetConnector(map, {
        runId: "r1", storyId: null, connectorName: "slack",
        channel: "C1", startedAt: new Date().toISOString(), kind: "resume",
      })).toBeUndefined();
      expect(resolveTargetConnector(new Map(), {
        runId: "r1", storyId: null, connectorName: "slack",
        channel: "C1", startedAt: new Date().toISOString(), kind: "resume",
      })).toBeUndefined();
    });
  });
});

describe("delivery-failure retry accounting", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("keeps the pending record and increments deliveryAttempts when result delivery throws", async () => {
    const runId = recordPendingDevelopmentRun({
      storyId: "story-flaky",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-flaky", { status: "pr_ready", summary: "ready" });

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockRejectedValue(new Error("Slack API error"));
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    });

    expect(deliverResult).toHaveBeenCalledTimes(1);
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
    expect(readPersistedState()[runId].deliveryAttempts).toBe(1);
  });

  it("gives up and removes the record once delivery has failed MAX_DELIVERY_ATTEMPTS (10) times", async () => {
    const runId = recordPendingDevelopmentRun({
      storyId: "story-doomed",
      connectorName: "slack",
      channel: "C1",
      startedAt: new Date().toISOString(),
      kind: "resume",
    });
    writeSpool("story-doomed", { status: "pr_ready", summary: "ready" });

    const connector = fakeConnector();
    const deliverResult = vi.fn().mockRejectedValue(new Error("Slack API error"));
    const deps = {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult,
    };

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await reconcilePendingDevelopmentRuns(baseConfig(), deps);
      expect(listPendingDevelopmentRuns()).toHaveLength(1);
      expect(readPersistedState()[runId].deliveryAttempts).toBe(attempt);
    }

    // The 10th failure crosses MAX_DELIVERY_ATTEMPTS and gives up.
    await reconcilePendingDevelopmentRuns(baseConfig(), deps);
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("keeps the pending record and increments deliveryAttempts when the interruption notice post throws", async () => {
    const longAgo = new Date(Date.now() - (90 * 60 * 1000 + 11 * 60 * 1000)).toISOString();
    const runId = recordPendingDevelopmentRun({
      storyId: "story-notice-flaky",
      connectorName: "slack",
      channel: "C1",
      startedAt: longAgo,
      kind: "resume",
    });

    const connector = fakeConnector();
    connector.replyMessage.mockRejectedValue(new Error("channel_not_found"));
    await reconcilePendingDevelopmentRuns(baseConfig(), {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult: vi.fn(),
    });

    expect(connector.replyMessage).toHaveBeenCalledTimes(1);
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
    expect(readPersistedState()[runId].deliveryAttempts).toBe(1);
  });

  it("gives up on a timed-out run once the interruption notice has failed MAX_DELIVERY_ATTEMPTS (10) times", async () => {
    const longAgo = new Date(Date.now() - (90 * 60 * 1000 + 11 * 60 * 1000)).toISOString();
    recordPendingDevelopmentRun({
      storyId: "story-notice-doomed",
      connectorName: "slack",
      channel: "C1",
      startedAt: longAgo,
      kind: "resume",
    });

    const connector = fakeConnector();
    connector.replyMessage.mockRejectedValue(new Error("channel_not_found"));
    const deps = {
      connectorProvider: () => new Map([["slack", connector]]),
      isInFlight: () => false,
      deliverResult: vi.fn(),
    };

    for (let i = 0; i < 9; i += 1) {
      await reconcilePendingDevelopmentRuns(baseConfig(), deps);
      expect(listPendingDevelopmentRuns()).toHaveLength(1);
    }
    await reconcilePendingDevelopmentRuns(baseConfig(), deps);
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
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
