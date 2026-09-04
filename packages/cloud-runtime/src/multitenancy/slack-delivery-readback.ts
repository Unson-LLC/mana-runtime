const SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_TIMESTAMP_PATTERN = /^\d+(?:\.\d+)?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAGE_SIZE = 100;

export interface SlackDeliveryReadbackInput {
  /** The channel and timestamp returned by the observed chat.postMessage call. */
  readonly observed: {
    readonly channel: string;
    readonly ts: string;
  };
  /**
   * The provider identity already bound to the injected broker fetch. Slack
   * history does not consistently return a workspace field, so this helper
   * never invents one in the receipt.
   */
  readonly expected: {
    readonly workspaceId: string;
    readonly appId: string;
    readonly botId: string;
  };
  /** A known parent timestamp selects conversations.replies. */
  readonly threadTs?: string;
  /** SHA-256 of the exact text submitted to chat.postMessage. */
  readonly bodyHash: string;
  /** Inclusive Slack timestamp window used for every history request. */
  readonly window: {
    readonly oldest: string;
    readonly latest: string;
  };
  /** Absolute epoch-milliseconds deadline for this readback attempt. */
  readonly expiresAt: number;
  /** Test/runner clock; production callers may omit it. */
  readonly now?: () => number;
  readonly maxPages?: number;
  readonly timeoutMs?: number;
}

export interface SlackDeliveryReadbackReceipt {
  readonly channel: string;
  readonly ts: string;
  readonly body_hash: string;
}

export type SlackDeliveryReadbackReason =
  | "invalid_input"
  | "expired"
  | "timeout"
  | "transport_failure"
  | "http_failure"
  | "rate_limited"
  | "provider_rejected"
  | "invalid_response"
  | "pagination_incomplete"
  | "not_found"
  | "ambiguous"
  | "message_mismatch";

export type SlackDeliveryReadbackResult =
  | {
    readonly state: "confirmed";
    readonly receipt: SlackDeliveryReadbackReceipt;
  }
  | {
    readonly state: "unknown";
    readonly reason: SlackDeliveryReadbackReason;
    readonly receipt: SlackDeliveryReadbackReceipt;
  };

interface SlackHistoryMessage {
  readonly [key: string]: unknown;
}

interface SlackHistoryPage {
  readonly messages: SlackHistoryMessage[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validSlackTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && SLACK_TIMESTAMP_PATTERN.test(value);
}

function timestampWithinWindow(timestamp: string, oldest: string, latest: string): boolean {
  const value = Number(timestamp);
  const lower = Number(oldest);
  const upper = Number(latest);
  return Number.isFinite(value) && Number.isFinite(lower) && Number.isFinite(upper)
    && lower <= value && value <= upper;
}

function safeReceipt(input: SlackDeliveryReadbackInput): SlackDeliveryReadbackReceipt {
  return {
    channel: nonEmptyString(input?.observed?.channel) ? input.observed.channel : "",
    ts: validSlackTimestamp(input?.observed?.ts) ? input.observed.ts : "",
    body_hash: typeof input?.bodyHash === "string" && SHA256_PATTERN.test(input.bodyHash)
      ? input.bodyHash
      : "",
  };
}

function unknownResult(
  input: SlackDeliveryReadbackInput,
  reason: SlackDeliveryReadbackReason,
): SlackDeliveryReadbackResult {
  return { state: "unknown", reason, receipt: safeReceipt(input) };
}

function validateInput(
  input: SlackDeliveryReadbackInput,
  credentialFetch: typeof fetch,
): SlackDeliveryReadbackReason | undefined {
  if (!isRecord(input) || typeof credentialFetch !== "function") return "invalid_input";
  if (!isRecord(input.observed)
    || !nonEmptyString(input.observed.channel)
    || !validSlackTimestamp(input.observed.ts)) return "invalid_input";
  if (!isRecord(input.expected)
    || !nonEmptyString(input.expected.workspaceId)
    || !nonEmptyString(input.expected.appId)
    || !nonEmptyString(input.expected.botId)) return "invalid_input";
  if (input.threadTs !== undefined && !validSlackTimestamp(input.threadTs)) return "invalid_input";
  if (typeof input.bodyHash !== "string" || !SHA256_PATTERN.test(input.bodyHash)) return "invalid_input";
  if (!isRecord(input.window)
    || !validSlackTimestamp(input.window.oldest)
    || !validSlackTimestamp(input.window.latest)
    || Number(input.window.oldest) > Number(input.window.latest)
    || !timestampWithinWindow(input.observed.ts, input.window.oldest, input.window.latest)) {
    return "invalid_input";
  }
  if (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt)) return "invalid_input";
  if (input.now !== undefined && typeof input.now !== "function") return "invalid_input";
  if (input.maxPages !== undefined
    && (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 100)) return "invalid_input";
  if (input.timeoutMs !== undefined
    && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60_000)) return "invalid_input";
  return undefined;
}

