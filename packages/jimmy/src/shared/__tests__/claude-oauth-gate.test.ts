import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { awaitFreshClaudeCredentials } from "../claude-oauth-gate.js";

// The gate reads $CLAUDE_CONFIG_DIR/.credentials.json. Point it at a temp dir so
// tests drive expiresAt deterministically without touching the real ~/.claude.
let dir: string;
const credsPath = () => path.join(dir, ".credentials.json");
function writeExpiresAt(expiresAt: number | null): void {
  const body = expiresAt === null ? {} : { claudeAiOauth: { expiresAt } };
  fs.writeFileSync(credsPath(), JSON.stringify(body));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-gate-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("awaitFreshClaudeCredentials", () => {
  it("returns immediately when the token is comfortably valid", async () => {
    writeExpiresAt(Date.now() + 60 * 60 * 1000); // +1h
    const t0 = Date.now();
    await awaitFreshClaudeCredentials();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("returns immediately when no OAuth credentials exist (e.g. API-key mode)", async () => {
    writeExpiresAt(null);
    const t0 = Date.now();
    await awaitFreshClaudeCredentials();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("returns immediately when the credential file is absent", async () => {
    // no file written
    const t0 = Date.now();
    await awaitFreshClaudeCredentials();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("leader proceeds at once near expiry; a follower waits until the token is refreshed", async () => {
    const staleExp = Date.now() + 1000; // within the 90s near-expiry window
    writeExpiresAt(staleExp);

    // Leader: elected, returns immediately to spawn (and to perform the refresh).
    const tLeader = Date.now();
    await awaitFreshClaudeCredentials();
    expect(Date.now() - tLeader).toBeLessThan(50);

    // Follower arrives during the same window — must block.
    let followerDone = false;
    const follower = awaitFreshClaudeCredentials().then(() => { followerDone = true; });

    await new Promise((r) => setTimeout(r, 600));
    expect(followerDone).toBe(false); // still waiting for the refresh

    // Simulate the leader's claude refreshing the shared token.
    writeExpiresAt(Date.now() + 8 * 60 * 60 * 1000);

    await follower;
    expect(followerDone).toBe(true);
  });
});
