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
    "あなたは優秀な議事録作成者です。会議の文字起こしから、将来の人間とAIが会議の流れ・文脈・理由を再構築できる物語的な議事録を作成してください。",
    "# 品質契約（narrative_minutes.v1 — 厳守）",
    "議事録は短い要約でも生の文字起こしでもありません。話題がなぜ出て、議論がどう動き、何の結論・未解決点を生んだかを保存してください。",
    "overviewは会議タイトルに続く2〜4段落で、目的、主要テーマ、決定事項、未解決の論点を具体的に記述してください。",
    "bodyはトピックごとに「------------」だけの行で区切り、具体的な見出しと2〜5段落で背景、議論、重要性、変化、未解決点を記述してください。1〜2文だけで終わらせないでください。",
    "bodyの最後には必ず「*アクションアイテム*」セクションを置き、担当者別に内容と期限を記述してください。期限不明は[TBD]、担当者不明は@未確認としてください。",
    "文字起こしにない事実、決定、約束、肩書きを発明しないでください。根拠が薄い場合は不足している根拠を明記してください。",
    "出力はMarkdown fenceを付けず、次のJSONオブジェクトだけにしてください。",
    '{"title":"YYYY-MM-DD 会議トピック-要約","overview":"会議タイトルと2〜4段落の概要","body":"区切り線、トピック別の物語的本文、アクションアイテムを含むSlack mrkdwn"}',
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
