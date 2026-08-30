export interface ClaudeRuntimeBindings {
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
}

export interface ClaudeRuntimeConfig {
  readonly model: "opus" | "sonnet";
  readonly effort?: "xhigh";
}

export type RuntimeClaudePurpose = "reply" | "meeting-task" | "meeting-minutes";
export type RuntimeClaudeStructuredOutput = "meeting-minutes" | "meeting-minutes-routing";

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
const MEETING_MINUTES_MCP_CONFIG_PATH = "/tmp/mana-meeting-minutes-mcp.json";
const MEETING_MINUTES_SETTINGS_PATH = "/opt/mana/meeting-minutes-claude-settings.json";
const STRUCTURED_OUTPUT_SCHEMAS: Readonly<Record<RuntimeClaudeStructuredOutput, string>> = Object.freeze({
  "meeting-minutes": JSON.stringify({
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      overview: { type: "string", minLength: 1, maxLength: 600 },
      body: { type: "string", minLength: 1, maxLength: 100000 },
      tasks: {
        type: "array", maxItems: 20,
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 4000 },
            assignee_name: { type: "string", maxLength: 200 },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            due_at: { type: "string", maxLength: 64 },
          },
          required: ["title"], additionalProperties: false,
        },
      },
      used_source_refs: { type: "array", maxItems: 100, items: { type: "object", properties: {
        type: { type: "string", minLength: 1, maxLength: 100 }, id: { type: "string", minLength: 1, maxLength: 300 },
        ref: { type: "string", maxLength: 2000 },
      }, required: ["type", "id"], additionalProperties: false } },
      decision_candidates: { type: "array", maxItems: 20, items: { type: "object", properties: {
        title: { type: "string", minLength: 1, maxLength: 300 }, reason: { type: "string", maxLength: 2000 },
        source_ref_ids: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
      }, required: ["title"], additionalProperties: false } },
    },
    required: ["title", "overview", "body", "tasks", "used_source_refs", "decision_candidates"],
    additionalProperties: false,
  }),
  "meeting-minutes-routing": JSON.stringify({
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 128 },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["projectId", "reason"], additionalProperties: false,
  }),
});

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

export function runtimeMeetingMinutesMcpConfigPath(): string {
  return MEETING_MINUTES_MCP_CONFIG_PATH;
}

export function buildRuntimeClaudeCommand(
  purpose: RuntimeClaudePurpose,
  config: ClaudeRuntimeConfig,
  options: { taskSearchEnabled?: boolean; taskWriteEnabled?: boolean; mcpEnabled?: boolean;
    sessionId?: string; resumeSession?: boolean; structuredOutput?: RuntimeClaudeStructuredOutput;
    auditBrainbaseToolUse?: boolean; includeJudgmentHookEvents?: boolean } = {},
): string {
  if (config.model !== "opus" && config.model !== "sonnet") {
    throw new ClaudeRuntimeConfigError("runtime_claude_model_invalid");
  }
  if (config.model === "opus" && config.effort !== "xhigh") {
    throw new ClaudeRuntimeConfigError("runtime_claude_effort_invalid");
  }
  const promptPath = runtimeClaudePromptPath(purpose);
  const effortArg = config.effort ? ` --effort ${config.effort}` : "";
  if (options.sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.sessionId)) {
    throw new ClaudeRuntimeConfigError("runtime_claude_session_id_invalid");
  }
  const sessionArg = options.sessionId
    ? options.resumeSession ? ` --resume ${options.sessionId}` : ` --session-id ${options.sessionId}`
    : "";
  if (options.structuredOutput && purpose !== "meeting-minutes") {
    throw new ClaudeRuntimeConfigError("runtime_claude_structured_output_invalid");
  }
  if (options.auditBrainbaseToolUse && (purpose !== "meeting-minutes" || options.structuredOutput !== "meeting-minutes")) {
    throw new ClaudeRuntimeConfigError("runtime_claude_audit_output_invalid");
  }
  if (options.includeJudgmentHookEvents && options.structuredOutput) {
    throw new ClaudeRuntimeConfigError("runtime_claude_audit_output_invalid");
  }
  // Judgment Stop requires its exact owner-visible audit prefix at the start of
  // the assistant response. A JSON Schema would forbid that prefix, so audited
  // meeting-minutes use an unstructured stream and validate the embedded JSON
  // deterministically after the Hook lifecycle completes.
  const structuredOutputArg = options.structuredOutput
    ? options.auditBrainbaseToolUse
      ? ` --output-format stream-json --verbose --include-hook-events --json-schema '${STRUCTURED_OUTPUT_SCHEMAS[options.structuredOutput]}'`
      : ` --output-format json --json-schema '${STRUCTURED_OUTPUT_SCHEMAS[options.structuredOutput]}'`
    : options.includeJudgmentHookEvents ? " --output-format stream-json --verbose --include-hook-events" : "";
  const claude = "node /opt/mana/tenant-claude-runner.mjs --";
  const base = purpose === "meeting-minutes"
    ? `${claude} --print --model ${config.model}${effortArg} --permission-mode bypassPermissions --settings ${MEETING_MINUTES_SETTINGS_PATH}${structuredOutputArg}`
      + ` --mcp-config ${MEETING_MINUTES_MCP_CONFIG_PATH} --strict-mcp-config < ${promptPath}`
    : `${claude} --print --model ${config.model}${effortArg} --permission-mode bypassPermissions${sessionArg}`
      + `${purpose === "reply" && options.includeJudgmentHookEvents ? ` --settings ${MEETING_MINUTES_SETTINGS_PATH}` : ""}`
      + `${structuredOutputArg} "$(cat ${promptPath})"`;
  return purpose === "reply" && (options.taskSearchEnabled || options.taskWriteEnabled || options.mcpEnabled)
    ? `${base} --mcp-config ${TASK_SEARCH_MCP_CONFIG_PATH} --strict-mcp-config`
    : base;
}
