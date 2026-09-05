import {
  buildRuntimeClaudeCommand,
  runtimeMeetingMinutesMcpConfigPath,
  runtimeReplySettingsContent,
  runtimeTaskSearchMcpConfigPath,
  resolveClaudeRuntimeConfig,
  runtimeClaudePromptPath,
} from "../claude-runtime-config.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
      'node /opt/mana/tenant-claude-runner.mjs -- --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/mana-slack-prompt.txt)"',
    );
    expect(buildRuntimeClaudeCommand("meeting-task", config)).toBe(
      'node /opt/mana/tenant-claude-runner.mjs -- --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/meeting-task-prompt.txt)"',
    );
  });

  it("puts the prompt before the variadic MCP option and enables strict config", () => {
    const config = resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
    expect(runtimeTaskSearchMcpConfigPath()).toBe("/tmp/mana-task-search-mcp.json");
    expect(buildRuntimeClaudeCommand("reply", config, { taskSearchEnabled: true })).toBe(
      'node /opt/mana/tenant-claude-runner.mjs -- --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/mana-slack-prompt.txt)" --mcp-config /tmp/mana-task-search-mcp.json --strict-mcp-config',
    );
    expect(buildRuntimeClaudeCommand("meeting-task", config, { taskSearchEnabled: true }))
      .not.toContain("--mcp-config");
  });

  it("story-meeting-minutes-brainbase-judgment:ac:1 story-meeting-minutes-brainbase-judgment:ac:2 enables command Hooks without model-origin Brainbase MCP for meeting-minutes", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" });
    expect(runtimeMeetingMinutesMcpConfigPath()).toBe("/tmp/mana-meeting-minutes-mcp.json");
    expect(buildRuntimeClaudeCommand("meeting-minutes", config)).toBe(
      "node /opt/mana/tenant-claude-runner.mjs -- --print --model opus --effort xhigh --permission-mode bypassPermissions --setting-sources '' --settings /opt/mana/meeting-minutes-claude-settings.json --mcp-config /tmp/mana-meeting-minutes-mcp.json --strict-mcp-config < /tmp/meeting-minutes-prompt.txt",
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

  it("mana-reply-judgment-hook-503:ac:1 ac:2 uses reply-specific Judgment Hook settings", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" });
    const command = buildRuntimeClaudeCommand("meeting-minutes", config, {
      structuredOutput: "meeting-minutes",
      includeJudgmentHookEvents: true,
    });
    expect(command).toContain("--include-hook-events");
    expect(command).toContain("--setting-sources ''");
    expect(command).toContain("--settings /opt/mana/meeting-minutes-claude-settings.json");
    expect(command).toContain("--mcp-config /tmp/mana-meeting-minutes-mcp.json");
    expect(command).toContain("--strict-mcp-config");
    const reply = buildRuntimeClaudeCommand("reply", config, { includeJudgmentHookEvents: true });
    expect(reply).toContain("--output-format stream-json --verbose --include-hook-events");
    expect(reply).toContain("--settings /tmp/mana-reply-claude-settings.json");
    expect(reply).toContain("--append-system-prompt");
    expect(reply).toContain("first assistant action MUST be exactly one call to mcp__brainbase__brainbase_resolve_turn");
    expect(reply).toContain("Classify by meaning, not keywords");
    expect(reply).toContain("current location of runtime configuration");
    expect(reply).toContain("Hook-provided turn_input object unchanged into turn_input");
    expect(reply).toContain('"intent":"answer|investigate|diagnose|design|implement|review|operate"');
    expect(reply).toContain('"domains":["general|knowledge|personal_judgment|engineering|organization|operations"]');
    expect(reply).toContain('"signals":["zero or more of: cumulative_effect|complexity_growth|threshold_proposal|parallel_exploration|authority_boundary|problem_frame_uncertain|external_outcome"]');
    expect(reply).not.toContain("turn_ref");
    expect(reply).toContain("After it succeeds, never call resolve_turn again");
    expect(reply).toContain("when knowledge.resolve is required, call mcp__brainbase__brainbase_knowledge_resolve");
    expect(reply).not.toContain("Read turn_input from the UserPromptSubmit Hook context");

    const settingsPath = fileURLToPath(new URL("../../container/reply-claude-settings.json", import.meta.url));
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    };
    expect(Object.keys(settings.hooks)).toEqual([
      "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
    ]);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe(".*");
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe("^mcp__brainbase__.*$");
    expect(settings.hooks.PostToolUseFailure?.[0]?.matcher).toBe("^mcp__brainbase__.*$");
    expect(JSON.parse(runtimeReplySettingsContent())).toEqual(settings);
    for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"] as const) {
      expect(settings.hooks[eventName]?.[0]?.hooks).toEqual([
        {
          type: "command",
          command: "node /opt/mana/brainbase-judgment-hook.mjs",
          timeout: 45,
        },
      ]);
    }
  });

  it("mana-reply-judgment-hook-503:ac:3 keeps meeting-minutes settings isolated", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "sonnet" });
    const meetingMinutes = buildRuntimeClaudeCommand("meeting-minutes", config);
    expect(meetingMinutes).toContain("--settings /opt/mana/meeting-minutes-claude-settings.json");
    expect(meetingMinutes).not.toContain("reply-claude-settings.json");
    const settingsPath = fileURLToPath(new URL("../../container/meeting-minutes-claude-settings.json", import.meta.url));
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ hooks: {} });
  });

  it("starts then resumes the same validated Claude session", () => {
    const config = resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "sonnet" });
    const sessionId = "12345678-1234-4123-8123-123456789abc";
    expect(buildRuntimeClaudeCommand("reply", config, { sessionId }))
      .toContain(`--session-id ${sessionId}`);
    expect(buildRuntimeClaudeCommand("reply", config, { sessionId, resumeSession: true }))
      .toContain(`--resume ${sessionId}`);
    expect(buildRuntimeClaudeCommand("reply", config, {
      sessionId,
      resumeSession: true,
      includeJudgmentHookEvents: true,
    })).toContain("A CLI invocation using --resume creates a new Hook turn");
    expect(buildRuntimeClaudeCommand("reply", config, { includeJudgmentHookEvents: true }))
      .toContain("use the complete original user request as the knowledge intent");
    expect(buildRuntimeClaudeCommand("reply", config, { includeJudgmentHookEvents: true }))
      .toContain("Do not substitute brainbase_admin_read or brainbase_bootstrap_config");
    expect(() => buildRuntimeClaudeCommand("reply", config, { sessionId: "$(unsafe)" }))
      .toThrow("runtime_claude_session_id_invalid");
  });
});
