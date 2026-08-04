import type { TurnContextOptions, TurnPromptProvider } from "./turn-prompt-provider.js";
import type {
  EffectiveCapability,
  GraphContextSnapshot,
  SharedConversationSnapshot,
  TurnContextStatus,
} from "./turn-context.js";

export interface GraphContextHydrator {
  hydrate(input: {
    project?: string;
    workspace?: string;
    channelId?: string;
    sessionId?: string;
  }): Promise<GraphContextSnapshot>;
}

export interface SharedConversationQuery {
  connector: string;
  workspaceId?: string;
  channelId: string;
  placementId?: string;
  excludeSessionId?: string;
  limit?: number;
}

export type SharedConversationProvider = (
  input: SharedConversationQuery,
) => SharedConversationSnapshot | Promise<SharedConversationSnapshot>;

export interface TurnPreparationInput {
  promptOptions: TurnContextOptions;
  workspaceId?: string;
  sessionId: string;
  project?: string;
  effectiveCapabilities: EffectiveCapability[];
}

export interface PreparedTurn {
  systemPrompt: string;
  graphContext: GraphContextSnapshot;
  sharedConversationContext: SharedConversationSnapshot;
  effectiveCapabilities: EffectiveCapability[];
  contextStatus: TurnContextStatus;
}

/**
 * Builds one immutable, observable snapshot for a turn. Persona remains
 * workspace-common; only Graph facts, channel history and effective MCP
 * capabilities are scoped dynamically. Gateway tool policy remains a separate
 * placement-level enforcement boundary in the prompt builder.
 */
export class TurnPreparationService {
  constructor(private readonly deps: {
    promptProvider: TurnPromptProvider;
    graphClient: GraphContextHydrator;
    sharedConversationProvider: SharedConversationProvider;
  }) {}

  async prepare(input: TurnPreparationInput): Promise<PreparedTurn> {
    const channelId = input.promptOptions.channel;
    const [graphContext, sharedConversationContext] = await Promise.all([
      this.deps.graphClient.hydrate({
        project: input.project,
        workspace: input.workspaceId,
        channelId,
        sessionId: input.sessionId,
      }),
      this.deps.sharedConversationProvider({
        connector: input.promptOptions.source,
        workspaceId: input.workspaceId,
        channelId,
        placementId: input.promptOptions.placement?.id,
        excludeSessionId: input.sessionId,
      }),
    ]);
    const observedAt = new Date().toISOString();
    const contextStatus: TurnContextStatus = {
      graph: graphContext.status,
      sharedConversation: sharedConversationContext.status,
      graphReasonCode: graphContext.reasonCode,
      sharedConversationReasonCode: sharedConversationContext.reasonCode,
      observedAt,
    };
    const promptOptions = {
      ...input.promptOptions,
      graphContext,
      sharedConversationContext,
      effectiveCapabilities: input.effectiveCapabilities,
    };

    return {
      systemPrompt: this.deps.promptProvider(promptOptions),
      graphContext,
      sharedConversationContext,
      effectiveCapabilities: input.effectiveCapabilities,
      contextStatus,
    };
  }
}
