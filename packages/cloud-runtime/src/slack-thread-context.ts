import {
  hydrateSlackThreadContext,
  type SlackThreadRepliesPage,
} from "@openryoko/slack-thread-context";
import type { SlackQueueEvent } from "./types.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";

export type SlackThreadContextErrorCode =
  | "slack_thread_history_token_missing"
  | "slack_thread_history_rate_limited"
  | "slack_thread_history_unavailable";

export class SlackThreadContextError extends Error {
  constructor(
    public readonly code: SlackThreadContextErrorCode,
    public readonly retryAfterSeconds?: number,
    public readonly diagnostics?: Readonly<{
      stage: "request" | "response_decode" | "provider_response";
      upstreamCode?: string;
      status?: number;
      providerOperation?: string;
      slackError?: string;
    }>,
  ) {
    super(code);
    this.name = "SlackThreadContextError";
  }
}

interface SlackThreadContextOptions {
  botToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Exclude messages at or before a /new boundary. Slack timestamps compare numerically. */
  contextAfterTs?: string;
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
  if (!options.botToken && !options.fetch) throw new SlackThreadContextError("slack_thread_history_token_missing");
  const fetchImpl = options.fetch ?? fetch;

  const context = await hydrateSlackThreadContext(async (args) => {
    let response: Response;
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) query.set(key, String(value));
      }
      response = await fetchImpl(`https://slack.com/api/conversations.replies?${query}`, {
        method: "GET",
        headers: {
          ...(options.botToken ? { authorization: `Bearer ${options.botToken}` } : {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new SlackThreadContextError("slack_thread_history_unavailable", undefined, {
        stage: "request",
        ...(error instanceof TenantBoundaryError ? {
          upstreamCode: error.code,
          ...(typeof error.details?.status === "number" ? { status: error.details.status } : {}),
          ...(typeof error.details?.provider_operation === "string"
            ? { providerOperation: error.details.provider_operation }
            : {}),
        } : {}),
      });
    }
    if (response.status === 429) {
      throw new SlackThreadContextError("slack_thread_history_rate_limited", retryAfterSeconds(response));
    }
    let payload: SlackRepliesResponse;
    try {
      payload = await response.json() as SlackRepliesResponse;
    } catch {
      throw new SlackThreadContextError("slack_thread_history_unavailable", undefined, {
        stage: "response_decode",
        status: response.status,
      });
    }
    if (!response.ok || payload.ok !== true) {
      throw new SlackThreadContextError("slack_thread_history_unavailable", undefined, {
        stage: "provider_response",
        status: response.status,
        ...(typeof payload.error === "string" && /^[a-z0-9_]{1,64}$/u.test(payload.error)
          ? { slackError: payload.error }
          : {}),
      });
    }
    if (!options.contextAfterTs) return payload;
    const boundary = Number(options.contextAfterTs);
    return {
      ...payload,
      messages: payload.messages?.filter((message) => {
        const timestamp = Number(message.ts);
        return Number.isFinite(boundary) && Number.isFinite(timestamp) && timestamp > boundary;
      }),
    };
  }, event.channelId, event.threadTs, event.messageTs);

  return context ? { ...event, threadContext: context } : event;
}
