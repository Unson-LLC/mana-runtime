import { beforeEach, describe, expect, it, vi } from "vitest";

const runDevelopmentRequest = vi.hoisted(() => vi.fn());
vi.mock("../development-runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../development-runner.js")>(),
  runDevelopmentRequest,
}));

// This file doesn't assert on pending-run bookkeeping (see
// manager-development-pending.test.ts for that) — stub it out here so these
// tests never touch the real JINN_HOME state file on disk.
vi.mock("../development-pending.js", () => ({
  recordPendingDevelopmentRun: vi.fn(() => "test-run-id"),
  removePendingDevelopmentRun: vi.fn(),
}));

import { SessionManager } from "../manager.js";
import type { Connector, IncomingMessage, JinnConfig } from "../../shared/types.js";

function config(enabled: boolean): JinnConfig {
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
      enabled,
      bin: "/usr/bin/sudo",
      allowedSlackChannels: ["C1"],
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

function connector(name = "slack", extra: Partial<Connector> = {}): Connector {
  return {
    name,
    start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    reconstructTarget: vi.fn(() => ({ channel: "C1", thread: "T1" })),
    getCapabilities: vi.fn(() => ({ threading: true, messageEdits: true, reactions: true, attachments: true })),
    ...extra,
  } as unknown as Connector;
}

describe("SessionManager /develop boundary", () => {
  it("does not expose /develop through non-Slack connectors", async () => {
    const manager = new SessionManager(config(true), new Map(), ["discord"]);
    const discord = connector("discord");
    expect(await manager.handleCommand(message("/develop change docs"), discord)).toBe(false);
    expect(runDevelopmentRequest).not.toHaveBeenCalled();
    expect(discord.replyMessage).not.toHaveBeenCalled();
  });

  it("fails closed while the runner is disabled", async () => {
    const manager = new SessionManager(config(false), new Map(), ["slack"]);
    const slack = connector();
    expect(await manager.handleCommand(message("/develop change docs"), slack)).toBe(true);
    expect(runDevelopmentRequest).not.toHaveBeenCalled();
    expect(slack.replyMessage).toHaveBeenCalledWith(expect.anything(), "Development runner is disabled.");
  });

  it("fails closed outside the configured Slack channels", async () => {
    const cfg = config(true);
    cfg.developmentRunner!.allowedSlackChannels = ["C_PILOT"];
    const manager = new SessionManager(cfg, new Map(), ["slack"]);
    const slack = connector();

    expect(await manager.handleCommand(message("/develop change docs"), slack)).toBe(true);
    expect(runDevelopmentRequest).not.toHaveBeenCalled();
    expect(slack.replyMessage).toHaveBeenCalledWith(
      expect.anything(),
      "Development tasks are not enabled in this channel.",
    );
  });

  it("accepts only one development request at a time", async () => {
    let resolve!: (value: unknown) => void;
    runDevelopmentRequest.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    await manager.handleCommand(message("/develop first"), slack);
    await manager.handleCommand(message("/develop second"), slack);

    expect(runDevelopmentRequest).toHaveBeenCalledOnce();
    expect(slack.replyMessage).toHaveBeenCalledWith(
      expect.anything(),
      "A development task is already running. Try again after it completes.",
    );
    resolve({ status: "failed", summary: "stopped" });
    await vi.waitFor(() => expect(runDevelopmentRequest).toHaveBeenCalledOnce());
  });
});

describe("SessionManager Human-in-the-Loop resume", () => {
  const target = { channel: "C1", thread: "T1" };
  const answers = [{ id: "q1", answer: "option A" }];

  beforeEach(() => {
    runDevelopmentRequest.mockReset();
  });

  it("does not resume while the runner is disabled", () => {
    const manager = new SessionManager(config(false), new Map(), ["slack"]);
    const slack = connector();
    expect(manager.resumeDevelopmentDecision("story-x", answers, slack, target)).toBe(false);
    expect(runDevelopmentRequest).not.toHaveBeenCalled();
  });

  it("does not resume a second time while one development task is already running", async () => {
    let resolve!: (value: unknown) => void;
    runDevelopmentRequest.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    expect(manager.resumeDevelopmentDecision("story-x", answers, slack, target)).toBe(true);
    expect(manager.resumeDevelopmentDecision("story-x", answers, slack, target)).toBe(false);
    expect(runDevelopmentRequest).toHaveBeenCalledOnce();
    resolve({ status: "failed", summary: "stopped" });
    await vi.waitFor(() => expect(runDevelopmentRequest).toHaveBeenCalledOnce());
  });

  it("resumes with the storyId/answers payload and posts the formatted result", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    expect(manager.resumeDevelopmentDecision("story-x", answers, slack, target)).toBe(true);
    expect(runDevelopmentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      { storyId: "story-x", answers },
      undefined,
      expect.any(Function),
    );
    await vi.waitFor(() => expect(slack.replyMessage).toHaveBeenCalledWith(target, expect.stringContaining("pr_ready")));
  });

  it("posts a Block Kit question card via postDecisionQuestions when the connector supports it", async () => {
    const questions = [{ id: "q1", question: "which approach?", options: [], allow_free_text: true }];
    runDevelopmentRequest.mockResolvedValueOnce({
      status: "needs_decision", storyId: "story-x", summary: "ambiguous", questions,
    });
    const postDecisionQuestions = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector("slack", { postDecisionQuestions });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(postDecisionQuestions).toHaveBeenCalledWith(target, {
      storyId: "story-x", questions, summary: "ambiguous",
    }));
    expect(slack.replyMessage).not.toHaveBeenCalledWith(target, expect.stringContaining("needs_decision"));
  });

  it("falls back to plain text when the connector has no postDecisionQuestions support", async () => {
    const questions = [{ id: "q1", question: "which approach?", options: [], allow_free_text: true }];
    runDevelopmentRequest.mockResolvedValueOnce({
      status: "needs_decision", storyId: "story-x", summary: "ambiguous", questions,
    });
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(slack.replyMessage).toHaveBeenCalledWith(target, expect.stringContaining("needs_decision")));
  });
});

