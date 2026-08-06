/**
 * Meeting-minutes pipeline — the two LLM stages (routing classification and
 * minutes generation) as pure prompt builders / result parsers, plus the
 * deterministic validators and Slack-layout helpers around them.
 *
 * Follows the goal-extractor / meeting-task-extractor structure: everything
 * here is unit-testable without a subprocess; the actual LLM calls go through
 * `invokeOneShot` from the pipeline orchestrator.
 *
 * The minutes prompt implements Eve's Meeting Minutes Quality Contract
 * (narrative_minutes.v1, design donor: brainbase-eve-agents
 * apps/meeting-agent/agent/instructions.md): narrative topic sections
 * separated by `------------`, assignee-grouped action items, and preserved
 * uncertainty (`@未確認` / `[TBD]`) instead of invented facts.
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import type { GraphEntity } from "../../shared/brainbase-graph.js";
import {
  defaultBinForEngine,
  invokeOneShot,
  type OneShotEngine,
} from "../../shared/oneShotCli.js";

// ---------------------------------------------------------------------------
// Shared limits
// ---------------------------------------------------------------------------

/** Transcript cap for the generation prompt (chars, head-first). */
export const MAX_TRANSCRIPT_CHARS = 120_000;
/** Transcript head used for routing classification. */
const ROUTING_HEAD_CHARS = 4_000;
/** Slack section block text limit is 3000; keep headroom like mana did. */
export const SLACK_BLOCK_TEXT_LIMIT = 2_900;
/** Deterministic floor — mana's meeting-length-based floors are unverifiable. */
export const MIN_MINUTES_CHARS = 800;

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// ---------------------------------------------------------------------------
// Sanitizer — mrkdwn-preserving
// ---------------------------------------------------------------------------

/**
 * Neutralizes Slack-active constructs in LLM output while keeping mrkdwn
 * formatting (*bold*, _italic_, code) intact: strips control chars and breaks
 * `<...>` sequences that would become mentions (@user/@channel), channel
 * links, or disguised URLs. Plain `<` `>` used as prose survive only when not
 * opening such a construct.
 */
