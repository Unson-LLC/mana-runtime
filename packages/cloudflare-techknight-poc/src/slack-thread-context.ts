import {
  hydrateSlackThreadContext,
  type SlackThreadRepliesPage,
} from "@openryoko/slack-thread-context";
import type { SlackQueueEvent } from "./types.js";

export type SlackThreadContextErrorCode =
  | "slack_thread_history_token_missing"
  | "slack_thread_history_rate_limited"
  | "slack_thread_history_unavailable";

export class SlackThreadContextError extends Error {
  constructor(
    public readonly code: SlackThreadContextErrorCode,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "SlackThreadContextError";
  }
}

interface SlackThreadContextOptions {
  botToken: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface SlackRepliesResponse extends SlackThreadRepliesPage {
  ok?: boolean;
  error?: string;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Hydrate only thread replies. Root mentions already contain all available text. */
export async function hydrateSlackQueueEventThreadContext(
  event: SlackQueueEvent,
  options: SlackThreadContextOptions,
): Promise<SlackQueueEvent> {
  if (event.threadTs === event.messageTs) return event;
  if (!options.botToken) throw new SlackThreadContextError("slack_thread_history_token_missing");
  const fetchImpl = options.fetch ?? fetch;

  const context = await hydrateSlackThreadContext(async (args) => {
    let response: Response;
    try {
      response = await fetchImpl("https://slack.com/api/conversations.replies", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new SlackThreadContextError("slack_thread_history_unavailable");
    }
    if (response.status === 429) {
      throw new SlackThreadContextError("slack_thread_history_rate_limited", retryAfterSeconds(response));
    }
    let payload: SlackRepliesResponse;
    try {
      payload = await response.json() as SlackRepliesResponse;
    } catch {
      throw new SlackThreadContextError("slack_thread_history_unavailable");
    }
    if (!response.ok || payload.ok !== true) {
      throw new SlackThreadContextError("slack_thread_history_unavailable");
    }
    return payload;
  }, event.channelId, event.threadTs, event.messageTs);

  return context ? { ...event, threadContext: context } : event;
}
