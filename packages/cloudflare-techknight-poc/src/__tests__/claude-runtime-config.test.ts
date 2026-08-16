import {
  buildRuntimeClaudeCommand,
  runtimeTaskSearchMcpConfigPath,
  runtimeMeetingMinutesMcpConfigPath,
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

  it("story-meeting-minutes-brainbase-judgment:ac:1 story-meeting-minutes-brainbase-judgment:ac:2 always enables Brainbase MCP and command Hooks for meeting-minutes", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" });
    expect(runtimeMeetingMinutesMcpConfigPath()).toBe("/tmp/mana-meeting-minutes-mcp.json");
    expect(buildRuntimeClaudeCommand("meeting-minutes", config)).toBe(
      "claude --print --model opus --effort xhigh --permission-mode bypassPermissions --settings /opt/mana/meeting-minutes-claude-settings.json --mcp-config /tmp/mana-meeting-minutes-mcp.json --strict-mcp-config < /tmp/meeting-minutes-prompt.txt",
    );
  });

  it("forces schema-validated JSON for meeting-minutes structured outputs", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" });
    const minutes = buildRuntimeClaudeCommand("meeting-minutes", config, { structuredOutput: "meeting-minutes" });
    const routing = buildRuntimeClaudeCommand("meeting-minutes", config, { structuredOutput: "meeting-minutes-routing" });
    expect(minutes).toContain("--output-format json --json-schema '");
    expect(minutes).toContain('"required":["title","overview","body","tasks","used_source_refs",' +
      '"decision_candidates"]');
    expect(minutes).not.toContain("brainbase_context_receipt_id");
    expect(minutes).not.toContain("brainbase_context_checksum");
    expect(minutes).toContain('"overview":{"type":"string","minLength":1,"maxLength":600}');
    expect(routing).toContain('"required":["projectId","reason"]');
    expect(() => buildRuntimeClaudeCommand("reply", config, { structuredOutput: "meeting-minutes" }))
      .toThrow("runtime_claude_structured_output_invalid");
  });

  it("starts then resumes the same validated Claude session", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "sonnet" });
    const sessionId = "12345678-1234-4123-8123-123456789abc";
    expect(buildRuntimeClaudeCommand("reply", config, { sessionId }))
      .toContain(`--session-id ${sessionId}`);
    expect(buildRuntimeClaudeCommand("reply", config, { sessionId, resumeSession: true }))
      .toContain(`--resume ${sessionId}`);
    expect(() => buildRuntimeClaudeCommand("reply", config, { sessionId: "$(unsafe)" }))
      .toThrow("runtime_claude_session_id_invalid");
  });
});
