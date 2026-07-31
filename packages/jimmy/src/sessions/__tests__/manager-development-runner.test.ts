import { beforeEach, describe, expect, it, vi } from "vitest";

const runDevelopmentRequest = vi.hoisted(() => vi.fn());
vi.mock("../development-runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../development-runner.js")>(),
  runDevelopmentRequest,
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
    reconstructTarget: vi.fn(() => ({ channel: "C1", thread: "T1" })),
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

describe("SessionManager /develop threaded typing-status UX", () => {
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

  it("refreshes the typing status with real progress: 0 commits", async () => {
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 65, commits: 0 });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000400").mockResolvedValueOnce(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith(
      "C1", "1700000000.000400", "開発中 1分 — Storyを分析しています",
    ));
  });

  it("refreshes the typing status with real progress: N commits includes the latest subject", async () => {
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 130, commits: 3, latest: "fix(slack): report progress" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000500").mockResolvedValueOnce(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith(
      "C1", "1700000000.000500", "開発中 2分 / commit 3件: fix(slack): report progress",
    ));
  });

  it("refreshes the typing status with real progress: gate phase", async () => {
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "gate", elapsedSec: 240, commits: 5 });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000600").mockResolvedValueOnce(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith(
      "C1", "1700000000.000600", "Gate検証中 4分 / commit 5件",
    ));
  });

  it("skips a redundant setTypingStatus call when consecutive progress ticks render identical text", async () => {
    const setTypingStatus = vi.fn().mockResolvedValue(undefined);
    runDevelopmentRequest.mockImplementationOnce(async (_config: unknown, _request: unknown, _spawnFn: unknown, onProgress?: (p: any) => void) => {
      onProgress?.({ phase: "agent", elapsedSec: 60, commits: 1, latest: "same subject" });
      onProgress?.({ phase: "agent", elapsedSec: 65, commits: 1, latest: "same subject" });
      return { status: "pr_ready", storyId: "story-x", summary: "ready" };
    });
    const replyMessage = vi.fn().mockResolvedValueOnce("1700000000.000700").mockResolvedValueOnce(undefined);
    const manager = new SessionManager(config(true), new Map(), ["slack"]);
    const slack = rootlessConnector({ replyMessage, setTypingStatus });

    await manager.handleCommand(message("/develop change docs"), slack);
    await vi.waitFor(() => expect(setTypingStatus).toHaveBeenCalledWith("C1", "1700000000.000700", ""));

    const progressCalls = setTypingStatus.mock.calls.filter((call) => call[2] === "開発中 1分 / commit 1件: same subject");
    expect(progressCalls).toHaveLength(1);
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
