export type RuntimeRespondMode = "always" | "mention" | "never";
export interface RuntimeRespondPolicy {
  im: RuntimeRespondMode;
  mpim: RuntimeRespondMode;
  channel: RuntimeRespondMode;
  engagedThreads: boolean;
}

export type RuntimeRespondDecision = { allow: true } | { allow: false; reason: string };

function scope(channelType: string | undefined): "im" | "mpim" | "channel" {
  if (channelType === "im") return "im";
  if (channelType === "mpim") return "mpim";
  return "channel";
}

export function evaluateRuntimeRespondPolicy(input: {
  config: RuntimeRespondPolicy;
  channelType?: string;
  wasMentioned: boolean;
  isEngagedThread: boolean;
}): RuntimeRespondDecision {
  const target = scope(input.channelType);
  const mode = input.config[target];
  if (mode === "never") return { allow: false, reason: `respondTo.${target}=never` };
  if (mode === "mention" && !input.wasMentioned && !(input.config.engagedThreads && input.isEngagedThread)) {
    return { allow: false, reason: `respondTo.${target}=mention` };
  }
  return { allow: true };
}
