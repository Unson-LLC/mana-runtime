import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  DevelopmentRunnerConfig,
  DevelopmentQuestion,
  DevelopmentQuestionOption,
  DevelopmentAnswer,
  DevelopmentProgress,
  DevelopmentGate,
  DevelopmentCommits,
} from "../shared/types.js";

export type { DevelopmentQuestion, DevelopmentQuestionOption, DevelopmentAnswer, DevelopmentProgress, DevelopmentGate, DevelopmentCommits } from "../shared/types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REQUEST_CHARS = 8000;
export const DEFAULT_DEVELOPMENT_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = DEFAULT_DEVELOPMENT_TIMEOUT_MS;
const PROGRESS_LINE_PREFIX = "PROGRESS ";
const MAX_STDERR_PARSE_BYTES = 1 * 1024 * 1024;
const MAX_PROGRESS_LATEST_CHARS = 300;
const PROGRESS_PHASES = new Set(["agent", "gate"]);
const ALLOWED_RESULT_KEYS = new Set(["status", "storyId", "prUrl", "summary", "questions", "gates", "commits"]);
const ALLOWED_STATUSES = new Set(["queued", "pr_ready", "needs_input", "needs_decision", "failed"]);
const PR_URL_RE = /^https:\/\/github\.com\/Unson-LLC\/brainbase-mana\/pull\/\d+$/;
const STORY_ID_RE = /^story-[a-z0-9-]+$/;
const QUESTION_ID_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_QUESTIONS = 5;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS_PER_QUESTION = 5;
const MAX_OPTION_LABEL_CHARS = 80;
const MAX_OPTION_DESCRIPTION_CHARS = 200;
const MAX_ANSWERS = 10;
const MAX_ANSWER_CHARS = 2000;
const MAX_GATES = 30;
const MAX_GATE_TEXT_CHARS = 500;
const MAX_COMMIT_SUBJECTS = 5;
const MAX_COMMIT_SUBJECT_CHARS = 200;
const MAX_COMMIT_COUNT = 10000;
const GATE_STATUSES = new Set(["needs_input", "pr_ready"]);

export interface DevelopmentResult {
  status: "queued" | "pr_ready" | "needs_input" | "needs_decision" | "failed";
  storyId?: string;
  prUrl?: string;
  summary: string;
  questions?: DevelopmentQuestion[];
  gates?: DevelopmentGate[];
  commits?: DevelopmentCommits;
}

/** Resume request: continue a Story that previously stopped with `needs_decision`. */
export interface DevelopmentResumeRequest {
  storyId: string;
  answers: DevelopmentAnswer[];
}

/**
 * Resume request: continue a Story that previously stopped with
 * `needs_input` because VibePro gates were unresolved. Re-runs the agent in
 * the same worktree with an instruction to resolve the remaining gates
 * (evidence recording, review dispatch, scope trims), then falls through to
 * the same `pr ship --dry-run` readiness check.
 */
export interface DevelopmentContinueGatesRequest {
  storyId: string;
  continueGates: true;
}

type SpawnFn = typeof spawn;

