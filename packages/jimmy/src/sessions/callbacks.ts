import { getSession } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import {
  CURRENT_SESSION_HEADER,
  getSessionDelegationToken,
  SESSION_DELEGATION_HEADER,
  SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
  SYSTEM_NOTIFICATION_SESSION_ID,
} from "./delegation-auth.js";

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): void {
  if (!childSession.parentSessionId) return;
  if (options?.alwaysNotify === false) return;

  // Run asynchronously — do not await in the caller
  _sendNotification(childSession, result).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
): void {
  if (!childSession.parentSessionId) return;

  const employeeName = childSession.employee || "Unknown";
  _sendRaw(childSession.parentSessionId, `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return; // Parent gone or expired
  if (parent.status === "error") return; // Parent already in error — skip

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  let message: string;
  if (result.error) {
    message = `⚠️ Linked child employee "${employeeName}" (session ${childId}, parent ${childSession.parentSessionId}) encountered an error: ${result.error}

This is a completion callback for a child session linked to your current session. Treat it as a continuation of the original user task, not as an unrelated conversation. Explain the failure to the original user or recover if safe. Do not delegate the same task again.`;
  } else {
    const raw = result.result || "(no output)";
    const maxEmbeddedResultChars = 16_000;
    const embeddedResult =
      raw.length > maxEmbeddedResultChars
        ? `${raw.substring(0, maxEmbeddedResultChars)}\n\n[Child result truncated at ${maxEmbeddedResultChars} characters.]`
        : raw;
    message = `📩 Linked child employee "${employeeName}" completed session ${childId} for parent session ${childSession.parentSessionId}.

This child was created with parentSessionId equal to your current session ID. It is therefore part of the original user task, not a separate or unrelated conversation.

The child result is embedded below. Use it directly; do not call the gateway API or run a shell command to retrieve it.

Then review and integrate the child's result into a final answer to the original user on the parent connector. Do not delegate this completed task again, do not describe it as orphaned, and do not claim it belongs to another task.

Complete child result:
${embeddedResult}`;
  }

  await _sendRaw(childSession.parentSessionId!, message);
}

/**
 * Send a hardcoded notification to the configured Discord channel.
 * Used for rate-limit alerts that must not depend on the LLM.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyDiscordChannel(message: string): void {
  _sendDiscordNotification(message).catch((err) => {
    logger.warn(`[callbacks] Failed to send Discord notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendDiscordNotification(message: string): Promise<void> {
  let port = 7777;
  let connector = "discord";
  let channel: string | undefined;

  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
    connector = config.notifications?.connector || "discord";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping Discord notification");
    return;
  }

  await fetch(`http://127.0.0.1:${port}/api/connectors/${connector}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CURRENT_SESSION_HEADER]: SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
      [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID),
    },
    body: JSON.stringify({ channel, text: message }),
  });
}

async function _sendRaw(parentSessionId: string, message: string): Promise<void> {
  let port = 7777;
  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
  } catch {
    // Use default port if config is unavailable
  }

  await fetch(`http://127.0.0.1:${port}/api/sessions/${parentSessionId}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [CURRENT_SESSION_HEADER]: SYSTEM_NOTIFICATION_SESSION_ID,
      [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(SYSTEM_NOTIFICATION_SESSION_ID),
    },
    body: JSON.stringify({ message, role: "notification" }),
  });
}
