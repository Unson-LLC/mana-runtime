import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * OAuth refresh gate for PTY-spawned `claude` children.
 *
 * Problem: every interactive turn spawns the genuine `claude` CLI, and they ALL
 * share one subscription-OAuth credential file (~/.claude/.credentials.json).
 * Its access token rotates ~every 8h. When several `claude` processes start
 * within the same instant (cron fires up to ~6 turns at :00/:15/:30/:45) right
 * as the token expires, each tries to refresh using the SAME single-use refresh
 * token. The first wins and rotates it; the rest present a now-invalidated
 * refresh token → 401 invalid_grant, surfaced by the Stop hook as
 * `authentication_failed` → "Interactive turn failed: authentication_failed".
 * A lone interactive turn never races, which is why it "fails sometimes".
 *
 * Fix WITHOUT touching the OAuth protocol (re-implementing refresh against a
 * shared production credential file risks logging out every consumer — this
 * gateway, host OpenClaw, Cursor — by burning the refresh token): serialize the
 * spawn herd only across the narrow near-expiry window. Elect ONE leader to
 * spawn first; its `claude` performs the single refresh as a startup side
 * effect. Followers wait until the credential file's `expiresAt` advances (i.e.
 * the leader refreshed) or a bounded timeout, then proceed reading the fresh
 * token. When the token is comfortably valid — the overwhelming common case —
 * this is a single file read with zero waiting and zero contention.
 */

/** Start serializing once the token is within this window of expiry (or past it).
 *  Kept small so we only gate when `claude` will actually refresh on startup. */
const NEAR_EXPIRY_MS = 90 * 1000;
/** Max a follower waits for the leader's refresh before proceeding anyway. A
 *  refresh is a single fast HTTPS call; this is a safety valve, not the norm. */
const MAX_WAIT_MS = 25 * 1000;
/** How often a follower re-reads the credential file while waiting. */
const POLL_MS = 400;

/** In-flight leader election. Non-null while a near-expiry refresh window is
 *  being drained. Process-local — the gateway is a single process, so this
 *  alone serializes all of its interactive spawns. */
let refreshWindow: Promise<void> | null = null;

function credentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, ".credentials.json");
}

/** Read `claudeAiOauth.expiresAt` (epoch ms) from the credential file, or
 *  undefined when the file is absent/unreadable/not OAuth (e.g. API-key mode) —
 *  in which case there is nothing to gate and callers proceed immediately. */
function readExpiresAt(): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsPath(), "utf-8");
  } catch {
    return undefined;
  }
  try {
    const exp = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
    return typeof exp === "number" && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the credential file until `expiresAt` advances past the stale value the
 *  leader observed (the refresh landed) or the safety timeout elapses. */
async function waitForRefresh(staleExpiresAt: number): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const exp = readExpiresAt();
    // Refreshed (advanced) or creds vanished/changed shape — stop blocking.
    if (exp === undefined || exp > staleExpiresAt) return;
  }
  logger.warn(
    `claude-oauth-gate: refresh not observed within ${MAX_WAIT_MS}ms — proceeding (token may still be refreshing)`,
  );
}

/**
 * Call immediately before spawning a `claude` PTY child. Resolves at once when
 * the shared OAuth token is comfortably valid; otherwise serializes the spawn
 * herd so exactly one child triggers the token refresh and the rest wait for it.
 */
export async function awaitFreshClaudeCredentials(): Promise<void> {
  const exp = readExpiresAt();
  // No OAuth creds, or comfortably valid → nothing to gate.
  if (exp === undefined || Date.now() < exp - NEAR_EXPIRY_MS) return;

  // Near-expiry window. The first arrival becomes the leader: it returns
  // immediately to spawn (so its claude performs the refresh) and opens the
  // window others wait on. Election is race-free — no await between the
  // null-check and the assignment on this single thread.
  if (!refreshWindow) {
    const staleExpiresAt = exp;
    logger.info(
      `claude-oauth-gate: token within ${NEAR_EXPIRY_MS}ms of expiry — leader spawning to refresh, followers will wait`,
    );
    refreshWindow = waitForRefresh(staleExpiresAt).finally(() => {
      refreshWindow = null;
    });
    return; // leader proceeds to spawn
  }

  // Follower: wait for the leader's refresh to land before spawning.
  await refreshWindow;
}
