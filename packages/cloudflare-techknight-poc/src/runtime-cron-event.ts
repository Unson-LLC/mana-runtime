import type { RuntimeCronJob } from "./runtime-cron.js";
import type { SlackQueueEvent } from "./types.js";

/**
 * Turn an explicitly-authorized `/cron run` into an ordinary runtime turn.
 * The new event stays inside the source placement and reuses the requester and
 * thread, so the normal audience, identity, project, delivery, and idempotency
 * boundaries are applied again by the queue consumer.
 */
export function createManualCronEvent(
  source: SlackQueueEvent,
  job: RuntimeCronJob,
  receivedAt: string,
): SlackQueueEvent {
  if (!source.userId) throw new Error("cron_requester_missing");
  if (job.delivery.connector !== "slack" || job.delivery.channel !== source.channelId) {
    throw new Error("cron_delivery_scope_mismatch");
  }
  return {
    tenantId: source.tenantId,
    eventId: `cron:${source.eventId}:${job.id}`,
    workspaceId: source.workspaceId,
    channelId: source.channelId,
    channelType: source.channelType,
    threadTs: source.threadTs,
    messageTs: source.messageTs,
    userId: source.userId,
    eventType: "message",
    text: job.prompt,
    receivedAt,
  };
}
