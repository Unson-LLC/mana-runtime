import {
  buildRuntimeClaudeCommand,
  runtimeTaskSearchMcpConfigPath,
  resolveClaudeRuntimeConfig,
  runtimeClaudePromptPath,
} from "../claude-runtime-config.js";

describe("Cloudflare Claude runtime config", () => {
  it("resolves the exact deployment policy", () => {
    const config = resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
    expect(config).toEqual({ model: "opus", effort: "xhigh" });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    [{ RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus" }, "runtime_claude_effort_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "", RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: " opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "OPUS", RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus; touch /tmp/pwned", RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "" }, "runtime_claude_effort_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh " }, "runtime_claude_effort_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "XHIGH" }, "runtime_claude_effort_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "medium" }, "runtime_claude_effort_invalid"],
    [{ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh && id" }, "runtime_claude_effort_invalid"],
  ])("rejects missing or non-allowlisted values: %j", (bindings, code) => {
    expect(() => resolveClaudeRuntimeConfig(bindings)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("uses the Lightsail-compatible sonnet placement model without inheriting opus effort", () => {
    const config = resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    }, "sonnet");
    expect(config).toEqual({ model: "sonnet" });
    expect(buildRuntimeClaudeCommand("reply", config)).toContain("--model sonnet --permission-mode");
    expect(buildRuntimeClaudeCommand("reply", config)).not.toContain("--effort");
  });

  it("builds commands exclusively from finite validated tokens", () => {
    const config = resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
    expect(runtimeClaudePromptPath("reply")).toBe("/tmp/mana-slack-prompt.txt");
    expect(runtimeClaudePromptPath("meeting-task")).toBe("/tmp/meeting-task-prompt.txt");
    expect(buildRuntimeClaudeCommand("reply", config)).toBe(
      'claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/mana-slack-prompt.txt)"',
    );
    expect(buildRuntimeClaudeCommand("meeting-task", config)).toBe(
      'claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/meeting-task-prompt.txt)"',
    );
  });

  it("puts the prompt before the variadic MCP option and enables strict config", () => {
    const config = resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
    expect(runtimeTaskSearchMcpConfigPath()).toBe("/tmp/mana-task-search-mcp.json");
    expect(buildRuntimeClaudeCommand("reply", config, { taskSearchEnabled: true })).toBe(
      'claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/mana-slack-prompt.txt)" --mcp-config /tmp/mana-task-search-mcp.json --strict-mcp-config',
    );
    expect(buildRuntimeClaudeCommand("meeting-task", config, { taskSearchEnabled: true }))
      .not.toContain("--mcp-config");
  });
});