describe("SessionManager needs_input gate result delivery", () => {
  const target = { channel: "C1", thread: "T1" };
  const gates = [{ severity: "critical" as const, text: "missing threat model" }];
  const commits = { count: 2, subjects: ["feat: a"] };

  beforeEach(() => {
    runDevelopmentRequest.mockReset();
  });

  it("posts a gate result card via postDevelopmentNeedsInput when the connector supports it", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({
      status: "needs_input", storyId: "story-x", summary: "gates remain", gates, commits,
    });
    const postDevelopmentNeedsInput = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector("slack", { postDevelopmentNeedsInput });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(postDevelopmentNeedsInput).toHaveBeenCalledWith(target, {
      storyId: "story-x", summary: "gates remain", gates, commits,
    }));
    expect(slack.replyMessage).not.toHaveBeenCalledWith(target, expect.stringContaining("needs_input"));
  });

  it("falls back to plain text when the connector has no postDevelopmentNeedsInput support", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({
      status: "needs_input", storyId: "story-x", summary: "gates remain", gates, commits,
    });
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(slack.replyMessage).toHaveBeenCalledWith(target, expect.stringContaining("needs_input")));
  });

  it("falls back to plain text for a needs_input result without a storyId", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "needs_input", summary: "agent crashed" });
    const postDevelopmentNeedsInput = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector("slack", { postDevelopmentNeedsInput });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(slack.replyMessage).toHaveBeenCalledWith(target, expect.stringContaining("needs_input")));
    expect(postDevelopmentNeedsInput).not.toHaveBeenCalled();
  });
});

