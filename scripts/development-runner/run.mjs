#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "/etc/openryoko-development-runner.json";
const MAX_REQUEST_CHARS = 8000;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const LOCK_PATH = "/home/ryoko-dev/.openryoko-development-runner.lock";
export const RUNNER_VERSION = "2026-07-31.4";

// ─── Progress reporting (Slack typing status) ───
// While the agent runs, the runner emits `PROGRESS <json>` lines directly to
// its own stderr (not the child's) so the gateway can parse them in real
// time and refresh the Slack "typing" status with actual progress instead of
// a static "開発中…" string. Emission is fail-silent: a git failure here must
// never abort the development run itself.
const PROGRESS_INTERVAL_MS = 60_000;
const MAX_PROGRESS_LATEST_CHARS = 200;

// ─── Human-in-the-loop question/answer contract ───
const QUESTIONS_RELATIVE_PATH = path.join(".openryoko", "questions.json");
const MAX_QUESTIONS = 5;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS_PER_QUESTION = 5;
const MAX_OPTION_LABEL_CHARS = 80;
const MAX_OPTION_DESCRIPTION_CHARS = 200;
const MAX_ANSWERS = 10;
const MAX_ANSWER_CHARS = 2000;
const STORY_ID_RE = /^story-[a-z0-9-]+$/;
const QUESTION_ID_RE = /^[a-z0-9_-]{1,64}$/;

// ─── Gate-resolution result contract (needs_input "成果報告＋次の一手") ───
const MAX_GATES = 30;
const MAX_GATE_TEXT_CHARS = 500;
const MAX_COMMIT_SUBJECTS = 5;
const MAX_COMMIT_SUBJECT_CHARS = 200;
const MAX_COMMIT_COUNT = 10000;
const CHORE_RECORD_COMMIT_RE = /^chore: record /;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Anything but a definitive ESRCH (EPERM, etc.) counts as alive: reclaim
    // must only ever trigger on proof of death, never on uncertainty.
    return error?.code !== "ESRCH";
  }
}

async function defaultListLiveUserPids(uid) {
  // Linux /proc scan. On hosts without /proc this throws and the caller
  // fails closed (no automatic reclaim) — production runners are Linux-only.
  const entries = await readdir("/proc");
  const pids = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const info = await stat(`/proc/${entry}`);
      if (info.uid === uid) pids.push(Number(entry));
    } catch {
      // The process exited between readdir and stat.
    }
  }
  return pids;
}

/**
 * Decides whether an existing lock directory is provably stale. Returns
 * `{stale, reason}` and never mutates the lock. Stale requires ALL of:
 *   - the owner file exists and parses to a positive pid,
 *   - that pid is definitively dead (ESRCH; EPERM counts as alive),
 *   - no other live process runs as the development user (so a dead runner
 *     whose detached VibePro/agent children survived is NOT reclaimed).
 * A pid recycled by an unrelated process looks alive, which keeps the lock —
 * the safe direction (manual operator cleanup) rather than a double run.
 */
export async function assessLockStaleness(lockPath, options = {}) {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const listLiveUserPids = options.listLiveUserPids ?? defaultListLiveUserPids;
  const currentPid = options.currentPid ?? process.pid;

  let ownerRaw;
  try {
    ownerRaw = await readFile(path.join(lockPath, "owner"), "utf8");
  } catch {
    return { stale: false, reason: "lock owner file is missing or unreadable" };
  }
  const ownerPid = Number.parseInt(ownerRaw.trim(), 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    return { stale: false, reason: "lock owner pid is malformed" };
  }
  if (ownerPid === currentPid || isPidAlive(ownerPid)) {
    return { stale: false, reason: `lock owner process ${ownerPid} is still alive` };
  }
  let livePids;
  try {
    livePids = await listLiveUserPids(options.uid ?? process.getuid());
  } catch {
    return { stale: false, reason: "cannot enumerate live processes for the development user" };
  }
  const survivors = livePids.filter((pid) => pid !== currentPid && pid !== ownerPid);
  if (survivors.length > 0) {
    return {
      stale: false,
      reason: `lock owner process ${ownerPid} is dead but ${survivors.length} process(es) still run as the development user`,
    };
  }
  return { stale: true, reason: `lock owner process ${ownerPid} is dead and no other development-user process survives` };
}

/**
 * Removes a provably stale lock. The removal is guarded against the
 * assess-then-remove race: the directory is first claimed with an atomic
 * rename, then re-assessed in quarantine. If a fresh lock replaced the stale
 * one in between, the rename grabbed the fresh lock — it is renamed back
 * untouched and the caller fails closed.
 */
