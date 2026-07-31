import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const runDevelopmentRequest = vi.hoisted(() => vi.fn());
vi.mock("../development-runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../development-runner.js")>(),
  runDevelopmentRequest,
}));

const recordPendingDevelopmentRun = vi.hoisted(() => vi.fn());
const removePendingDevelopmentRun = vi.hoisted(() => vi.fn());
vi.mock("../development-pending.js", () => ({
  recordPendingDevelopmentRun,
  removePendingDevelopmentRun,
}));

const reconcilePendingDevelopmentRuns = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../development-reconciler.js", () => ({
  reconcilePendingDevelopmentRuns,
}));

import { SessionManager } from "../manager.js";
import type { Connector, IncomingMessage, JinnConfig } from "../../shared/types.js";

function config(): JinnConfig {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "sonnet" },
      codex: { bin: "codex", model: "" },
    },
    connectors: {},
    logging: { level: "info", stdout: false, file: "" },
    developmentRunner: {
      enabled: true,
      bin: "/usr/bin/sudo",
      allowedSlackChannels: ["C1"],
      resultsSpoolDir: "/srv/openryoko-development/results",
    },
  } as unknown as JinnConfig;
}

function message(text: string): IncomingMessage {
  return {
    source: "slack",
    connector: "slack",
    sessionKey: "slack:C1:T1",
    channel: "C1",
    thread: "T1",
    user: "U1",
    userId: "U1",
    text,
    replyContext: { channel: "C1", threadTs: "T1" },
    attachments: [],
    raw: {},
  } as unknown as IncomingMessage;
}

function connector(extra: Partial<Connector> = {}): Connector {
  return {
    name: "slack",
    start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    reconstructTarget: vi.fn(() => ({ channel: "C1", thread: "T1" })),
    ...extra,
  } as unknown as Connector;
}

describe("SessionManager development-pending bookkeeping", () => {
  const target = { channel: "C1", thread: "T1" };

  beforeEach(() => {
    runDevelopmentRequest.mockReset();
    recordPendingDevelopmentRun.mockReset().mockReturnValue("run-id-1");
    removePendingDevelopmentRun.mockReset();
    reconcilePendingDevelopmentRuns.mockReset().mockResolvedValue(undefined);
  });

  it("records a new /vibepro request with kind:new, storyId:null, and the runner's own digest algorithm", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    await manager.handleCommand(message("/develop  change docs  "), slack);
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalled());

    expect(recordPendingDevelopmentRun).toHaveBeenCalledTimes(1);
    const recorded = recordPendingDevelopmentRun.mock.calls[0][0];
    expect(recorded.storyId).toBeNull();
    expect(recorded.kind).toBe("new");
    expect(recorded.connectorName).toBe("slack");
    expect(recorded.channel).toBe("C1");
    expect(recorded.thread).toBe("T1");
    expect(typeof recorded.startedAt).toBe("string");
    // Must match the same sha256(request.trim()).slice(0,8) the isolated
    // runner computes to embed in the Story id it generates.
    expect(recorded.requestDigest).toBe(createHash("sha256").update("change docs").digest("hex").slice(0, 8));
  });

  it("records a resume request with kind:resume and the known storyId", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    manager.resumeDevelopmentDecision("story-x", [{ id: "q1", answer: "a" }], slack, target);
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalled());

    const recorded = recordPendingDevelopmentRun.mock.calls[0][0];
    expect(recorded).toMatchObject({ storyId: "story-x", kind: "resume", connectorName: "slack", channel: "C1", thread: "T1" });
    expect(recorded.requestDigest).toBeUndefined();
  });

  it("records a continueGates request with kind:continue", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    manager.continueDevelopmentGates("story-x", slack, target);
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalled());

    const recorded = recordPendingDevelopmentRun.mock.calls[0][0];
    expect(recorded).toMatchObject({ storyId: "story-x", kind: "continue" });
  });

  it("removes the pending record after delivery, and only after delivery has been attempted", async () => {
    let resolveRun!: (value: unknown) => void;
    runDevelopmentRequest.mockReturnValueOnce(new Promise((done) => { resolveRun = done; }));
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    manager.continueDevelopmentGates("story-y", slack, target);
    expect(recordPendingDevelopmentRun).toHaveBeenCalledTimes(1);
    expect(removePendingDevelopmentRun).not.toHaveBeenCalled();

    resolveRun({ status: "pr_ready", storyId: "story-y", summary: "ready" });
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalledWith("run-id-1"));
  });

  it("removes the pending record even when the runner promise rejects", async () => {
    runDevelopmentRequest.mockRejectedValueOnce(new Error("boom"));
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    manager.continueDevelopmentGates("story-z", slack, target);
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalledWith("run-id-1"));
  });

  it("reconcileDevelopmentPending treats the currently in-flight run as in-flight and others as not", async () => {
    let resolveRun!: (value: unknown) => void;
    runDevelopmentRequest.mockReturnValueOnce(new Promise((done) => { resolveRun = done; }));
    recordPendingDevelopmentRun.mockReturnValueOnce("in-flight-run-id");
    const manager = new SessionManager(config(), new Map(), ["slack"]);
    const slack = connector();

    manager.continueDevelopmentGates("story-inflight", slack, target);
    await manager.reconcileDevelopmentPending();

    expect(reconcilePendingDevelopmentRuns).toHaveBeenCalledTimes(1);
    const deps = reconcilePendingDevelopmentRuns.mock.calls[0][1];
    expect(deps.isInFlight({ runId: "in-flight-run-id" })).toBe(true);
    expect(deps.isInFlight({ runId: "some-other-run-id" })).toBe(false);

    resolveRun({ status: "pr_ready", storyId: "story-inflight", summary: "ready" });
    await vi.waitFor(() => expect(removePendingDevelopmentRun).toHaveBeenCalled());

    await manager.reconcileDevelopmentPending();
    const depsAfter = reconcilePendingDevelopmentRuns.mock.calls[1][1];
    expect(depsAfter.isInFlight({ runId: "in-flight-run-id" })).toBe(false);
  });

  it("reconcileDevelopmentPending is a no-op when the development runner is not configured", async () => {
    const bare = { gateway: { port: 7777, host: "127.0.0.1" }, engines: config().engines, connectors: {}, logging: config().logging } as unknown as JinnConfig;
    const manager = new SessionManager(bare, new Map(), ["slack"]);
    await manager.reconcileDevelopmentPending();
    expect(reconcilePendingDevelopmentRuns).not.toHaveBeenCalled();
  });
});
