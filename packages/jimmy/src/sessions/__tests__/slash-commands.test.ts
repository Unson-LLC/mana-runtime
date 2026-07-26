import { describe, it, expect } from "vitest";

import { SLASH_COMMANDS, startsWithSlashCommand } from "../manager.js";

describe("startsWithSlashCommand", () => {
  it("matches a bare slash command", () => {
    expect(startsWithSlashCommand("/new")).toBe(true);
    expect(startsWithSlashCommand("/status")).toBe(true);
  });

  it("matches a slash command with arguments", () => {
    expect(startsWithSlashCommand("/model opus")).toBe(true);
    expect(startsWithSlashCommand("/cron list")).toBe(true);
    expect(startsWithSlashCommand("/develop READMEを改善する")).toBe(true);
  });

  it("tolerates leading whitespace", () => {
    expect(startsWithSlashCommand("  /new")).toBe(true);
  });

  it("does NOT match a command buried after a thread-context preamble", () => {
    // Regression: the Slack connector prepended "[Thread context — …]" to every
    // threaded message, pushing the command out of first position so that
    // SessionManager.handleCommand() never intercepted it.
    expect(
      startsWithSlashCommand('[Thread context — parent message: "x"]\n\n/new'),
    ).toBe(false);
  });

  it("does not match ordinary messages or unknown commands", () => {
    expect(startsWithSlashCommand("hello")).toBe(false);
    expect(startsWithSlashCommand("/unknown")).toBe(false);
    expect(startsWithSlashCommand("/newsletter")).toBe(false);
  });

  it("covers every command the session manager handles", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(startsWithSlashCommand(cmd)).toBe(true);
    }
  });
});
