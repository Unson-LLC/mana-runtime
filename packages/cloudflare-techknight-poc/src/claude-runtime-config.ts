export interface ClaudeRuntimeBindings {
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
}

export interface ClaudeRuntimeConfig {
  readonly model: "opus" | "sonnet";
  readonly effort?: "xhigh";
}

export type RuntimeClaudePurpose = "reply" | "meeting-task" | "meeting-minutes";

export class ClaudeRuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ClaudeRuntimeConfigError";
  }
}

const PROMPT_PATHS: Readonly<Record<RuntimeClaudePurpose, string>> = Object.freeze({
  reply: "/tmp/mana-slack-prompt.txt",
  "meeting-task": "/tmp/meeting-task-prompt.txt",
  "meeting-minutes": "/tmp/meeting-minutes-prompt.txt",
});
const TASK_SEARCH_MCP_CONFIG_PATH = "/tmp/mana-task-search-mcp.json";

export function resolveClaudeRuntimeConfig(bindings: ClaudeRuntimeBindings, modelOverride?: "opus" | "sonnet"): ClaudeRuntimeConfig {
  const model = modelOverride ?? bindings.RUNTIME_CLAUDE_MODEL;
  if (model !== "opus" && model !== "sonnet") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (model === "opus" && bindings.RUNTIME_CLAUDE_EFFORT !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  return Object.freeze({ model, ...(model === "opus" ? { effort: "xhigh" as const } : {}) });
}

export function runtimeClaudePromptPath(purpose: RuntimeClaudePurpose): string {
  return PROMPT_PATHS[purpose];
}

export function runtimeTaskSearchMcpConfigPath(): string {
  return TASK_SEARCH_MCP_CONFIG_PATH;
}

export function buildRuntimeClaudeCommand(
  purpose: RuntimeClaudePurpose,
  config: ClaudeRuntimeConfig,
  options: { taskSearchEnabled?: boolean; taskWriteEnabled?: boolean; mcpEnabled?: boolean } = {},
): string {
  if (config.model !== "opus" && config.model !== "sonnet") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (config.model === "opus" && config.effort !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  const promptPath = runtimeClaudePromptPath(purpose);
  const effortArg = config.effort ? ` --effort ${config.effort}` : "";
  const base = purpose === "meeting-minutes"
    ? `claude --print --model ${config.model}${effortArg} --permission-mode bypassPermissions < ${promptPath}`
    : `claude --print --model ${config.model}${effortArg} --permission-mode bypassPermissions "$(cat ${promptPath})"`;
  return purpose === "reply" && (options.taskSearchEnabled || options.taskWriteEnabled || options.mcpEnabled)
    ? `${base} --mcp-config ${TASK_SEARCH_MCP_CONFIG_PATH} --strict-mcp-config`
    : base;
}