async function waitForProcessGroupExit(pid: number): Promise<void> {
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        continue;
      }
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function validateConfig(config: DevelopmentRunnerConfig): void {
  if (!config.enabled) throw new Error("development runner is disabled");
  if (!path.isAbsolute(config.bin)) throw new Error("development runner bin must be absolute");
  if ((config.args ?? []).some((arg) => arg.includes("\0") || arg.includes("\n"))) {
    throw new Error("development runner args contain forbidden characters");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses one line of the runner's stderr as a `PROGRESS <json>` progress
 * snapshot. Returns `null` for anything that doesn't match the schema
 * exactly (missing prefix, malformed JSON, unsupported field, out-of-range
 * value, unknown phase) — malformed progress lines are silently ignored,
 * never treated as a runner failure.
 */
export function parseProgressLine(line: string): DevelopmentProgress | null {
  if (!line.startsWith(PROGRESS_LINE_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(PROGRESS_LINE_PREFIX.length));
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const allowedKeys = new Set(["phase", "elapsedSec", "commits", "latest"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (typeof value.phase !== "string" || !PROGRESS_PHASES.has(value.phase)) return null;
  if (!Number.isInteger(value.elapsedSec) || (value.elapsedSec as number) < 0) return null;
  if (!Number.isInteger(value.commits) || (value.commits as number) < 0 || (value.commits as number) > 1000) return null;
  if (
    value.latest !== undefined &&
    (typeof value.latest !== "string" || value.latest.length === 0 || value.latest.length > MAX_PROGRESS_LATEST_CHARS)
  ) {
    return null;
  }
  return {
    phase: value.phase as DevelopmentProgress["phase"],
    elapsedSec: value.elapsedSec as number,
    commits: value.commits as number,
    ...(typeof value.latest === "string" ? { latest: value.latest } : {}),
  };
}

/**
 * Wires a child's stderr into the `PROGRESS` line parser, draining stderr
 * either way (the runner also writes plain diagnostic text there, which is
 * still discarded). Bounded by `MAX_STDERR_PARSE_BYTES` total: once stderr
 * exceeds that, parsing stops silently but the process keeps running — a
 * runaway or malicious stderr stream must not be able to affect the run.
 */
function attachProgressParsing(
  stderr: NodeJS.ReadableStream,
  onProgress?: (progress: DevelopmentProgress) => void,
): void {
  let buffer = "";
  let consumedBytes = 0;
  let truncated = false;
  stderr.on("data", (chunk: Buffer) => {
    if (truncated) return;
    consumedBytes += chunk.length;
    if (consumedBytes > MAX_STDERR_PARSE_BYTES) {
      truncated = true;
      buffer = "";
      return;
    }
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (onProgress) {
        const progress = parseProgressLine(line);
        if (progress) onProgress(progress);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

function assertBoundedString(value: unknown, min: number, max: number, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`development runner returned an invalid ${label}`);
  }
}

function parseQuestions(value: unknown): DevelopmentQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    throw new Error(`development runner returned needs_decision without 1-${MAX_QUESTIONS} questions`);
  }
  const seenIds = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw)) throw new Error("development runner returned an invalid question entry");
    const allowedKeys = new Set(["id", "question", "options", "allow_free_text"]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new Error("development runner returned an unsupported question field");
    }
    if (typeof raw.id !== "string" || !QUESTION_ID_RE.test(raw.id)) {
      throw new Error("development runner returned an invalid question id");
    }
    if (seenIds.has(raw.id)) throw new Error(`development runner returned a duplicate question id: ${raw.id}`);
    seenIds.add(raw.id);
    assertBoundedString(raw.question, 1, MAX_QUESTION_CHARS, "question text");
    const options = raw.options === undefined ? [] : raw.options;
    if (!Array.isArray(options) || options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new Error("development runner returned invalid question options");
    }
    const normalizedOptions: DevelopmentQuestionOption[] = options.map((rawOption) => {
      if (!isPlainObject(rawOption)) throw new Error("development runner returned an invalid option entry");
      const allowedOptionKeys = new Set(["label", "description", "recommended"]);
      if (Object.keys(rawOption).some((key) => !allowedOptionKeys.has(key))) {
        throw new Error("development runner returned an unsupported option field");
      }
      assertBoundedString(rawOption.label, 1, MAX_OPTION_LABEL_CHARS, "option label");
      if (rawOption.description !== undefined) {
        assertBoundedString(rawOption.description, 0, MAX_OPTION_DESCRIPTION_CHARS, "option description");
      }
      if (rawOption.recommended !== undefined && typeof rawOption.recommended !== "boolean") {
        throw new Error("development runner returned an invalid option recommended flag");
      }
      return {
        label: rawOption.label as string,
        ...(rawOption.description !== undefined ? { description: rawOption.description as string } : {}),
        ...(rawOption.recommended !== undefined ? { recommended: rawOption.recommended as boolean } : {}),
      };
    });
    if (raw.allow_free_text !== undefined && typeof raw.allow_free_text !== "boolean") {
      throw new Error("development runner returned an invalid allow_free_text flag");
    }
    return {
      id: raw.id,
      question: raw.question as string,
      options: normalizedOptions,
      allow_free_text: raw.allow_free_text === true,
    };
  });
}

function parseGates(value: unknown): DevelopmentGate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GATES) {
    throw new Error(`development runner returned invalid gates`);
  }
  return value.map((raw) => {
    if (!isPlainObject(raw)) throw new Error("development runner returned an invalid gate entry");
    const allowedKeys = new Set(["severity", "text"]);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new Error("development runner returned an unsupported gate field");
    }
    if (raw.severity !== "critical" && raw.severity !== "evidence") {
      throw new Error("development runner returned an invalid gate severity");
    }
    assertBoundedString(raw.text, 1, MAX_GATE_TEXT_CHARS, "gate text");
    return { severity: raw.severity, text: raw.text as string };
  });
}