function timeoutOrTransportReason(error: unknown): "timeout" | "transport_failure" {
  if (isRecord(error) && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  return "transport_failure";
}

function readPage(value: unknown): SlackHistoryPage | undefined {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.messages)) return undefined;
  if (value.messages.some((message) => !isRecord(message))) return undefined;
  if (value.has_more !== undefined && typeof value.has_more !== "boolean") return undefined;

  let nextCursor: string | undefined;
  if (value.response_metadata !== undefined) {
    if (!isRecord(value.response_metadata)) return undefined;
    if (value.response_metadata.next_cursor !== undefined) {
      if (typeof value.response_metadata.next_cursor !== "string") return undefined;
      nextCursor = value.response_metadata.next_cursor.trim() || undefined;
    }
  }
  return {
    messages: value.messages,
    hasMore: value.has_more === true,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function optionalString(record: SlackHistoryMessage, key: string): string | undefined {
  if (!(key in record)) return undefined;
  return typeof record[key] === "string" ? record[key] : undefined;
}

function messageMatches(
  message: SlackHistoryMessage,
  input: SlackDeliveryReadbackInput,
): boolean {
  if (optionalString(message, "ts") !== input.observed.ts) return false;
  const channel = optionalString(message, "channel");
  if (("channel" in message && channel !== input.observed.channel)) return false;

  // A workspace/team value is checked only when Slack actually returns it.
  // The expected workspace is already bound by credentialFetch; no `team`
  // field is synthesized for a message or receipt when the API omits it.
  const teamId = optionalString(message, "team_id");
  if (("team_id" in message && teamId !== input.expected.workspaceId)) return false;
  const team = optionalString(message, "team");
  if (("team" in message && team !== input.expected.workspaceId)) return false;

  if (optionalString(message, "app_id") !== input.expected.appId
    || optionalString(message, "bot_id") !== input.expected.botId) return false;

  const actualThread = optionalString(message, "thread_ts");
  if (input.threadTs === undefined) {
    if ("thread_ts" in message) return false;
  } else if (input.observed.ts === input.threadTs) {
    // Slack's root message normally omits thread_ts; if present it must still
    // point at the requested thread.
    if ("thread_ts" in message && actualThread !== input.threadTs) return false;
  } else if (actualThread !== input.threadTs) {
    return false;
  }

  const text = optionalString(message, "text");
  if (text === undefined) return false;
  return true;
}

async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function historyUrl(input: SlackDeliveryReadbackInput, cursor?: string): string {
  const query = new URLSearchParams({
    channel: input.observed.channel,
    oldest: input.window.oldest,
    latest: input.window.latest,
    inclusive: "true",
    limit: String(MAX_PAGE_SIZE),
  });
  const endpoint = input.threadTs === undefined ? "conversations.history" : "conversations.replies";
  if (input.threadTs !== undefined) query.set("ts", input.threadTs);
  if (cursor !== undefined) query.set("cursor", cursor);
  return `${SLACK_API_BASE_URL}/${endpoint}?${query.toString()}`;
}

/**
 * Reconciles an already observed Slack post through a broker-bound fetch.
 * This function only reads Slack history; it never posts, retries, or mutates
 * an outbox/metadata record. A single exact message is required for confirm.
 */
export async function readSlackDeliveryReadback(
  input: SlackDeliveryReadbackInput,
  credentialFetch: typeof fetch,
): Promise<SlackDeliveryReadbackResult> {
  const invalid = validateInput(input, credentialFetch);
  if (invalid) return unknownResult(input, invalid);

  const readNow = (): number | undefined => {
    try {
      const value = input.now?.() ?? Date.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const now = readNow();
  if (now === undefined) return unknownResult(input, "invalid_input");
  if (now >= input.expiresAt) return unknownResult(input, "expired");

  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let matchingMessages = 0;
  let sawObservedTimestamp = false;
  let sawMismatchedMessage = false;

  while (true) {
    if (pageCount >= maxPages) return unknownResult(input, "pagination_incomplete");
    const beforeRequest = readNow();
    if (beforeRequest === undefined) return unknownResult(input, "invalid_input");
    if (beforeRequest >= input.expiresAt) return unknownResult(input, "expired");
    pageCount += 1;

    let response: Response;
    try {
      response = await credentialFetch(new Request(historyUrl(input, cursor), {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      }));
    } catch (error) {
      return unknownResult(input, timeoutOrTransportReason(error));
    }

    if (response.status === 429) return unknownResult(input, "rate_limited");
    if (!response.ok) return unknownResult(input, "http_failure");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return unknownResult(input, "invalid_response");
    }
    const afterResponse = readNow();
    if (afterResponse === undefined) return unknownResult(input, "invalid_input");
    if (afterResponse >= input.expiresAt) return unknownResult(input, "expired");
    if (isRecord(payload) && payload.ok === false && payload.error === "ratelimited") {
      return unknownResult(input, "rate_limited");
    }
    const page = readPage(payload);
    if (!page) return unknownResult(input, "provider_rejected");

    for (const message of page.messages) {
      if (optionalString(message, "ts") !== input.observed.ts) continue;
      sawObservedTimestamp = true;
      if (!messageMatches(message, input)) {
        sawMismatchedMessage = true;
        continue;
      }
      try {
        const text = optionalString(message, "text");
        if (text === undefined || await textHash(text) !== input.bodyHash) {
          sawMismatchedMessage = true;
          continue;
        }
      } catch {
        return unknownResult(input, "invalid_response");
      }
      matchingMessages += 1;
    }

    if (page.hasMore && !page.nextCursor) return unknownResult(input, "pagination_incomplete");
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) return unknownResult(input, "pagination_incomplete");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (matchingMessages > 1) return unknownResult(input, "ambiguous");
  if (matchingMessages === 1) {
    return {
      state: "confirmed",
      receipt: safeReceipt(input),
    };
  }
  return unknownResult(input, sawObservedTimestamp && sawMismatchedMessage ? "message_mismatch" : "not_found");
}
