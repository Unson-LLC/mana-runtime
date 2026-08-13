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
const TASK_SEARCH_MCP_CONFIG_PATH = "/tmp/mana-task-search-mcp.json";

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

export function runtimeTaskSearchMcpConfigPath(): string {
  return TASK_SEARCH_MCP_CONFIG_PATH;
}

export function buildRuntimeClaudeCommand(
  purpose: RuntimeClaudePurpose,
  config: ClaudeRuntimeConfig,
  options: { taskSearchEnabled?: boolean; taskWriteEnabled?: boolean } = {},
): string {
  if (config.model !== "opus") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (config.effort !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  const promptPath = runtimeClaudePromptPath(purpose);
  const base = `claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat ${promptPath})"`;
  return purpose === "reply" && (options.taskSearchEnabled || options.taskWriteEnabled)
    ? `${base} --mcp-config ${TASK_SEARCH_MCP_CONFIG_PATH} --strict-mcp-config`
    : base;
}
