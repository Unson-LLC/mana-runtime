export interface SlackQueueEvent {
  tenantId: string;
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
  /** Bounded prior thread messages. Never persisted to the Workspace store. */
  threadContext?: string;
  receivedAt: string;
}
