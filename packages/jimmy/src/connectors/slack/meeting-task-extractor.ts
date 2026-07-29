/**
 * Meeting-minutes → task-candidate extraction.
 *
 * Ported from mana's `meeting-decision-extractor.js` design (actions only —
 * decisions/issues have different destinations and are out of scope here).
 * Follows the goal-extractor structure: prompt builder and result parser are
 * pure functions unit-testable without spawning a subprocess; the LLM call
 * goes through `invokeOneShot` and never throws (returns [] on any failure).
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import {
  defaultBinForEngine,
  defaultModelForEngine,
  invokeOneShot,
  type OneShotEngine,
} from "../../shared/oneShotCli.js";

export interface MeetingTaskCandidate {
  /** Short imperative task title. */
  title: string;
  /** Assignee as written in the minutes ("未定" when unknown). Display only. */
  assignee: string;
  /** Due date as YYYY-MM-DD, or null when not stated / not parseable. */
  due: string | null;
  /** 1-2 sentence background from the minutes. */
  context: string;
}

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_CANDIDATES = 10;
const MAX_TITLE_CHARS = 120;
const MAX_CONTEXT_CHARS = 300;
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

function sanitizeField(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Prompt builder (pure)
// ---------------------------------------------------------------------------

export function buildMeetingTaskExtractionPrompt(transcript: string, projectName?: string): string {
  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n…(truncated)"
      : transcript;

  return `あなたは会議議事録からアクションアイテム（タスク）だけを抽出する係です。
${projectName ? `プロジェクト: ${projectName}\n` : ""}
# 入力（議事録）
"""
${truncated}
"""

# 出力（厳守）
JSONオブジェクトを1つだけ出力する。markdown・コードフェンス・前後の文章は禁止。

  {"tasks": [{"task": "<タスク内容1文>", "assignee": "<担当者名 or 未定>", "deadline": "<YYYY-MM-DD or 未定>", "context": "<背景1-2文>"}]}

タスクが1つも無ければ {"tasks": []} を返す。

# 抽出基準
- 「誰かが今後実行する具体的な作業」だけを抽出する（最大${MAX_CANDIDATES}件）。
- 含める: 明確に合意された作業、依頼と受諾が確認できる作業、期限つきの約束。
- 除外する: 情報共有のみ、検討中で未確定の案、過去に完了した報告、感想・雑談。
- 入力が議事録・会議メモでない場合（雑談、通知、コード等）は {"tasks": []} を返す。
- deadline は議事録に明記されている場合のみ YYYY-MM-DD に正規化する。
  相対表現（来週・今週中など）で特定日に確定できないなら 未定 とする。
- assignee は議事録に書かれた名前をそのまま使う。不明なら 未定。

JSONのみを出力せよ。`;
}

// ---------------------------------------------------------------------------
// Result parser (pure)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the LLM response into sanitized candidates. Returns [] for anything
 * unusable. Candidates without a non-empty title are dropped.
 */
export function parseMeetingTaskExtractionResult(raw: string): MeetingTaskCandidate[] {
  if (!raw) return [];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const tasks = (parsed as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) return [];

  const results: MeetingTaskCandidate[] = [];
  for (const item of tasks) {
    if (results.length >= MAX_CANDIDATES) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = sanitizeField(record.task, MAX_TITLE_CHARS);
    if (!title) continue;
    const assignee = sanitizeField(record.assignee, 60) || "未定";
    const rawDeadline = sanitizeField(record.deadline, 20);
    const due = DATE_RE.test(rawDeadline) ? rawDeadline : null;
    const context = sanitizeField(record.context, MAX_CONTEXT_CHARS);
    results.push({ title, assignee, due, context });
  }
  return results;
}

// ---------------------------------------------------------------------------
// LLM invocation
// ---------------------------------------------------------------------------

export interface ExtractMeetingTasksOptions {
  /** CLI engine. Defaults to claude (minutes need more capability than nano). */
  engine?: OneShotEngine;
  bin?: string;
  model?: string;
  /** Hard timeout (ms). Defaults to 60s — minutes are long inputs. */
  timeoutMs?: number;
  /** Override the spawner (for tests). */
  spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Extract task candidates from meeting minutes. Returns [] on any failure —
 * the caller should treat this as "nothing to propose". Never throws.
 */
export async function extractMeetingTaskCandidates(
  transcript: string,
  projectName?: string,
  options: ExtractMeetingTasksOptions = {},
): Promise<MeetingTaskCandidate[]> {
  const engine = options.engine ?? "claude";
  const bin = options.bin || defaultBinForEngine(engine);
  const model = options.model || defaultModelForEngine(engine);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnImpl || spawn;
  const prompt = buildMeetingTaskExtractionPrompt(transcript, projectName);

  try {
    const output = await invokeOneShot(prompt, {
      engine,
      bin,
      model,
      timeoutMs,
      spawnFn,
      label: "meeting-task-extractor",
    });
    return parseMeetingTaskExtractionResult(output);
  } catch (err) {
    logger.warn(`[meeting-task-proposal] extraction failed, skipping proposal: ${err}`);
    return [];
  }
}
