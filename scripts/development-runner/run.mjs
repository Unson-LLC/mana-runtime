#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "/etc/openryoko-development-runner.json";
const MAX_REQUEST_CHARS = 8000;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const LOCK_PATH = "/home/ryoko-dev/.openryoko-development-runner.lock";
export const RUNNER_VERSION = "2026-07-31.1";

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

export async function acquireDevelopmentLock(lockPath = LOCK_PATH) {
  let directoryCreated = false;
  try {
    await mkdir(lockPath);
    directoryCreated = true;
    await writeFile(path.join(lockPath, "owner"), `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (directoryCreated) await rm(lockPath, { recursive: true, force: true });
    if (error?.code === "EEXIST") throw new Error("another development task is already running");
    throw error;
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
 * Exactly one of the two shapes is accepted:
 *   - `{"request": string}` — start a new Story.
 *   - `{"storyId": string, "answers": [{id, answer}, ...]}` — resume a Story
 *     that previously stopped with `needs_decision`.
 * Any other shape (unknown fields, both shapes present, wrong types) fails
 * closed with an error — this stdin payload is untrusted gateway input.
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
  const hasResume = keys.includes("storyId") || keys.includes("answers");

  if (hasRequest && hasResume) throw new Error("request and storyId/answers are mutually exclusive");

  if (hasRequest) {
    if (keys.some((key) => key !== "request")) throw new Error("unsupported request field");
    if (typeof parsed.request !== "string" || !parsed.request.trim() || parsed.request.length > MAX_REQUEST_CHARS) {
      throw new Error("invalid request");
    }
    return { mode: "new", request: parsed.request.trim() };
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

export function resultFromAgentRun(shipStdout, storyId) {
  if (parsePrShipReadiness(shipStdout)) {
    return { status: "pr_ready", storyId, summary: "VibePro gates are ready. PR creation requires a human action." };
  }
  const gates = extractBlockingGates(shipStdout);
  const detail = gates.length > 0 ? ` ${gates.length} gate(s) remain, e.g.: ${gates[0].slice(0, 200)}` : "";
  return { status: "needs_input", storyId, summary: `VibePro gates are not resolved yet.${detail} Review the worktree before resuming.` };
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

async function runAgentAndShip(worktree, storyId, branch, baseBranch, agentArgv, agentEnv, config) {
  try {
    await runCommand(config.claudeBin, agentArgv, { cwd: worktree, timeoutMs: config.maxDurationMs, extraEnv: agentEnv });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : "unknown agent error").replace(/\s+/g, " ").slice(0, 200);
    emit({ status: "needs_input", storyId, summary: `Development agent stopped (${reason}). Inspect the worktree before resuming.` });
    return;
  }

  let questions = null;
  try {
    questions = await readQuestionsFile(worktree);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : "unknown validation error").replace(/\s+/g, " ").slice(0, 200);
    emit({ status: "needs_input", storyId, summary: `The agent wrote an invalid questions document (${reason}). Inspect the worktree before resuming.` });
    return;
  }
  if (questions) {
    emit(resultFromQuestions(storyId, questions));
    return;
  }

  const shipStdout = await runCommand(
    config.vibeproBin,
    buildPrShipArgs(storyId, branch, baseBranch),
    { cwd: worktree, timeoutMs: 300_000 },
  );
  emit(resultFromAgentRun(shipStdout, storyId));
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

export async function main() {
let releaseLock;
try {
  releaseLock = await acquireDevelopmentLock();
  const payload = await readStdin();
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  validateConfig(config);

  if (payload.mode === "new") {
    await runNewStory(payload.request, config);
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
