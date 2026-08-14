export interface RuntimeTriageInput {
  botName: string;
  persona?: string;
  speakerName: string;
  channelType: string;
  messageText: string;
  recentThread: Array<{ speaker: string; text: string }>;
}

export interface RuntimeTriageDecision {
  action: "silent" | "react" | "reply";
  emoji?: string;
  reason?: string;
}

interface TriageSandbox {
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string, options?: { env?: Record<string, string | undefined>; timeout?: number }): Promise<{
    success: boolean; stdout: string; stderr: string;
  }>;
  destroy(): Promise<void>;
}

export function buildRuntimeTriagePrompt(input: RuntimeTriageInput): string {
  const recent = input.recentThread.slice(-10).map(({ speaker, text }) =>
    `- [${speaker.slice(0, 80)}] ${text.trim().slice(0, 300)}`).join("\n") || "(no prior messages)";
  return `You are a TRIAGE classifier for ${input.botName}, an AI assistant on Slack.
Output exactly one JSON object and nothing else:
{"action":"silent"|"react"|"reply","emoji":"slack emoji without colons","reason":"short reason"}

silent: do nothing. react: add one emoji only. reply: write a useful response.
Persona: ${input.persona?.trim() || `${input.botName} is a helpful Slack assistant.`}
Channel type: ${input.channelType}
Speaker: ${input.speakerName}
Recent thread:
${recent}
Message:
"""
${input.messageText.trim().slice(0, 2000)}
"""

Rules, in order:
1. A short acknowledgment or thanks directed at the assistant -> react.
2. A request addressed to the assistant, a continuation of its exchange, or a topic where its expertise adds concrete wanted value -> reply.
3. Otherwise -> silent.
Do not intrude into casual conversation between other people. Prefer silence below 60% confidence.`;
}

export function parseRuntimeTriageDecision(raw: string): RuntimeTriageDecision | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const match = (fenced?.[1] ?? raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>;
    if (value.action !== "silent" && value.action !== "react" && value.action !== "reply") return null;
    const emojiValue = typeof value.emoji === "string" ? value.emoji.trim().replace(/^:+|:+$/g, "") : "";
    return {
      action: value.action,
      ...(emojiValue || value.action === "react" ? { emoji: emojiValue || "eyes" } : {}),
      reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 120) : undefined,
    };
  } catch {
    return null;
  }
}

export async function runRuntimeTriage(input: RuntimeTriageInput, options: {
  model: "sonnet" | "opus";
  effort?: "xhigh";
  createSandbox(id: string): TriageSandbox;
}): Promise<RuntimeTriageDecision> {
  const sandbox = options.createSandbox(`triage-${crypto.randomUUID()}`);
  const promptPath = "/tmp/mana-triage-prompt.txt";
  try {
    await sandbox.writeFile(promptPath, buildRuntimeTriagePrompt(input));
    const effort = options.effort ? ` --effort ${options.effort}` : "";
    const result = await sandbox.exec(
      `claude --print --model ${options.model}${effort} --permission-mode bypassPermissions "$(cat ${promptPath})"`,
      { timeout: 30_000, env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" } },
    );
    if (!result.success) return { action: "silent", reason: "triage_error" };
    return parseRuntimeTriageDecision(result.stdout) ?? { action: "silent", reason: "parse_failed" };
  } catch {
    return { action: "silent", reason: "triage_error" };
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
