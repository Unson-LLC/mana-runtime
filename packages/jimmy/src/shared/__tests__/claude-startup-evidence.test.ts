import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeClaudeStartupEvidence, writeClaudeStartupEvidence } from "../claude-startup-evidence.js";

describe("Claude startup evidence", () => {
  it("strips ANSI and redacts credential-shaped output", () => {
    const value = sanitizeClaudeStartupEvidence(
      "\x1b[31mApprove MCP?\x1b[0m\nAPI_KEY=super-secret\nxoxb-123-abcdef\nxoxe-1-secret\nxapp-1-secret\nsk-ant-secret\nAKIAIOSFODNN7EXAMPLE\nhttps://user:password@example.com/path",
    );
    expect(value).toContain("Approve MCP?");
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("xoxb-123-abcdef");
    expect(value).not.toContain("xoxe-1-secret");
    expect(value).not.toContain("xapp-1-secret");
    expect(value).not.toContain("sk-ant-secret");
    expect(value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(value).not.toContain("user:password");
  });

  it("writes a session-safe 0600 evidence file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-evidence-"));
    try {
      const file = writeClaudeStartupEvidence(dir, "session/unsafe", "approval screen");
      expect(path.basename(file)).toMatch(/^session_unsafe-/);
      expect(fs.readFileSync(file, "utf-8")).toContain("approval screen");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