export function sanitizeMinutesMrkdwn(text: string): string {
  return text
    .replace(CONTROL_CHARS_RE, (c) => (c === "\n" || c === "\t" ? c : " "))
    .replace(/<([@#!]|https?:|mailto:)/gi, "&lt;$1");
}

// ---------------------------------------------------------------------------
// Routing stage
// ---------------------------------------------------------------------------

export interface MinutesDestination {
  destinationId?: string;
  /** Stable project id (e.g. proj_salestailor) — the classification enum. */
  projectId: string;
  /** Human-readable project name shown to the LLM and in Slack UI. */
  name: string;
  /** Slack channel the minutes get posted into. */
  channelId: string;
  connectorInstanceId?: string;
  workspaceId?: string;
}

export function buildRoutingPrompt(
  transcript: string,
  destinations: MinutesDestination[],
): string {
  const head =
    transcript.length > ROUTING_HEAD_CHARS
      ? transcript.slice(0, ROUTING_HEAD_CHARS) + "\n…(以下略)"
      : transcript;
  const list = destinations.map((d) => `- ${d.projectId}: ${d.name}`).join("\n");
  return `あなたは会議の文字起こしを、どのプロジェクトの会議かに分類する係です。

# プロジェクト候補（この中からのみ選ぶ）
${list}

# 文字起こし（冒頭）
"""
${head}
"""

# 出力（厳守）
JSONオブジェクトを1つだけ出力する。markdown・コードフェンス・前後の文章は禁止。

  {"projectId": "<候補のprojectId or 不明>", "reason": "<判断根拠1文>"}

- 候補のどれとも確信を持って一致しない場合は "不明" とする。推測で選ばない。

JSONのみを出力せよ。`;
}

/** Returns the matched destination, or null when the LLM couldn't decide. */
export function parseRoutingResult(
  raw: string,
  destinations: MinutesDestination[],
): { destination: MinutesDestination; reason: string } | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonMatch = (fenced ? fenced[1] : raw).match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const projectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
    const destination = destinations.find((d) => d.projectId === projectId);
    if (!destination) return null;
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason.replace(CONTROL_CHARS_RE, " ").trim().slice(0, 200)
        : "";
    return { destination, reason };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generation stage — prompt
// ---------------------------------------------------------------------------

export interface MinutesContext {
  /** Proper-noun dictionary rows from Graph SSOT (person/project/brand). */
  properNouns: GraphEntity[];
  /** Open task titles from the canonical store (may be empty). */
  openTasks: string[];
  /** Related decision names from Graph (may be empty). */
  decisions: string[];
  /** Previous minutes summary for the destination channel, if any. */
  previousMinutes?: { title: string; overview: string };
  /** Resolved project name. */
  projectName: string;
  /** Meeting date as YYYY-MM-DD (JST). */
  dateStr: string;
}

function properNounSection(entities: GraphEntity[]): string {
  const rows = entities
    .filter((e) => e.aliases.length > 0)
    .slice(0, 200)
    .map((e) => `- ${e.aliases.map((a) => `「${a}」`).join("")}→「${e.name}」`);
  if (rows.length === 0) return "";
  return `# 固有名詞の表記ゆれ修正（正本: Graph SSOT）
文字起こしの誤変換・聞き違いを以下の正式名称へ修正すること:
${rows.join("\n")}
`;
}

export function buildMinutesPrompt(transcript: string, ctx: MinutesContext): string {
  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n…(文字数上限により以降を省略)"
      : transcript;

  const contextParts: string[] = [];
  const nouns = properNounSection(ctx.properNouns);
  if (nouns) contextParts.push(nouns);
  if (ctx.decisions.length > 0) {
    contextParts.push(
      `# 関連する既存の意思決定（Graph SSOT）\n${ctx.decisions
        .slice(0, 10)
        .map((d) => `- ${d}`)
        .join("\n")}\n`,
    );
  }
  if (ctx.openTasks.length > 0) {
    contextParts.push(
      `# 進行中のタスク（正本タスクボード）\n${ctx.openTasks
        .slice(0, 20)
        .map((t) => `- ${t}`)
        .join("\n")}\n`,
    );
  }
  if (ctx.previousMinutes) {
    contextParts.push(
      `# 前回の議事録（概要）\n${ctx.previousMinutes.title}\n${ctx.previousMinutes.overview}\n`,
    );
  }

  return `あなたは優秀な議事録作成者です。会議の文字起こしから、将来の人間とAIが会議の流れ・文脈・理由を再構築できる「物語的な議事録」を作成します。

プロジェクト: ${ctx.projectName}
会議日: ${ctx.dateStr}

${contextParts.join("\n")}
# 品質契約（narrative_minutes.v1 — 厳守）
議事録は短い要約でも生の文字起こしでもない。話の流れ（どの話題がなぜ出て、議論がどう動き、何の結論・未解決点を生んだか）を保存する。

出力は次の構造のMarkdown（Slack mrkdwn: 太字は*text*、斜体は_text_）:

1. 1行目: タイトル行「${ctx.dateStr} <会議トピック>-要約」
2. 2行目: 会議タイトル
3. 概要: 2〜4段落（会議の目的、主要テーマ、決定事項、未解決の論点）
4. トピックセクション: 「------------」だけの行で区切る。各セクションは具体的な見出し（*見出し*）+ 2〜5段落で、背景→議論の内容→なぜ重要か→何が変わったか→残る未解決点、の流れを保存する。1〜2文で終わらせない。
5. 最後に「*アクションアイテム*」セクション: 担当者別にグループ化し、各項目は「担当者: 内容（期限: YYYY-MM-DD or [TBD]）」の形式。

# 不確実性の扱い（捏造禁止）
- 担当者が不明なら @未確認 と書く。
- 期限が不明なら [TBD] と書く。
- 話者が特定できないときのみ Speaker <番号> を使う。
- 文字起こしにない事実・決定・約束・肩書きを発明しない。根拠が薄いセクションは何の根拠が不足しているかを書く。

# 文字起こし
"""
${truncated}
"""

議事録本文のみを出力せよ（コードフェンス・前置き・後書きは禁止）。`;
}

// ---------------------------------------------------------------------------
// Generation stage — parse + validate
// ---------------------------------------------------------------------------

export interface GeneratedMinutes {
  /** Title line (`<date> <topic>-要約`). */
  title: string;
  /** Parent-message text: title + meeting title + overview paragraphs. */
  overview: string;
  /** Full minutes body (sanitized), posted in-thread. */
  body: string;
}

export interface MinutesValidationError {
  reason: string;
}

/**
 * Parses and validates the LLM output against the deterministic parts of the
 * quality contract. Returns the minutes or a validation error (the caller
 * regenerates once, then fails loud).
 */
export function parseMinutesResult(
  raw: string,
  dateStr: string,
): { minutes: GeneratedMinutes } | { error: MinutesValidationError } {
  const stripped = raw
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!stripped) return { error: { reason: "empty output" } };

  const body = sanitizeMinutesMrkdwn(stripped);
  if (body.length < MIN_MINUTES_CHARS) {
    return { error: { reason: `body too short (${body.length} < ${MIN_MINUTES_CHARS})` } };
  }
  if (!/^-{5,}\s*$/m.test(body)) {
    return { error: { reason: "missing ------------ topic separators" } };
  }
  if (!body.includes("アクションアイテム")) {
    return { error: { reason: "missing アクションアイテム section" } };
  }

  const lines = body.split("\n");
  const titleLine = (lines[0] ?? "").trim();
  if (!titleLine.includes("要約")) {
    return { error: { reason: `title line malformed: "${titleLine.slice(0, 60)}"` } };
  }
  const title = titleLine.startsWith(dateStr) ? titleLine : `${dateStr} ${titleLine}`;

  // Overview = everything before the first topic separator.
  const separatorIndex = lines.findIndex((line) => /^-{5,}\s*$/.test(line.trim()));
  const overview = lines
    .slice(0, separatorIndex === -1 ? lines.length : separatorIndex)
    .join("\n")
    .trim();

  return { minutes: { title, overview, body } };
}

// ---------------------------------------------------------------------------
// Slack layout — 2900-char thread chunks (mana's posting contract)
// ---------------------------------------------------------------------------

/** Splits at newline → space → hard boundaries, mana's order. */
export function splitForSlack(text: string, limit: number = SLACK_BLOCK_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", limit);
    if (splitIndex <= 0) splitIndex = limit;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\s+/, "");
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// LLM invocation wrappers
// ---------------------------------------------------------------------------

export interface MinutesLlmOptions {
  engine?: OneShotEngine;
  bin?: string;
  model?: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

const ROUTING_DEFAULT_MODEL = "claude-haiku-4-5";
const ROUTING_DEFAULT_TIMEOUT_MS = 30_000;
const GENERATION_DEFAULT_MODEL = "claude-sonnet-4-6";
const GENERATION_DEFAULT_TIMEOUT_MS = 300_000;

/** Classify the transcript to a destination. Returns null on any failure. */
export async function classifyMinutesDestination(
  transcript: string,
  destinations: MinutesDestination[],
  options: MinutesLlmOptions = {},
): Promise<{ destination: MinutesDestination; reason: string } | null> {
  const engine = options.engine ?? "claude";
  try {
    const output = await invokeOneShot(buildRoutingPrompt(transcript, destinations), {
      engine,
      bin: options.bin || defaultBinForEngine(engine),
      model: options.model || ROUTING_DEFAULT_MODEL,
      timeoutMs: options.timeoutMs ?? ROUTING_DEFAULT_TIMEOUT_MS,
      spawnFn: options.spawnImpl,
      label: "meeting-minutes-routing",
    });
    return parseRoutingResult(output, destinations);
  } catch (err) {
    logger.warn(`[meeting-minutes] routing classification failed: ${err}`);
    return null;
  }
}

/**
 * Generate the minutes. Throws on LLM failure; returns a validation error
 * object on contract violations so the caller can decide to retry.
 */
export async function generateMinutes(
  transcript: string,
  ctx: MinutesContext,
  options: MinutesLlmOptions = {},
): Promise<{ minutes: GeneratedMinutes } | { error: MinutesValidationError }> {
  const engine = options.engine ?? "claude";
  const output = await invokeOneShot(buildMinutesPrompt(transcript, ctx), {
    engine,
    bin: options.bin || defaultBinForEngine(engine),
    model: options.model || GENERATION_DEFAULT_MODEL,
    timeoutMs: options.timeoutMs ?? GENERATION_DEFAULT_TIMEOUT_MS,
    spawnFn: options.spawnImpl,
    label: "meeting-minutes-generation",
    // Transcripts exceed Linux's 128KiB per-argv limit — must go via stdin.
    promptViaStdin: engine === "claude",
  });
  return parseMinutesResult(output, ctx.dateStr);
}
