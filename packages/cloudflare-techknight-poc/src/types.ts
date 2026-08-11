export interface SlackQueueEvent {
  tenantId: "techknight";
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId?: string;
  botId?: string;
  subtype?: string;
  eventType: string;
  text: string;
  receivedAt: string;
}
