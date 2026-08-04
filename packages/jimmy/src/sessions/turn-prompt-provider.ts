import { buildContext, type BuildContextOptions } from "./context.js";
import type { RuntimeInstructionProvider } from "./runtime-instructions.js";

export type TurnContextOptions = Omit<BuildContextOptions, "runtimeInstructions">;
export type TurnPromptProvider = (options: TurnContextOptions) => string;

/**
 * Single composition path for connector, cron, and web turns.
 * The common persona is loaded first, then buildContext appends the more
 * specific dynamic session and placement policy.
 */
export function createTurnPromptProvider(
  runtimeInstructionProvider: RuntimeInstructionProvider,
): TurnPromptProvider {
  return (options) => {
    const runtimeInstructions = runtimeInstructionProvider({
      portalName: options.portalName || options.config?.portal?.portalName || "Ryoko",
      placementId: options.placement?.id,
    }).content;
    return buildContext({ ...options, runtimeInstructions });
  };
}
