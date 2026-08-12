import {
  buildRuntimeClaudeCommand,
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
    [{ RUNTIME_CLAUDE_MODEL: "sonnet", RUNTIME_CLAUDE_EFFORT: "xhigh" }, "runtime_claude_model_invalid"],
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
});