async function reclaimStaleLock(lockPath, options = {}) {
  const first = await assessLockStaleness(lockPath, options);
  if (!first.stale) return first;
  const quarantine = `${lockPath}.reclaim-${options.currentPid ?? process.pid}`;
  try {
    await rename(lockPath, quarantine);
  } catch {
    return { stale: false, reason: "lock changed while assessing staleness" };
  }
  const second = await assessLockStaleness(quarantine, options);
  if (!second.stale) {
    try {
      await rename(quarantine, lockPath);
      return { stale: false, reason: second.reason };
    } catch {
      return {
        stale: false,
        reason: `${second.reason}; a fresh lock was quarantined at ${quarantine} and could not be restored — operator attention required`,
      };
    }
  }
  await rm(quarantine, { recursive: true, force: true });
  return second;
}

export async function acquireDevelopmentLock(lockPath = LOCK_PATH, options = {}) {
  const tryAcquire = async () => {
    let directoryCreated = false;
    try {
      await mkdir(lockPath);
      directoryCreated = true;
      await writeFile(path.join(lockPath, "owner"), `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if (directoryCreated) await rm(lockPath, { recursive: true, force: true });
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };

  if (!(await tryAcquire())) {
    const verdict = await reclaimStaleLock(lockPath, options);
    if (!verdict.stale) {
      throw new Error(`another development task is already running (${verdict.reason})`);
    }
    process.stderr.write(`reclaimed stale development lock: ${verdict.reason}\n`);
    if (!(await tryAcquire())) {
      throw new Error("another development task is already running (lost the acquisition race after reclaim)");
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { recursive: true, force: true });
  };
}

function emit(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedString(value, min, max, label) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`invalid ${label}`);
  }
}

/**
 * Validates the human-in-the-loop questions document the agent may write to
 * `.openryoko/questions.json` when a request is too ambiguous to implement
 * safely. Fail-closed: any shape mismatch throws rather than trusting a
 * partially-valid agent artifact.
 */
export function validateQuestionsDocument(parsed) {
  if (!isPlainObject(parsed) || Object.keys(parsed).some((key) => key !== "questions")) {
    throw new Error("questions document has an unsupported field");
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length < 1 || parsed.questions.length > MAX_QUESTIONS) {
    throw new Error(`questions document must contain 1-${MAX_QUESTIONS} questions`);
  }
  const seenIds = new Set();
  const questions = parsed.questions.map((raw) => {
    if (!isPlainObject(raw)) throw new Error("question entry must be an object");
    const allowedKeys = new Set(["id", "question", "options", "allow_free_text"]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new Error("question entry has an unsupported field");
    }
    if (typeof raw.id !== "string" || !QUESTION_ID_RE.test(raw.id)) throw new Error("invalid question id");
    if (seenIds.has(raw.id)) throw new Error(`duplicate question id: ${raw.id}`);
    seenIds.add(raw.id);
    assertBoundedString(raw.question, 1, MAX_QUESTION_CHARS, "question text");
    const options = raw.options === undefined ? [] : raw.options;
    if (!Array.isArray(options) || options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new Error("question options must be an array of at most 5 entries");
    }
    const normalizedOptions = options.map((rawOption) => {
      if (!isPlainObject(rawOption)) throw new Error("option entry must be an object");
      const allowedOptionKeys = new Set(["label", "description", "recommended"]);
      if (Object.keys(rawOption).some((key) => !allowedOptionKeys.has(key))) {
        throw new Error("option entry has an unsupported field");
      }
      assertBoundedString(rawOption.label, 1, MAX_OPTION_LABEL_CHARS, "option label");
      if (rawOption.description !== undefined) {
        assertBoundedString(rawOption.description, 0, MAX_OPTION_DESCRIPTION_CHARS, "option description");
      }
      if (rawOption.recommended !== undefined && typeof rawOption.recommended !== "boolean") {
        throw new Error("option recommended flag must be boolean");
      }
      return {
        label: rawOption.label,
        ...(rawOption.description !== undefined ? { description: rawOption.description } : {}),
        ...(rawOption.recommended !== undefined ? { recommended: rawOption.recommended } : {}),
      };
    });
    if (raw.allow_free_text !== undefined && typeof raw.allow_free_text !== "boolean") {
      throw new Error("allow_free_text must be boolean");
    }
    return {
      id: raw.id,
      question: raw.question,
      options: normalizedOptions,
      allow_free_text: raw.allow_free_text === true,
    };
  });
  return { questions };
}

/**
 * Reads and validates `.openryoko/questions.json` from a worktree. Returns
 * `null` when the file does not exist (the normal, non-ambiguous path).
 * Throws when the file exists but fails schema validation — the caller must
 * treat that as fail-closed `needs_input`, never as silently-ignored input.
 */
export async function readQuestionsFile(worktree) {
  let raw;
  try {
    raw = await readFile(path.join(worktree, QUESTIONS_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("questions document is not valid JSON");
  }
  return validateQuestionsDocument(parsed);
}

/** Ensures `entry` is present as its own line in a .gitignore's content. */
export function ensureGitignoreEntry(content, entry) {
  const lines = content.length > 0 ? content.split("\n") : [];
  if (lines.some((line) => line.trim() === entry)) return content;
  const withoutTrailingBlank = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return [...withoutTrailingBlank, entry, ""].join("\n");
}

async function ensureGitignoreEntryOnDisk(worktree, entry) {
  const gitignorePath = path.join(worktree, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const updated = ensureGitignoreEntry(content, entry);
  if (updated !== content) await writeFile(gitignorePath, updated);
}

/**
 * Validates one human answer to a previously-asked question.
 */
function validateAnswer(raw) {
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== "id" && key !== "answer")) {
    throw new Error("answer entry has an unsupported field");
  }
  if (typeof raw.id !== "string" || !QUESTION_ID_RE.test(raw.id)) throw new Error("invalid answer id");
  assertBoundedString(raw.answer, 1, MAX_ANSWER_CHARS, "answer text");
  return { id: raw.id, answer: raw.answer };
}

/**
 * Parses and validates the single JSON object the runner reads from stdin.
 * Exactly one of three shapes is accepted:
 *   - `{"request": string}` — start a new Story.
 *   - `{"storyId": string, "answers": [{id, answer}, ...]}` — resume a Story
 *     that previously stopped with `needs_decision`.
 *   - `{"storyId": string, "continueGates": true}` — continue a Story that
 *     previously stopped with `needs_input` because VibePro gates were
 *     unresolved.
 * Any other shape (unknown fields, more than one shape present, wrong types)
 * fails closed with an error — this stdin payload is untrusted gateway input.
 */
export async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > MAX_REQUEST_CHARS * 4) throw new Error("request is too large");
  }
  const parsed = JSON.parse(input);
  if (!isPlainObject(parsed)) throw new Error("unsupported request field");
  const keys = Object.keys(parsed);
  const hasRequest = keys.includes("request");
  const hasAnswers = keys.includes("answers");
  const hasContinueGates = keys.includes("continueGates");
  const hasResume = keys.includes("storyId") || hasAnswers || hasContinueGates;

  if (hasRequest && hasResume) throw new Error("request and storyId/answers are mutually exclusive");

  if (hasRequest) {
    if (keys.some((key) => key !== "request")) throw new Error("unsupported request field");
    if (typeof parsed.request !== "string" || !parsed.request.trim() || parsed.request.length > MAX_REQUEST_CHARS) {
      throw new Error("invalid request");
    }
    return { mode: "new", request: parsed.request.trim() };
  }

  if (hasContinueGates) {
    if (hasAnswers) throw new Error("continueGates and answers are mutually exclusive");
    if (keys.some((key) => key !== "storyId" && key !== "continueGates")) throw new Error("unsupported request field");
    if (typeof parsed.storyId !== "string" || !STORY_ID_RE.test(parsed.storyId)) throw new Error("invalid storyId");
    if (parsed.continueGates !== true) throw new Error("invalid continueGates");
    return { mode: "continueGates", storyId: parsed.storyId };
  }

  if (keys.some((key) => key !== "storyId" && key !== "answers")) throw new Error("unsupported request field");
  if (typeof parsed.storyId !== "string" || !STORY_ID_RE.test(parsed.storyId)) throw new Error("invalid storyId");
  if (!Array.isArray(parsed.answers) || parsed.answers.length < 1 || parsed.answers.length > MAX_ANSWERS) {
    throw new Error(`answers must contain 1-${MAX_ANSWERS} entries`);
  }
  const seenIds = new Set();
  const answers = parsed.answers.map((raw) => {
    const answer = validateAnswer(raw);
    if (seenIds.has(answer.id)) throw new Error(`duplicate answer id: ${answer.id}`);
    seenIds.add(answer.id);
    return answer;
  });
  return { mode: "resume", storyId: parsed.storyId, answers };
}

export async function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? "/",
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        ...(options.extraEnv ?? {}),
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let terminationError = null;
    let killTimer = null;
    let timeoutTimer = null;
    let closedCode;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      fn();
    };
    const signalGroup = (signal) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else {
        child.kill(signal);
      }
    };
    const terminate = (error) => {
      if (terminationError || settled) return;
      terminationError = error;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        signalGroup("SIGKILL");
        if (closedCode !== undefined) finish(() => reject(terminationError));
      }, options.terminationGraceMs ?? 5000);
    };
    const collect = (target) => (chunk) => {
      if (terminationError) return;
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES)) {
        terminate(new Error("command output exceeded limit"));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      closedCode = code;
      // The group leader can close before SIGTERM-resistant descendants.
      // Preserve the lock until escalation has targeted the whole group.
      if (terminationError && killTimer) return;
      finish(() => {
        if (stderr) process.stderr.write(stderr);
        if (terminationError) reject(terminationError);
        else if (code === 0) resolve(stdout);
        else reject(new Error(`${path.basename(bin)} exited with code ${code ?? "unknown"}`));
      });
    });
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => terminate(new Error("command timed out")), options.timeoutMs);
    }
  });
}

export function validateConfig(config) {
  for (const key of ["repository", "worktreesRoot", "vibeproBin", "claudeBin"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) throw new Error(`invalid ${key}`);
  }
  if (config.agentEnvFile !== undefined && (typeof config.agentEnvFile !== "string" || !path.isAbsolute(config.agentEnvFile))) {
    throw new Error("invalid agentEnvFile");
  }
  if (typeof config.baseRef !== "string" || !/^origin\/[a-zA-Z0-9._/-]+$/.test(config.baseRef)) {
    throw new Error("invalid baseRef");
  }
  if (!Number.isInteger(config.maxDurationMs) || config.maxDurationMs < 60000 || config.maxDurationMs > 5_400_000) {
    throw new Error("invalid maxDurationMs");
  }
  if (config.runnerVersion !== RUNNER_VERSION) {
    throw new Error("runner version mismatch");
  }
}

// ─── Agent-driven VibePro development ───
// The development engine is a Claude Code session that follows the VibePro
// workflow itself (Story -> Spec -> Code -> Gate evidence -> pr prepare).
// The runner never trusts the agent's own claim of success: readiness is
// re-derived afterwards from `vibepro pr ship --dry-run` output.

export function parseEnvFile(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error("invalid agent environment line");
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export function buildAgentPrompt(storyId, request, baseBranch) {
  return [
    "あなたはOpenRyokoの自己開発セッションです。隔離worktreeの中で、VibePro CLIを制御プレーンとして使いながら次の依頼を実装してください。",
    "",
    "## 依頼",
    "",
    request,
    "",
    "## 進め方",
    "",
    `- Story ID は ${storyId}。Story本文は docs/management/stories/active/${storyId}.md にある。`,
    "- VibePro workflow に従う: Story確認 -> 必要なら vibepro spec / graphify -> 実装 -> テスト -> `vibepro verify record` で検証証跡 -> `vibepro pr prepare . --story-id " + storyId + " --base " + baseBranch + "`。",
    "- Gate が evidence を要求したら、実際に検証してから記録する。証跡の捏造は禁止。",
    "- 変更は意図ごとに小さくコミットする。",
    "",
    "## 曖昧さがある場合の質問チャネル",
    "",
    "- 依頼に誤ると高コストな曖昧さがある場合は、実装せずに `vibepro story diagnose . --id " + storyId + " --phase design-input` を実行したうえで、質問をこのworktree直下の `.openryoko/questions.json` に書いて終了せよ。",
    "- questions.json のスキーマ: `{\"questions\": [{\"id\", \"question\"(300字以内), \"options\": [{\"label\"(80字以内), \"description\"(200字以内, 任意), \"recommended\"(任意, boolean)}](0〜5個), \"allow_free_text\": boolean}]}`。質問は最大5問。",
    "- 曖昧さがなければこのファイルは作らず、そのまま実装を進めよ。質問は1往復のみ許される — 人間の回答を受け取った再開セッションでは再度質問しない。",
    "",
    "## 安全境界(違反禁止)",
    "",
    "- PR作成・merge・push・deploy・secretsの変更・runtime本体checkoutの変更は行わない。pr_ready 相当で停止する。",
    "- このworktreeの外のファイルを変更しない。",
    "- `vibepro pr create` / `git push` / `gh` は実行しない。",
    "",
    "完了したら、最後に到達状態(gateの残り、未解決事項)を簡潔に報告して終了する。",
  ].join("\n");
}

export function buildResumeAgentPrompt(storyId, baseBranch) {
  return [
    "あなたはOpenRyokoの自己開発セッションです。隔離worktreeの中で、VibePro CLIを制御プレーンとして使いながら実装を再開してください。",
    "",
    "## 再開の経緯",
    "",
    `- Story ID は ${storyId}。Story本文（元の依頼と、それに対する人間の回答を含む） は docs/management/stories/active/${storyId}.md にある。まずこれを読むこと。`,
    "- 「## Human answers」セクションが人間からの回答である。それを前提に実装を進めよ。",
    "- これは1往復ルールの再開セッションである。ここから先の曖昧さは自己判断で安全側に倒し、再度質問はしない（`.openryoko/questions.json` は作らない）。",
    "",
    "## 進め方",
    "",
    "- VibePro workflow に従う: Story確認 -> 必要なら vibepro spec / graphify -> 実装 -> テスト -> `vibepro verify record` で検証証跡 -> `vibepro pr prepare . --story-id " + storyId + " --base " + baseBranch + "`。",
    "- Gate が evidence を要求したら、実際に検証してから記録する。証跡の捏造は禁止。",
    "- 変更は意図ごとに小さくコミットする。",
    "",
    "## 安全境界(違反禁止)",
    "",
    "- PR作成・merge・push・deploy・secretsの変更・runtime本体checkoutの変更は行わない。pr_ready 相当で停止する。",
    "- このworktreeの外のファイルを変更しない。",
    "- `vibepro pr create` / `git push` / `gh` は実行しない。",
    "",
    "完了したら、最後に到達状態(gateの残り、未解決事項)を簡潔に報告して終了する。",
  ].join("\n");
}

export function buildContinueGatesAgentPrompt(storyId, baseBranch) {
  return [
    "あなたはOpenRyokoの自己開発セッションです。隔離worktreeの中で、VibePro CLIを制御プレーンとして使いながら、前回Gate未解決で停止したStoryのGate解消ラウンドを実行してください。",
    "",
    "## 再開の経緯",
    "",
    `- Story ID は ${storyId}。このStoryは \`vibepro pr ship . --base ${baseBranch} --head codex/${storyId} --story-id ${storyId} --dry-run\` を実行した結果、Gateが未解決のまま停止した。`,
    "- まず自分で上記の `vibepro pr ship ... --dry-run` を実行し、残っているGate（critical_gate / waiver_or_evidence）を確認せよ。",
    "",
    "## 進め方",
    "",
    "- 確認したGateを、evidence記録・レビューdispatch・スコープ混入の修正など、実際の作業で解消せよ。証跡の捏造は禁止。",
    "- Gateの多くは `vibepro verify record` や `vibepro review record` などVibePro CLIの正規コマンドで解消する。",
    "- 人間の判断が必要なGate（waiver判断など）は無理に通さず、残したままでよい。",
    "- 変更は意図ごとに小さくコミットする。",
    "",
    "## 安全境界(違反禁止)",
    "",
    "- PR作成・merge・push・deploy・secretsの変更・runtime本体checkoutの変更は行わない。pr_ready 相当で停止する。",
    "- このworktreeの外のファイルを変更しない。",
    "- `vibepro pr create` / `git push` / `gh` は実行しない。",
    "",
    "完了したら、最後に到達状態(gateの残り、未解決事項)を簡潔に報告して終了する。",
  ].join("\n");
}

export function buildAgentArgs(prompt) {
  return ["-p", "--dangerously-skip-permissions", prompt];
}

export function buildPrShipArgs(storyId, branch, baseBranch) {
  return [
    "pr", "ship", ".",
    "--base", baseBranch, "--head", branch,
    "--story-id", storyId, "--dry-run",
  ];
}

export function parsePrShipReadiness(stdout) {
  const marker = stdout.lastIndexOf("## Next Commands");
  const nextCommands = marker === -1 ? "" : stdout.slice(marker);
  return /^- vibepro pr create /m.test(nextCommands);
}

export function extractBlockingGates(stdout) {
  return [...stdout.matchAll(/^- (?:critical_gate|waiver_or_evidence): (.+)$/gm)].map((m) => m[1]);
}

/**
 * Structured version of `extractBlockingGates`: pairs each unresolved gate
 * line with its severity (`critical` for `critical_gate`, `evidence` for
 * `waiver_or_evidence`) and bounds the result to `MAX_GATES` entries of at
 * most `MAX_GATE_TEXT_CHARS` each, so the Slack "残Gate" card never has to
 * truncate mid-run and the gateway's fail-closed validator always accepts
 * it. `totalCount` preserves the true count even when more gates were
 * reported than fit in `gates`.
 */
export function extractGates(stdout) {
  const matches = [...stdout.matchAll(/^- (critical_gate|waiver_or_evidence): (.+)$/gm)];
  const all = matches.map((m) => ({
    severity: m[1] === "critical_gate" ? "critical" : "evidence",
    text: m[2].length > MAX_GATE_TEXT_CHARS ? m[2].slice(0, MAX_GATE_TEXT_CHARS) : m[2],
  }));
  return { gates: all.slice(0, MAX_GATES), totalCount: all.length };
}

/** True for the Story-doc/answers bookkeeping commits the runner itself makes. */
export function isChoreRecordCommit(subject) {
  return CHORE_RECORD_COMMIT_RE.test(subject);
}

/**
 * Counts commits made in `worktree` since `baselineSha` and returns up to
 * `MAX_COMMIT_SUBJECTS` of the newest non-bookkeeping subjects (the
 * runner's own `chore: record ...` Story/answers commits are excluded from
 * the visible list but still counted). Never throws — commit reporting is
 * best-effort and must not affect the development run itself.
 */
export async function collectCommits(worktree, baselineSha) {
  if (!baselineSha) return { count: 0, subjects: [] };
  try {
    const log = await runCommand("/usr/bin/git", ["log", "--format=%s", `${baselineSha}..HEAD`], { cwd: worktree });
    const subjects = log.split("\n").filter((line) => line.length > 0);
    const count = Math.min(subjects.length, MAX_COMMIT_COUNT);
    const visible = subjects
      .filter((subject) => !isChoreRecordCommit(subject))
      .slice(0, MAX_COMMIT_SUBJECTS)
      .map((subject) => (subject.length > MAX_COMMIT_SUBJECT_CHARS ? subject.slice(0, MAX_COMMIT_SUBJECT_CHARS) : subject));
    return { count, subjects: visible };
  } catch {
    return { count: 0, subjects: [] };
  }
}

export function resultFromAgentRun(shipStdout, storyId, commits) {
  const commitsField = commits !== undefined ? { commits } : {};
  if (parsePrShipReadiness(shipStdout)) {
    return {
      status: "pr_ready",
      storyId,
      summary: "VibePro gates are ready. PR creation requires a human action.",
      ...commitsField,
    };
  }
  const { gates, totalCount } = extractGates(shipStdout);
  const detail = totalCount > 0 ? ` ${totalCount} gate(s) remain, e.g.: ${gates[0].text}` : "";
  return {
    status: "needs_input",
    storyId,
    summary: `VibePro gates are not resolved yet.${detail} Review the worktree before resuming.`,
    ...(gates.length > 0 ? { gates } : {}),
    ...commitsField,
  };
}

export function resultFromQuestions(storyId, questions) {
  return {
    status: "needs_decision",
    storyId,
    questions: questions.questions,
    summary: `The request has ambiguity that is expensive to guess. ${questions.questions.length} question(s) need a human answer before implementation continues.`,
  };
}

export function buildStoryCommitArgs(storyId) {
  return [
    "-c", "user.name=OpenRyoko Development Runner",
    "-c", "user.email=openryoko-runner@localhost",
    "commit", "-m", `chore: record ${storyId} request`,
  ];
}

export function buildStoryAddArgs(storyRelativePath) {
  return ["add", "-f", "--", ".gitignore", ".vibepro/config.json", storyRelativePath];
}

export function buildAnswersCommitArgs(storyId) {
  return [
    "-c", "user.name=OpenRyoko Development Runner",
    "-c", "user.email=openryoko-runner@localhost",
    "commit", "-m", `chore: record ${storyId} human answers`,
  ];
}

export function buildAnswersAddArgs(storyRelativePath) {
  return ["add", "-f", "--", storyRelativePath];
}

/** Renders the "## Human answers" section appended to a Story doc on resume. */
export function buildHumanAnswersSection(answers) {
  return [
    "",
    "## Human answers",
    "",
    ...answers.map((answer) => `- ${answer.id}: ${answer.answer}`),
    "",
  ].join("\n");
}

async function resolveExistingWorktree(worktreesRoot, storyId) {
  const candidate = path.join(worktreesRoot, storyId);
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`worktree for ${storyId} does not exist`);
  }
  const resolvedRoot = await realpath(worktreesRoot);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(withSep)) {
    throw new Error(`worktree for ${storyId} is outside the configured worktrees root`);
  }
  return resolved;
}

