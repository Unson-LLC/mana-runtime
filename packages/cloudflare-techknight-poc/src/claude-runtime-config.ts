export interface ClaudeRuntimeBindings {
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
}

export interface ClaudeRuntimeConfig {
  readonly model: "opus";
  readonly effort: "xhigh";
}

export type RuntimeClaudePurpose = "reply" | "meeting-task";

export class ClaudeRuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ClaudeRuntimeConfigError";
  }
}

const PROMPT_PATHS: Readonly<Record<RuntimeClaudePurpose, string>> = Object.freeze({
  reply: "/tmp/mana-slack-prompt.txt",
  "meeting-task": "/tmp/meeting-task-prompt.txt",
});

const RESOLVED_CONFIG: ClaudeRuntimeConfig = Object.freeze({
  model: "opus",
  effort: "xhigh",
});

export function resolveClaudeRuntimeConfig(bindings: ClaudeRuntimeBindings): ClaudeRuntimeConfig {
  if (bindings.RUNTIME_CLAUDE_MODEL !== "opus") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (bindings.RUNTIME_CLAUDE_EFFORT !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  return RESOLVED_CONFIG;
}

export function runtimeClaudePromptPath(purpose: RuntimeClaudePurpose): string {
  return PROMPT_PATHS[purpose];
}

export function buildRuntimeClaudeCommand(
  purpose: RuntimeClaudePurpose,
  config: ClaudeRuntimeConfig,
): string {
  if (config.model !== "opus") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (config.effort !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  const promptPath = runtimeClaudePromptPath(purpose);
  return `claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat ${promptPath})"`;
}
