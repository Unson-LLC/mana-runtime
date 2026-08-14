import type { GeneratedMeetingMinutes, MeetingMinutesDestination,
  MeetingMinutesTaskCandidate } from "./meeting-minutes-contracts.js";
import { buildRuntimeClaudeCommand, runtimeClaudePromptPath, runtimeMeetingMinutesMcpConfigPath, type ClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { buildRuntimeMcpConfig } from "./runtime-mcp-config.js";
import type { ReplySandbox } from "./reply-pipeline.js";

const MEETING_MINUTES_GENERATION_TIMEOUT_MS = 600_000;
const MEETING_MINUTES_ROUTING_TIMEOUT_MS = 60_000;
const MEETING_MINUTES_ROUTING_HEAD_CHARS = 4_000;
const SLACK_ACTIVE_CONSTRUCT_RE = /<([@#!]|https?:|mailto:)/gi;
const CONTROL_CHARACTERS_RE = /[\u0000-\u001f\u007f]/g;
const MEETING_MINUTES_MCP_CONFIG = JSON.stringify(buildRuntimeMcpConfig({
  mcp: ["brainbase"], gatewayTools: [],
}));

async function prepareMeetingMinutesRuntime(sandbox: ReplySandbox, prompt: string): Promise<void> {
  await sandbox.writeFile(runtimeClaudePromptPath("meeting-minutes"), prompt);
  await sandbox.writeFile(runtimeMeetingMinutesMcpConfigPath(), MEETING_MINUTES_MCP_CONFIG);
}

function nonEmpty(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function parseGeneratedMeetingMinutes(value: unknown): GeneratedMeetingMinutes {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const title = nonEmpty(record.title, 200); const overview = nonEmpty(record.overview, 600);
  const body = stripMeetingMinutesActionItems(nonEmpty(record.body, 100_000) ?? "");
  if (!title || !overview || !body) throw new Error("meeting_minutes_generation_invalid");
  const rawTasks = record.tasks === undefined ? [] : record.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length > 20) throw new Error("meeting_minutes_generation_invalid");
  const tasks = rawTasks.map((item): MeetingMinutesTaskCandidate | undefined => {
    const task = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const taskTitle = nonEmpty(task.title, 200); if (!taskTitle) return undefined;
    const description = nonEmpty(task.description, 4_000);
    const assignee_name = nonEmpty(task.assignee_name, 200);
    const rawPriority = nonEmpty(task.priority, 16)?.toLowerCase();
    const priority = rawPriority && ["low", "medium", "high", "urgent"].includes(rawPriority)
      ? rawPriority as MeetingMinutesTaskCandidate["priority"] : undefined;
    const rawDueAt = nonEmpty(task.due_at, 64);
    const due_at = rawDueAt && /^\d{4}-\d{2}-\d{2}$/.test(rawDueAt) ? `${rawDueAt}T00:00:00+09:00`
      : rawDueAt && !Number.isNaN(Date.parse(rawDueAt)) ? rawDueAt : undefined;
    return { title: taskTitle, ...(description ? { description } : {}), ...(assignee_name ? { assignee_name } : {}), ...(priority ? { priority } : {}),
      ...(due_at ? { due_at } : {}) };
  });
  if (tasks.some((task) => !task)) throw new Error("meeting_minutes_generation_invalid");
  return { title, overview, body, tasks: tasks as MeetingMinutesTaskCandidate[] };
}

/** Removes a legacy generated action-item tail so tasks[] remains the only action-item source. */
export function stripMeetingMinutesActionItems(body: string): string {
  return body.replace(/\n+(?:(?:#{1,6}\s+)|\*)?アクションアイテム(?:\*)?\s*\n[\s\S]*$/u, "").trim();
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        objects.push(text.slice(start, index + 1)); break;
      }
    }
  }
  return objects;
}

function routingPrompt(transcript: string, destinations: readonly MeetingMinutesDestination[]): string {
  const head = transcript.replace(/\u0000/g, "").slice(0, MEETING_MINUTES_ROUTING_HEAD_CHARS);
  const candidates = destinations.map((item) => `- ${item.projectId}: ${item.name}（${item.organization.name}）`).join("\n");
  return [
    "あなたは会議の文字起こしを、どのプロジェクトの会議かに分類する係です。",
    "# プロジェクト候補（この中からのみ選ぶ）", candidates,
    "# 文字起こし（冒頭）", '"""', head, '"""',
    "# 出力（厳守）",
    "JSONオブジェクトを1つだけ出力する。markdown・コードフェンス・前後の文章は禁止。",
    '{"projectId":"<候補のprojectId or 不明>","reason":"<判断根拠1文>"}',
    '候補のどれとも確信を持って一致しない場合は "不明" とする。推測で選ばない。',
  ].join("\n\n");
}

function sanitizeRoutingReason(value: string): string {
  return value.replace(CONTROL_CHARACTERS_RE, " ").replace(SLACK_ACTIVE_CONSTRUCT_RE, "&lt;$1");
}

export function parseMeetingMinutesRoutingOutput(raw: string,
  destinations: readonly MeetingMinutesDestination[]): { destinationId: string; reason: string } | null {
  for (const candidate of [raw.trim(), ...balancedJsonObjects(raw)]) {
    try {
      const value = JSON.parse(candidate) as unknown;
      const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const projectId = nonEmpty(record?.projectId, 128); const reason = nonEmpty(record?.reason, 500);
      if (!projectId || projectId === "不明" || !reason) continue;
      const destination = destinations.find((item) => item.projectId === projectId);
      if (destination) return { destinationId: destination.id, reason: sanitizeRoutingReason(reason) };
    } catch { /* try next candidate */ }
  }
  return null;
}

export async function classifyMeetingMinutesDestinationInSandbox(
  transcript: string,
  destinations: readonly MeetingMinutesDestination[],
  claudeRuntime: ClaudeRuntimeConfig,
  sandbox: ReplySandbox,
): Promise<{ destinationId: string; reason: string } | null> {
  try {
    await prepareMeetingMinutesRuntime(sandbox, routingPrompt(transcript, destinations));
    const result = await sandbox.exec(buildRuntimeClaudeCommand("meeting-minutes", claudeRuntime, {
      structuredOutput: "meeting-minutes-routing",
    }), {
      timeout: MEETING_MINUTES_ROUTING_TIMEOUT_MS,
      env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
    });
    if (!result.success) return null;
    return parseMeetingMinutesRoutingOutput(result.stdout, destinations);
  } catch {
    return null;
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}

export function parseGeneratedMeetingMinutesOutput(stdout: string): GeneratedMeetingMinutes {
  const candidates = [stdout.trim(), ...balancedJsonObjects(stdout)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      const wrapper = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
      const unwrapped = wrapper?.structured_output ?? wrapper?.structuredOutput ?? value;
      try { return parseGeneratedMeetingMinutes(unwrapped); } catch {
        if (typeof wrapper?.result === "string") {
          for (const nested of [wrapper.result.trim(), ...balancedJsonObjects(wrapper.result)]) {
            try { return parseGeneratedMeetingMinutes(JSON.parse(nested)); } catch { /* try next candidate */ }
          }
        }
      }
    } catch { /* try next candidate */ }
  }
  throw new Error("meeting_minutes_generation_invalid");
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
    "overviewは1段落・3〜5文・200〜400字を目安にし、600字を絶対に超えないでください。会議の目的、主要な決定事項、重要な未解決点だけを簡潔に記述してください。詳細な背景、議論の経過、アクションアイテム、タスク一覧は含めないでください。",
    "bodyはトピックごとに「------------」だけの行で区切り、具体的な見出しと2〜5段落で背景、議論、重要性、変化、未解決点を記述してください。1〜2文だけで終わらせないでください。",
    "bodyにはアクションアイテムやタスクの一覧を含めないでください。アクションアイテムの唯一の正本はtasksです。",
    "tasksには、会議中に実行することが明示されたアクションだけを最大20件入れてください。推測でタスク、担当者、期限を補わないでください。期限や担当者が不明なら該当フィールドを省略し、該当するアクションがなければ空配列にしてください。",
    "文字起こしにない事実、決定、約束、肩書きを発明しないでください。根拠が薄い場合は不足している根拠を明記してください。",
    "出力はMarkdown fenceを付けず、次のJSONオブジェクトだけにしてください。",
    '{"title":"YYYY-MM-DD 会議トピック-要約","overview":"1段落・3〜5文の短い概要","body":"区切り線とトピック別の物語的本文。アクションアイテム一覧は含めない","tasks":[{"title":"実行内容","description":"会議で確認できた背景","assignee_name":"文字起こしで明示された担当者名。未確認なら省略","priority":"low|medium|high|urgent","due_at":"YYYY-MM-DD"}]}',
    "", "文字起こし:", bounded,
  ].join("\n");
}

export async function generateMeetingMinutesInSandbox(
  transcript: string,
  claudeRuntime: ClaudeRuntimeConfig,
  sandbox: ReplySandbox,
): Promise<GeneratedMeetingMinutes> {
  try {
    await prepareMeetingMinutesRuntime(sandbox, generationPrompt(transcript));
    const result = await sandbox.exec(buildRuntimeClaudeCommand("meeting-minutes", claudeRuntime, {
      structuredOutput: "meeting-minutes",
    }), {
      timeout: MEETING_MINUTES_GENERATION_TIMEOUT_MS,
      env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
    });
    if (!result.success) throw new Error("meeting_minutes_generation_failed");
    return parseGeneratedMeetingMinutesOutput(result.stdout);
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
