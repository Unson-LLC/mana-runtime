import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionSettings, seedTrust, writePlacementGuardSettings } from "../claude-settings.js";

describe("buildSessionSettings", () => {
  it("registers SessionStart/Stop/StopFailure/PreToolUse/PostToolUse hooks", () => {
    const s = buildSessionSettings({ sessionId: "abc", relayScript: "/home/.ryoko/hook-relay.mjs" });
    for (const ev of ["SessionStart", "Stop", "StopFailure", "PreToolUse", "PostToolUse"] as const) {
      expect(s.hooks[ev]).toHaveLength(1);
      expect(s.hooks[ev][0].hooks[0].type).toBe("command");
    }
  });

  it("shell-quotes the relay script path and session id (path with spaces)", () => {
    const s = buildSessionSettings({
      sessionId: "sess-1",
      relayScript: "/Users/My User/.ryoko/hook-relay.mjs",
    });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    // The space-bearing path must be single-quoted so the shell sees one argument.
    expect(cmd).toBe("node '/Users/My User/.ryoko/hook-relay.mjs' 'sess-1'");
  });

  it("neutralizes shell metacharacters in the path (no injection)", () => {
    const s = buildSessionSettings({
      sessionId: "x",
      relayScript: "/tmp/a'; rm -rf ~; '.mjs",
    });
    const cmd = s.hooks.Stop[0].hooks[0].command;
    // The embedded single quote is escaped as '\'' so the injected `rm` is inert text.
    expect(cmd).toContain(`'/tmp/a'\\''; rm -rf ~; '\\''.mjs'`);
    expect(cmd.startsWith("node '")).toBe(true);
  });

  it("registers the placement Bash guard as the first PreToolUse hook with matcher Bash", () => {
    const s = buildSessionSettings({
      sessionId: "p1",
      relayScript: "/home/.ryoko/hook-relay.mjs",
      placementGuardScript: "/home/.ryoko/placement-guard.mjs",
    });
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("node '/home/.ryoko/placement-guard.mjs'");
    // The relay entry (no matcher — all tools) stays registered after the guard.
    expect(s.hooks.PreToolUse[1].matcher).toBeUndefined();
    // Non-placement sessions get no guard entry.
    const plain = buildSessionSettings({ sessionId: "p2", relayScript: "/r.mjs" });
    expect(plain.hooks.PreToolUse).toHaveLength(1);
    expect(plain.hooks.PreToolUse[0].matcher).toBeUndefined();
  });

  it("includes appendSystemPrompt only when provided", () => {
    const without = buildSessionSettings({ sessionId: "a", relayScript: "/r.mjs" });
    expect(without.appendSystemPrompt).toBeUndefined();
    const withPrompt = buildSessionSettings({ sessionId: "a", relayScript: "/r.mjs", appendSystemPrompt: "be terse" });
    expect(withPrompt.appendSystemPrompt).toBe("be terse");
  });
});

describe("seedTrust", () => {
  it("marks a project dir trusted in ~/.claude.json and is idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seedtrust-"));
    const claudeJson = path.join(dir, ".claude.json");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      seedTrust(claudeJson, projectDir);
      seedTrust(claudeJson, projectDir); // idempotent — must not throw or duplicate
      const data = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      const real = fs.realpathSync(projectDir);
      expect(data.projects[real].hasTrustDialogAccepted).toBe(true);
      expect(data.projects[real].hasCompletedProjectOnboarding).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("writePlacementGuardSettings", () => {
  it("writes a guard-only settings file (Bash matcher, mode 0600) idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardset-"));
    try {
      const p1 = writePlacementGuardSettings(dir, "/home/.ryoko/placement-guard.mjs");
      const p2 = writePlacementGuardSettings(dir, "/home/.ryoko/placement-guard.mjs");
      expect(p1).toBe(p2);
      const data = JSON.parse(fs.readFileSync(p1, "utf-8"));
      expect(data.hooks.PreToolUse).toHaveLength(1);
      expect(data.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("node '/home/.ryoko/placement-guard.mjs'");
      expect(Object.keys(data.hooks)).toEqual(["PreToolUse"]); // no relay hooks for headless runs
      expect(fs.statSync(p1).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