/**
 * Builds one `PROGRESS ` stderr line. `phase` is `"agent"` while the Claude
 * Code agent session is running, or `"gate"` for the single line emitted
 * when `vibepro pr ship --dry-run` starts. `latest` (the newest commit
 * subject since the run's baseline HEAD) is only included when there is at
 * least one commit — matching the human-readable "0 commits, still
 * analyzing" vs. "N commits, latest: ..." distinction the gateway renders.
 */
export function buildProgressLine(phase, elapsedSec, commits, latest) {
  const payload = { phase, elapsedSec, commits };
  if (phase === "agent" && commits > 0 && typeof latest === "string" && latest.length > 0) {
    payload.latest = latest.replace(/\s+/g, " ").trim().slice(0, MAX_PROGRESS_LATEST_CHARS);
  }
  return `PROGRESS ${JSON.stringify(payload)}`;
}

/** Reads the current HEAD sha of a worktree; used as the progress baseline. */
async function getHeadSha(worktree) {
  return (await runCommand("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: worktree })).trim();
}

/**
 * Counts commits made since `baselineSha` and returns the newest commit's
 * subject line. Never throws to the caller — progress reporting must not be
 * able to affect the development run itself.
 */
async function readProgressSnapshot(worktree, baselineSha) {
  try {
    const log = await runCommand("/usr/bin/git", ["log", "--format=%s", `${baselineSha}..HEAD`], { cwd: worktree });
    const subjects = log.split("\n").filter((line) => line.length > 0);
    return { commits: subjects.length, latest: subjects[0] };
  } catch {
    return null;
  }
}

/**
 * Starts a 60s-interval timer that emits `agent`-phase PROGRESS lines to
 * this process's own stderr. Returns a stopper that must always be called
 * (agent success, agent failure, or timeout) to clear the timer. Returns a
 * no-op stopper when `baselineSha` could not be determined.
 */
function startAgentProgressReporting(worktree, baselineSha, startedAt) {
  if (!baselineSha) return () => {};
  const tick = async () => {
    const snapshot = await readProgressSnapshot(worktree, baselineSha);
    if (!snapshot) return;
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    process.stderr.write(`${buildProgressLine("agent", elapsedSec, snapshot.commits, snapshot.latest)}\n`);
  };
  const timer = setInterval(() => { void tick(); }, PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Emits the single `gate`-phase PROGRESS line when `pr ship` starts. */
async function emitGateProgress(worktree, baselineSha, startedAt) {
  if (!baselineSha) return;
  const snapshot = await readProgressSnapshot(worktree, baselineSha);
  if (!snapshot) return;
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  process.stderr.write(`${buildProgressLine("gate", elapsedSec, snapshot.commits, snapshot.latest)}\n`);
}

async function runAgentAndShip(worktree, storyId, branch, baseBranch, agentArgv, agentEnv, config) {
  const startedAt = Date.now();
  let baselineSha = null;
  try {
    baselineSha = await getHeadSha(worktree);
  } catch {
    // Fail silent: progress reporting is best-effort, never blocks the run.
  }
  const stopProgress = startAgentProgressReporting(worktree, baselineSha, startedAt);

  try {
    await runCommand(config.claudeBin, agentArgv, { cwd: worktree, timeoutMs: config.maxDurationMs, extraEnv: agentEnv });
  } catch (error) {
    stopProgress();
    const reason = (error instanceof Error ? error.message : "unknown agent error").replace(/\s+/g, " ").slice(0, 200);
    const commits = await collectCommits(worktree, baselineSha);
    emit({
      status: "needs_input",
      storyId,
      summary: `Development agent stopped (${reason}). Inspect the worktree before resuming.`,
      commits,
    });
    return;
  }
  stopProgress();

  let questions = null;
  try {
    questions = await readQuestionsFile(worktree);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : "unknown validation error").replace(/\s+/g, " ").slice(0, 200);
    const commits = await collectCommits(worktree, baselineSha);
    emit({
      status: "needs_input",
      storyId,
      summary: `The agent wrote an invalid questions document (${reason}). Inspect the worktree before resuming.`,
      commits,
    });
    return;
  }
  if (questions) {
    emit(resultFromQuestions(storyId, questions));
    return;
  }

  await emitGateProgress(worktree, baselineSha, startedAt);

  const shipStdout = await runCommand(
    config.vibeproBin,
    buildPrShipArgs(storyId, branch, baseBranch),
    { cwd: worktree, timeoutMs: 300_000 },
  );
  const commits = await collectCommits(worktree, baselineSha);
  emit(resultFromAgentRun(shipStdout, storyId, commits));
}

async function runNewStory(request, config) {
  const digest = createHash("sha256").update(request).digest("hex").slice(0, 8);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const storyId = `story-slack-${stamp}-${digest}`;
  const branch = `codex/${storyId}`;
  const worktree = path.join(config.worktreesRoot, storyId);

  await mkdir(config.worktreesRoot, { recursive: true });
  await runCommand("/usr/bin/git", ["fetch", "--prune", "origin"], { cwd: config.repository });
  await runCommand("/usr/bin/git", ["worktree", "add", "-b", branch, worktree, config.baseRef], { cwd: config.repository });
  await runCommand(config.vibeproBin, ["init", ".", "--language", "ja", "--story-id", storyId, "--title", request.slice(0, 120)], { cwd: worktree });
  await ensureGitignoreEntryOnDisk(worktree, ".openryoko/");

  const storyDir = path.join(worktree, "docs", "management", "stories", "active");
  await mkdir(storyDir, { recursive: true });
  const storyPath = path.join(storyDir, `${storyId}.md`);
  await writeFile(storyPath, [
    `# ${storyId}`,
    "",
    "## Slack request",
    "",
    request,
    "",
    "## Safety boundary",
    "",
    "VibePro must stop at pr_ready. It must not create a PR, merge, deploy, change secrets, or modify the runtime checkout.",
    "",
  ].join("\n"), { flag: "wx" });
  const storyRelativePath = path.relative(worktree, storyPath);
  await runCommand("/usr/bin/git", buildStoryAddArgs(storyRelativePath), { cwd: worktree });
  await runCommand("/usr/bin/git", buildStoryCommitArgs(storyId), { cwd: worktree });

  const agentEnv = config.agentEnvFile ? parseEnvFile(await readFile(config.agentEnvFile, "utf8")) : {};
  const baseBranch = config.baseRef.replace(/^origin\//, "");
  await runAgentAndShip(
    worktree,
    storyId,
    branch,
    baseBranch,
    buildAgentArgs(buildAgentPrompt(storyId, request, baseBranch)),
    agentEnv,
    config,
  );
}

async function resumeStory(storyId, answers, config) {
  const worktree = await resolveExistingWorktree(config.worktreesRoot, storyId);
  const branch = `codex/${storyId}`;
  const baseBranch = config.baseRef.replace(/^origin\//, "");

  const storyRelativePath = path.join("docs", "management", "stories", "active", `${storyId}.md`);
  const storyPath = path.join(worktree, storyRelativePath);
  const existingStory = await readFile(storyPath, "utf8");
  await writeFile(storyPath, existingStory + buildHumanAnswersSection(answers));
  await runCommand("/usr/bin/git", buildAnswersAddArgs(storyRelativePath), { cwd: worktree });
  await runCommand("/usr/bin/git", buildAnswersCommitArgs(storyId), { cwd: worktree });
  await rm(path.join(worktree, QUESTIONS_RELATIVE_PATH), { force: true });

  const agentEnv = config.agentEnvFile ? parseEnvFile(await readFile(config.agentEnvFile, "utf8")) : {};
  await runAgentAndShip(
    worktree,
    storyId,
    branch,
    baseBranch,
    buildAgentArgs(buildResumeAgentPrompt(storyId, baseBranch)),
    agentEnv,
    config,
  );
}

/**
 * Continues a Story that previously stopped with `needs_input` because
 * VibePro gates were unresolved. Reuses the existing worktree (same
 * existence/containment check as `resumeStory`) and re-runs the agent with a
 * prompt instructing it to re-derive the remaining gates itself and resolve
 * what it safely can. Unlike `resumeStory`, there is no human answer to
 * record onto the Story doc, so no commit is made before the agent runs.
 */
async function continueGatesStory(storyId, config) {
  const worktree = await resolveExistingWorktree(config.worktreesRoot, storyId);
  const branch = `codex/${storyId}`;
  const baseBranch = config.baseRef.replace(/^origin\//, "");

  const agentEnv = config.agentEnvFile ? parseEnvFile(await readFile(config.agentEnvFile, "utf8")) : {};
  await runAgentAndShip(
    worktree,
    storyId,
    branch,
    baseBranch,
    buildAgentArgs(buildContinueGatesAgentPrompt(storyId, baseBranch)),
    agentEnv,
    config,
  );
}

export async function main() {
let releaseLock;
try {
  releaseLock = await acquireDevelopmentLock();
  const payload = await readStdin();
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  validateConfig(config);

  if (payload.mode === "new") {
    await runNewStory(payload.request, config);
  } else if (payload.mode === "continueGates") {
    await continueGatesStory(payload.storyId, config);
  } else {
    await resumeStory(payload.storyId, payload.answers, config);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "unknown runner error"}\n`);
  emit({ status: "failed", summary: "The isolated development runner stopped safely. No PR or deployment was performed." }, 1);
} finally {
  if (releaseLock) await releaseLock();
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
