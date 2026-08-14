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
  /** Bounded, trusted attachment metadata and decoded text. Never persisted. */
  attachmentContext?: string;
  receivedAt: string;
  /** Bounded Slack file identities. Download URLs are intentionally excluded. */
  files?: SlackFileReference[];
}

export interface SlackFileReference {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
}
