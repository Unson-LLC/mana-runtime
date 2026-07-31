import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-development-pending-test",
  DEVELOPMENT_PENDING_FILE: "/tmp/openryoko-development-pending-test/state/development-pending.json",
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  listPendingDevelopmentRuns,
  recordPendingDevelopmentRun,
  removePendingDevelopmentRun,
  recordDeliveryFailure,
} from "../development-pending.js";

const STATE_DIR = "/tmp/openryoko-development-pending-test";
const STATE_FILE = path.join(STATE_DIR, "state", "development-pending.json");

describe("development-pending", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("returns an empty list when the state file does not exist yet", () => {
    expect(listPendingDevelopmentRuns()).toEqual([]);
  });

  it("records a new pending run, creating the state directory, and returns a runId", () => {
    const runId = recordPendingDevelopmentRun({
      storyId: null,
      requestDigest: "abcd1234",
      connectorName: "slack",
      channel: "C1",
      thread: "T1",
      startedAt: "2026-07-31T00:00:00.000Z",
      kind: "new",
    });
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);

    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    expect(persisted[runId]).toMatchObject({
      runId,
      storyId: null,
      requestDigest: "abcd1234",
      connectorName: "slack",
      channel: "C1",
      thread: "T1",
      kind: "new",
    });
  });

  it("lists pending runs oldest-first", () => {
    recordPendingDevelopmentRun({
      storyId: "story-b",
      connectorName: "slack",
      channel: "C1",
      startedAt: "2026-07-31T00:05:00.000Z",
      kind: "resume",
    });
    recordPendingDevelopmentRun({
      storyId: "story-a",
      connectorName: "slack",
      channel: "C1",
      startedAt: "2026-07-31T00:00:00.000Z",
      kind: "resume",
    });
    const runs = listPendingDevelopmentRuns();
    expect(runs.map((r) => r.storyId)).toEqual(["story-a", "story-b"]);
  });

  it("removes a pending run by runId", () => {
    const runId = recordPendingDevelopmentRun({
      storyId: "story-x",
      connectorName: "slack",
      channel: "C1",
      startedAt: "2026-07-31T00:00:00.000Z",
      kind: "continue",
    });
    expect(listPendingDevelopmentRuns()).toHaveLength(1);
    removePendingDevelopmentRun(runId);
    expect(listPendingDevelopmentRuns()).toHaveLength(0);
  });

  it("removing an unknown runId is a no-op", () => {
    expect(() => removePendingDevelopmentRun("does-not-exist")).not.toThrow();
    expect(listPendingDevelopmentRuns()).toEqual([]);
  });

  it("fails closed to an empty list when the state file is corrupt", () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, "not json");
    expect(listPendingDevelopmentRuns()).toEqual([]);
  });

  it("persists connectorInstanceId alongside the backwards-compatible connectorName", () => {
    const runId = recordPendingDevelopmentRun({
      storyId: null,
      requestDigest: "abcd1234",
      connectorName: "slack",
      connectorInstanceId: "slack-biz",
      channel: "C1",
      thread: "T1",
      startedAt: "2026-07-31T00:00:00.000Z",
      kind: "new",
    });
    const [run] = listPendingDevelopmentRuns();
    expect(run.runId).toBe(runId);
    expect(run.connectorName).toBe("slack");
    expect(run.connectorInstanceId).toBe("slack-biz");
  });

  it("reads a legacy record with no connectorInstanceId/deliveryAttempts field without breaking", () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      "legacy-run": {
        runId: "legacy-run",
        storyId: "story-legacy",
        connectorName: "slack",
        channel: "C1",
        startedAt: "2026-07-31T00:00:00.000Z",
        kind: "resume",
      },
    }));
    const [run] = listPendingDevelopmentRuns();
    expect(run.connectorInstanceId).toBeUndefined();
    expect(run.deliveryAttempts).toBeUndefined();
  });

  describe("recordDeliveryFailure", () => {
    it("increments deliveryAttempts from unset, persisting the new count", () => {
      const runId = recordPendingDevelopmentRun({
        storyId: "story-x",
        connectorName: "slack",
        channel: "C1",
        startedAt: "2026-07-31T00:00:00.000Z",
        kind: "resume",
      });
      expect(recordDeliveryFailure(runId)).toBe(1);
      expect(recordDeliveryFailure(runId)).toBe(2);

      const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      expect(persisted[runId].deliveryAttempts).toBe(2);
    });

    it("returns null and does nothing for an unknown runId", () => {
      expect(recordDeliveryFailure("does-not-exist")).toBeNull();
      expect(listPendingDevelopmentRuns()).toEqual([]);
    });
  });
});
