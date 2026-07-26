import { describe, expect, it, vi } from "vitest";

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
    developmentRunner: { enabled, bin: "/usr/bin/sudo" },
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

function connector(name = "slack"): Connector {
  return {
    name,
    start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    reconstructTarget: vi.fn(() => ({ channel: "C1", thread: "T1" })),
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
