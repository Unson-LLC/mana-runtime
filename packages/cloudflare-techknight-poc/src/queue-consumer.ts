import type { SlackQueueEvent } from "./types.js";

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface QueueConsumerOptions {
  expectedTenantId?: string;
  expectedWorkspaceId: string;
  expectedChannelId?: string;
  expectedChannelIds?: readonly string[];
  process(event: SlackQueueEvent): Promise<{ outcome: string }>;
  log?(entry: Record<string, string>): void;
  logError?(entry: Record<string, string>): void;
  errorCode?(error: unknown): string;
}

function boundaryMismatchReason(
  event: SlackQueueEvent,
  expectedWorkspaceId: string,
  expectedTenantId = "techknight",
  expectedChannelId?: string,
  expectedChannelIds?: readonly string[],
): string | undefined {
  if (event.tenantId !== expectedTenantId) return "tenant_mismatch";
  if (event.workspaceId !== expectedWorkspaceId) return "workspace_mismatch";
  if (expectedChannelId !== undefined && event.channelId !== expectedChannelId) {
    return "channel_mismatch";
  }
  if (expectedChannelIds !== undefined && !expectedChannelIds.includes(event.channelId)) {
    return "channel_mismatch";
  }
  return undefined;
}

export async function consumeTechKnightMessage(
  message: QueueMessageLike<SlackQueueEvent>,
  options: QueueConsumerOptions,
): Promise<void> {
  const event = message.body;
  const mismatchReason = boundaryMismatchReason(
    event,
    options.expectedWorkspaceId,
    options.expectedTenantId,
    options.expectedChannelId,
    options.expectedChannelIds,
  );
  if (mismatchReason) {
    options.log?.({
      event: "techknight_slack_reply_ignored",
      eventId: event.eventId,
      channelId: event.channelId,
      reason: mismatchReason,
    });
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
