import type { SlackQueueEvent } from "./types.js";

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface QueueConsumerOptions {
  expectedTenantId?: string;
  expectedWorkspaceId: string;
  process(event: SlackQueueEvent): Promise<{ outcome: string }>;
  log?(entry: Record<string, string>): void;
  logError?(entry: Record<string, string>): void;
  errorCode?(error: unknown): string;
}

function isTechKnightEvent(
  event: SlackQueueEvent,
  expectedWorkspaceId: string,
  expectedTenantId = "techknight",
): boolean {
  return event.tenantId === expectedTenantId && event.workspaceId === expectedWorkspaceId;
}

export async function consumeTechKnightMessage(
  message: QueueMessageLike<SlackQueueEvent>,
  options: QueueConsumerOptions,
): Promise<void> {
  const event = message.body;
  if (!isTechKnightEvent(event, options.expectedWorkspaceId, options.expectedTenantId)) {
    message.ack();
    return;
  }

  try {
    const result = await options.process(event);
    options.log?.({
      event: "techknight_slack_reply",
      eventId: event.eventId,
      channelId: event.channelId,
      outcome: result.outcome,
    });
    message.ack();
  } catch (error) {
    options.logError?.({
      event: "techknight_slack_reply_failed",
      eventId: event.eventId,
      channelId: event.channelId,
      code: options.errorCode?.(error) ?? "unexpected_error",
    });
    message.retry();
  }
}
