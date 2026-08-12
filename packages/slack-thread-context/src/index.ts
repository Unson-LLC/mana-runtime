export const SLACK_THREAD_CONTEXT_MAX_MESSAGES = 100;
export const SLACK_THREAD_CONTEXT_MAX_CHARS = 20_000;

export interface SlackThreadContextMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
}

export interface SlackThreadRepliesPage {
  messages?: SlackThreadContextMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export type SlackThreadReplies = (args: {
  channel: string;
  ts: string;
  inclusive: true;
  limit: number;
  cursor?: string;
}) => Promise<SlackThreadRepliesPage>;

/** Format a bounded chronological snapshot, excluding the triggering event. */
export function formatSlackThreadContext(
  messages: SlackThreadContextMessage[],
  currentTs: string,
  hasMore = false,
): string {
  const filtered = messages.filter((message) => message.ts !== currentTs && message.text?.trim());
  const capped = filtered.length > SLACK_THREAD_CONTEXT_MAX_MESSAGES;
  const candidates = capped
    ? [filtered[0]!, ...filtered.slice(-(SLACK_THREAD_CONTEXT_MAX_MESSAGES - 1))]
    : filtered;
  if (candidates.length === 0) return "";
  const line = (message: SlackThreadContextMessage) => {
    const author = message.user ? `<@${message.user}>` : message.bot_id ? `[bot:${message.bot_id}]` : "[unknown]";
    return `${author}: ${message.text!.trim()}`;
  };
  const omittedMarker = "[some thread replies omitted due to context limit]";
  const rawRoot = line(candidates[0]!);
  const suffix: string[] = [];
  const minimumRootBudget = Math.min(rawRoot.length, 8_000);
  let suffixChars = 0;
  for (const message of candidates.slice(1).reverse()) {
    const value = line(message);
    const fixedBudget = "[Slack thread context]\n".length + omittedMarker.length + 4;
    if (fixedBudget + minimumRootBudget + suffixChars + value.length + 1 > SLACK_THREAD_CONTEXT_MAX_CHARS) break;
    suffix.unshift(value);
    suffixChars += value.length + 1;
  }
  const omitted = hasMore || capped || suffix.length < candidates.length - 1;
  const fixedChars = "[Slack thread context]\n".length
    + (omitted ? omittedMarker.length + 1 : 0)
    + suffixChars
    + 2;
  const rootBudget = Math.max(1, SLACK_THREAD_CONTEXT_MAX_CHARS - fixedChars);
  const root = rawRoot.length > rootBudget ? `${rawRoot.slice(0, Math.max(0, rootBudget - 1))}…` : rawRoot;
  const rendered = [
    "[Slack thread context]",
    root,
    ...(omitted ? [omittedMarker] : []),
    ...suffix,
    "",
    "",
  ].join("\n");
  return rendered.length <= SLACK_THREAD_CONTEXT_MAX_CHARS ? rendered : rendered.slice(0, SLACK_THREAD_CONTEXT_MAX_CHARS);
}

/** Fetch bounded pages even when Slack returns a short page before EOF. */
export async function hydrateSlackThreadContext(
  replies: SlackThreadReplies,
  channel: string,
  threadTs: string,
  currentTs: string,
): Promise<string> {
  const messages: SlackThreadContextMessage[] = [];
  const seenMessageTs = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasMore = false;
  let pageCount = 0;

  while (messages.length < SLACK_THREAD_CONTEXT_MAX_MESSAGES && pageCount < 10) {
    pageCount += 1;
    const page = await replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: SLACK_THREAD_CONTEXT_MAX_MESSAGES - messages.length,
      ...(cursor ? { cursor } : {}),
    });
    for (const message of page.messages ?? []) {
      const key = message.ts?.trim();
      if (key && seenMessageTs.has(key)) continue;
      if (key) seenMessageTs.add(key);
      messages.push(message);
      if (messages.length >= SLACK_THREAD_CONTEXT_MAX_MESSAGES) break;
    }
    const nextCursor = page.response_metadata?.next_cursor?.trim();
    hasMore = page.has_more === true || Boolean(nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor) || messages.length >= SLACK_THREAD_CONTEXT_MAX_MESSAGES) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (pageCount >= 10 && cursor) hasMore = true;
  return formatSlackThreadContext(messages, currentTs, hasMore);
}