function parseCommits(value: unknown): DevelopmentCommits {
  if (!isPlainObject(value)) throw new Error("development runner returned invalid commits");
  const allowedKeys = new Set(["count", "subjects"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("development runner returned an unsupported commits field");
  }
  if (!Number.isInteger(value.count) || (value.count as number) < 0 || (value.count as number) > MAX_COMMIT_COUNT) {
    throw new Error("development runner returned an invalid commits count");
  }
  if (!Array.isArray(value.subjects) || value.subjects.length > MAX_COMMIT_SUBJECTS) {
    throw new Error("development runner returned invalid commit subjects");
  }
  const subjects = value.subjects.map((raw) => {
    assertBoundedString(raw, 1, MAX_COMMIT_SUBJECT_CHARS, "commit subject");
    return raw as string;
  });
  return { count: value.count as number, subjects };
}

export function parseDevelopmentResult(raw: string): DevelopmentResult {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("development runner returned malformed JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("development runner returned a non-object result");
  }
  if (Object.keys(value).some((key) => !ALLOWED_RESULT_KEYS.has(key))) {
    throw new Error("development runner returned an unsupported field");
  }
  if (typeof value.status !== "string" || !ALLOWED_STATUSES.has(value.status)) {
    throw new Error("development runner returned an invalid status");
  }
  if (typeof value.summary !== "string" || value.summary.length === 0 || value.summary.length > 1000) {
    throw new Error("development runner returned an invalid summary");
  }
  if (value.storyId !== undefined && (typeof value.storyId !== "string" || !/^story-[a-z0-9-]+$/.test(value.storyId))) {
    throw new Error("development runner returned an invalid story id");
  }
  if (value.prUrl !== undefined && (typeof value.prUrl !== "string" || !PR_URL_RE.test(value.prUrl))) {
    throw new Error("development runner returned an invalid PR URL");
  }
  const status = value.status as DevelopmentResult["status"];
  if (status !== "failed" && typeof value.storyId !== "string") {
    throw new Error(`development runner returned ${status} without a story id`);
  }
  if (status !== "pr_ready" && value.prUrl !== undefined) {
    throw new Error(`development runner returned a PR URL for ${status}`);
  }
  if (status === "needs_decision" && value.questions === undefined) {
    throw new Error("development runner returned needs_decision without questions");
  }
  if (status !== "needs_decision" && value.questions !== undefined) {
    throw new Error(`development runner returned questions for ${status}`);
  }
  if (value.gates !== undefined && !GATE_STATUSES.has(status)) {
    throw new Error(`development runner returned gates for ${status}`);
  }
  if (value.commits !== undefined && !GATE_STATUSES.has(status)) {
    throw new Error(`development runner returned commits for ${status}`);
  }
  const result: DevelopmentResult = {
    status,
    summary: value.summary,
    ...(typeof value.storyId === "string" ? { storyId: value.storyId } : {}),
    ...(typeof value.prUrl === "string" ? { prUrl: value.prUrl } : {}),
    ...(value.questions !== undefined ? { questions: parseQuestions(value.questions) } : {}),
    ...(value.gates !== undefined ? { gates: parseGates(value.gates) } : {}),
    ...(value.commits !== undefined ? { commits: parseCommits(value.commits) } : {}),
  };
  return result;
}

function validateResumeRequest(request: DevelopmentResumeRequest): DevelopmentResumeRequest {
  if (typeof request.storyId !== "string" || !STORY_ID_RE.test(request.storyId)) {
    throw new Error("development resume storyId is invalid");
  }
  if (!Array.isArray(request.answers) || request.answers.length < 1 || request.answers.length > MAX_ANSWERS) {
    throw new Error(`development resume answers must contain 1-${MAX_ANSWERS} entries`);
  }
  const seenIds = new Set<string>();
  const answers = request.answers.map((answer) => {
    if (typeof answer.id !== "string" || !QUESTION_ID_RE.test(answer.id)) {
      throw new Error("development resume answer id is invalid");
    }
    if (seenIds.has(answer.id)) throw new Error(`development resume has a duplicate answer id: ${answer.id}`);
    seenIds.add(answer.id);
    if (typeof answer.answer !== "string" || answer.answer.length === 0 || answer.answer.length > MAX_ANSWER_CHARS) {
      throw new Error("development resume answer text is invalid");
    }
    return { id: answer.id, answer: answer.answer };
  });
  return { storyId: request.storyId, answers };
}

function validateContinueGatesRequest(request: DevelopmentContinueGatesRequest): DevelopmentContinueGatesRequest {
  if (typeof request.storyId !== "string" || !STORY_ID_RE.test(request.storyId)) {
    throw new Error("development continue-gates storyId is invalid");
  }
  if (request.continueGates !== true) {
    throw new Error("development continue-gates request must set continueGates: true");
  }
  return { storyId: request.storyId, continueGates: true };
}

function isContinueGatesRequest(
  request: DevelopmentResumeRequest | DevelopmentContinueGatesRequest,
): request is DevelopmentContinueGatesRequest {
  return (request as DevelopmentContinueGatesRequest).continueGates === true;
}

export async function runDevelopmentRequest(
  config: DevelopmentRunnerConfig,
  request: string | DevelopmentResumeRequest | DevelopmentContinueGatesRequest,
  spawnFn: SpawnFn = spawn,
  onProgress?: (progress: DevelopmentProgress) => void,
): Promise<DevelopmentResult> {
  validateConfig(config);
  const stdinPayload: string = typeof request === "string"
    ? (() => {
        if (!request.trim()) throw new Error("development request is empty");
        if (request.length > MAX_REQUEST_CHARS) throw new Error("development request is too large");
        return JSON.stringify({ request: request.trim() });
      })()
    : isContinueGatesRequest(request)
      ? JSON.stringify(validateContinueGatesRequest(request))
      : JSON.stringify(validateResumeRequest(request));

  return new Promise((resolve, reject) => {
    const child = spawnFn(config.bin, config.args ?? [], {
      cwd: "/",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let closedCode: number | null | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      const pid = child.pid;
      const signal = (name: NodeJS.Signals) => {
        if (pid && process.platform !== "win32") {
          try { process.kill(-pid, name); } catch { child.kill(name); }
        } else {
          child.kill(name);
        }
      };
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        signal("SIGKILL");
        void (async () => {
          if (pid && process.platform !== "win32") {
            try {
              await waitForProcessGroupExit(pid);
            } catch (error) {
              finish(() => reject(error));
              return;
            }
          }
          if (closedCode !== undefined) finish(() => reject(terminationError!));
        })();
      }, 5000);
    };
    const timer = setTimeout(() => {
      terminate(new Error("development runner timed out"));
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error("development runner output exceeded limit"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    attachProgressParsing(child.stderr, onProgress);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      closedCode = code;
      // A detached group leader may exit on SIGTERM while a descendant keeps
      // running. Keep the lock/state until the scheduled group SIGKILL fires.
      if (terminationError && killTimer) return;
      finish(() => {
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`development runner exited with code ${code ?? "unknown"}`));
        return;
      }
      try {
        resolve(parseDevelopmentResult(stdout.trim()));
      } catch (error) {
        reject(error);
      }
      });
    });
    child.stdin.end(`${stdinPayload}\n`);
  });
}

export function formatDevelopmentResult(result: DevelopmentResult): string {
  const lines = [
    `Development: ${result.status}`,
    result.storyId ? `Story: ${result.storyId}` : null,
    result.prUrl ? `PR: ${result.prUrl}` : null,
    result.status === "needs_decision"
      ? `質問${result.questions?.length ?? 0}件（Slackカードで回答してください）`
      : null,
    result.summary,
  ].filter(Boolean);
  return lines.join("\n");
}
