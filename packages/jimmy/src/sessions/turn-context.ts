export type ContextAvailability = "available" | "empty" | "unavailable";

export interface GraphContextSnapshot {
  status: ContextAvailability;
  content?: string;
  revision?: string;
  reasonCode?: string;
  observedAt: string;
}

export interface SharedConversationMessage {
  role: string;
  content: string;
  timestamp: number;
  sessionId?: string;
}

export interface SharedConversationSnapshot {
  status: ContextAvailability;
  messages: SharedConversationMessage[];
  reasonCode?: string;
  observedAt: string;
}

export interface EffectiveCapability {
  kind: "mcp";
  name: string;
  status: "available" | "denied" | "unavailable" | "unconfirmed";
  reasonCode?: string;
}

export interface TurnContextStatus {
  graph: ContextAvailability;
  sharedConversation: ContextAvailability;
  graphReasonCode?: string;
  sharedConversationReasonCode?: string;
  observedAt: string;
}
