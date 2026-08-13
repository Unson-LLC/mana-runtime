import type { GeneratedMeetingMinutes } from "./meeting-minutes-contracts.js";
import { buildRuntimeClaudeCommand, runtimeClaudePromptPath, type ClaudeRuntimeConfig } from "./claude-runtime-config.js";
import type { ReplySandbox } from "./reply-pipeline.js";

function nonEmpty(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function parseGeneratedMeetingMinutes(value: unknown): GeneratedMeetingMinutes {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const title = nonEmpty(record.title, 200); const overview = nonEmpty(record.overview, 3000);
  const body = nonEmpty(record.body, 100_000);
  if (!title || !overview || !body) throw new Error("meeting_minutes_generation_invalid");
  return { title, overview, body };
}

export function splitMeetingMinutesForSlack(body: string, maxChars = 2_900): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 100) throw new Error("slack_chunk_size_invalid");
  const chunks: string[] = [];
  let remaining = body.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = boundary >= Math.floor(maxChars * 0.5) ? boundary : maxChars;
    chunks.push(remaining.slice(0, cut).trim()); remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function generationPrompt(transcript: string): string {
  const bounded = transcript.replace(/\u0000/g, "").slice(0, 180_000);
  return [
    "次の会議文字起こしから日本語の議事録を作成してください。",
    "事実を補わず、曖昧な箇所は曖昧なまま記載してください。",
    "出力はMarkdown fenceを付けず、次のJSONオブジェクトだけにしてください。",
    '{"title":"会議名","overview":"短い概要","body":"Markdown形式の本文"}',
    "", "文字起こし:", bounded,
  ].join("\n");
}

export async function generateMeetingMinutesInSandbox(
  transcript: string,
  claudeRuntime: ClaudeRuntimeConfig,
  sandbox: ReplySandbox,
): Promise<GeneratedMeetingMinutes> {
  try {
    const promptPath = runtimeClaudePromptPath("meeting-minutes");
    await sandbox.writeFile(promptPath, generationPrompt(transcript));
    const result = await sandbox.exec(buildRuntimeClaudeCommand("meeting-minutes", claudeRuntime), {
      timeout: 180_000,
      env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
    });
    if (!result.success) throw new Error("meeting_minutes_generation_failed");
    let value: unknown;
    try { value = JSON.parse(result.stdout.trim()); } catch { throw new Error("meeting_minutes_generation_invalid"); }
    return parseGeneratedMeetingMinutes(value);
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