describe("SessionManager continueDevelopmentGates", () => {
  const target = { channel: "C1", thread: "T1" };

  beforeEach(() => {
    runDevelopmentRequest.mockReset();
  });

  it("does not continue while the runner is disabled", () => {
    const manager = new SessionManager(config(false), new Map(), ["slack"]);
    const slack = connector();
    expect(manager.continueDevelopmentGates("story-x", slack, target)).toBe(false);
    expect(runDevelopmentRequest).not.toHaveBeenCalled();
  });

  it("does not continue a second time while one development task is already running", async () => {
    let resolve!: (value: unknown) => void;
    runDevelopmentRequest.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    expect(manager.continueDevelopmentGates("story-x", slack, target)).toBe(true);
    expect(manager.continueDevelopmentGates("story-x", slack, target)).toBe(false);
    expect(runDevelopmentRequest).toHaveBeenCalledOnce();
    resolve({ status: "failed", summary: "stopped" });
    await vi.waitFor(() => expect(runDevelopmentRequest).toHaveBeenCalledOnce());
  });

  it("continues with the storyId/continueGates payload and delivers the result", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector();

    expect(manager.continueDevelopmentGates("story-x", slack, target)).toBe(true);
    expect(runDevelopmentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      { storyId: "story-x", continueGates: true },
      undefined,
      expect.any(Function),
    );
    await vi.waitFor(() => expect(slack.replyMessage).toHaveBeenCalledWith(target, expect.stringContaining("pr_ready")));
  });
});

describe("SessionManager /develop threaded progress-message UX", () => {
  // A real Slack slash command has no root channel message to thread under,
  // so reconstructTarget() legitimately returns a target with no thread —
  // this is the case that used to leave the whole flow unthreaded.
  function rootlessConnector(extra: Partial<Connector> = {}): Connector {
    return connector("slack", {
      reconstructTarget: vi.fn(() => ({ channel: "C1" })),
      ...extra,
    });
  }

  beforeEach(() => {
    runDevelopmentRequest.mockReset();
  });

  it("threads the result under the acceptance message when the command target has no thread", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000100") // acceptance message ts
      .mockResolvedValueOnce(undefined); // final result post
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(2));

    const [finalTarget] = replyMessage.mock.calls[1];
    expect(finalTarget).toMatchObject({ channel: "C1", thread: "1700000000.000100" });
  });

  it("sets the typing status when the flow starts and clears it after delivering a result", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000200").mockResolvedValueOnce(undefined);
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith("C1", "1700000000.000200", ""));

    expect(setTypingStatus).toHaveBeenCalledWith("C1", "1700000000.000200", "開発中…");
    const clearCallIndex = setTypingStatus.mock.calls.findIndex((call) => call[2] === "");
    const startCallIndex = setTypingStatus.mock.calls.findIndex((call) => call[2] === "開発中…");
    expect(startCallIndex).toBeGreaterThanOrEqual(0);
    expect(clearCallIndex).toBeGreaterThan(startCallIndex);
  });

  it("clears the typing status even when the runner rejects", async () => {
    runDevelopmentRequest.mockRejectedValueOnce(new Error("boom"));
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000300").mockResolvedValueOnce(undefined);
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith("C1", "1700000000.000300", ""));
    expect(setTypingStatus).toHaveBeenCalledWith("C1", "1700000000.000300", "開発中…");
  });

  it("posts a new in-thread progress message on the first progress event: 0 commits", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 65, commits: 0 });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000400") // acceptance message ts
      .mockResolvedValueOnce("1700000000.000401") // progress message ts
      .mockResolvedValueOnce(undefined); // final result post
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000400" },
      "🔨 開発中 1分 — Storyを分析しています",
    ));
    // Final rewrite happens via editMessage on the tracked progress message, not a new post.
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000400", messageTs: "1700000000.000401" },
      "⏱ 実行 0分",
    ));
  });

  it("edits the tracked progress message in place on later ticks: N commits includes the latest subject", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 0 });
      onProgress?.({ phase: "agent", elapsedSec: 130, commits: 3, latest: "fix(slack): report progress" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready", commits: { count: 3, subjects: ["fix(slack): report progress"] } };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000500") // acceptance message ts
      .mockResolvedValueOnce("1700000000.000501") // progress message ts (first tick)
      .mockResolvedValueOnce(undefined); // final result post
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000500", messageTs: "1700000000.000501" },
      "🔨 開発中 2分 / commit 3件 — 最新: fix(slack): report progress",
    ));
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000500", messageTs: "1700000000.000501" },
      "⏱ 実行 0分 / commit 3件",
    ));
    // Only one message was ever posted for progress — everything after the first tick is an edit.
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(3));
  });

  it("renders the gate phase in the progress message", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "gate", elapsedSec: 240, commits: 5 });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000600")
      .mockResolvedValueOnce("1700000000.000601")
      .mockResolvedValueOnce(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000600" },
      "🔍 Gate検証中 4分 / commit 5件",
    ));
  });

  it("skips a redundant edit when consecutive progress ticks render identical text", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 1, latest: "same subject" });
      onProgress?.({ phase: "agent", elapsedSec: 65, commits: 1, latest: "same subject" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000700")
      .mockResolvedValueOnce("1700000000.000701")
      .mockResolvedValueOnce(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(3));

    // Only the final "⏱ 実行" rewrite should have hit editMessage — the second,
    // identical-text tick must not have triggered a redundant chat.update.
    const progressEditCalls = editMessage.mock.calls.filter((call) => call[1] === "🔨 開発中 1分 / commit 1件 — 最新: same subject");
    expect(progressEditCalls).toHaveLength(0);
    expect(editMessage).toHaveBeenCalledTimes(1);
  });

  it("retries on the next tick when an edit fails, and swallows the error", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 1, latest: "first" });
      onProgress?.({ phase: "agent", elapsedSec: 120, commits: 2, latest: "second" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000800")
      .mockResolvedValueOnce("1700000000.000801")
      .mockResolvedValueOnce(undefined);
    const editMessage = vi.fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await expect(manager.handleCommand(message("/develop change docs"), slack)).resolves.not.toThrow();
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000800", messageTs: "1700000000.000801" },
      "🔨 開発中 2分 / commit 2件 — 最新: second",
    ));
    // Same message ts kept across the failed edit — no repost for a plain error.
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(3));
  });

  it("reposts once and switches ts when the tracked progress message was deleted (message_not_found)", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 1, latest: "first" });
      onProgress?.({ phase: "agent", elapsedSec: 120, commits: 2, latest: "second" });
      return {
        status: "pr_ready", storyId: "story-x", summary: "ready",
        commits: { count: 2, subjects: ["second", "first"] },
      };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.000900") // acceptance
      .mockResolvedValueOnce("1700000000.000901") // first progress post
      .mockResolvedValueOnce("1700000000.000902") // repost after message_not_found
      .mockResolvedValueOnce(undefined); // final result post
    const editMessage = vi.fn()
      .mockRejectedValueOnce(new Error("slack_webapi_platform_error: message_not_found"))
      .mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000900" },
      "🔨 開発中 2分 / commit 2件 — 最新: second",
    ));
    // The subsequent final rewrite edits the NEW ts, not the deleted one.
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(
      { channel: "C1", thread: "1700000000.000900", messageTs: "1700000000.000902" },
      "⏱ 実行 0分 / commit 2件",
    ));
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(4));
  });

  it("does not post or edit a progress message when the connector lacks messageEdits support", async () => {
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 1, latest: "first" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn()
      .mockResolvedValueOnce("1700000000.001000")
      .mockResolvedValueOnce(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const getCapabilities = vi.fn(() => ({ threading: true, messageEdits: false, reactions: true, attachments: true }));
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, editMessage, getCapabilities });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(2)); // acceptance + final result, no progress post
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("sets the typing status on the resume path too", async () => {
    runDevelopmentRequest.mockResolvedValueOnce({ status: "pr_ready", storyId: "story-x", summary: "ready" });
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = connector("slack", { setTypingStatus });
    const answers = [{ id: "q1", answer: "option A" }];
    const resumeTarget = { channel: "C1", thread: "T1" };

    expect(manager.resumeDevelopmentDecision("story-x", answers, slack, resumeTarget)).toBe(true);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith("C1", "T1", ""));
    expect(setTypingStatus).toHaveBeenCalledWith("C1", "T1", "開発中…");
  });
});
