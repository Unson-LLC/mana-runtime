#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CALLBACK_PROXY = "https://development-callback.internal/callback";
const MAX_OUTPUT = 12_000;
const CALLBACK_TIMEOUT_MS = 8_000;
const FORCE_KILL_DELAY_MS = 1_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, timeoutMs, onStderrLine, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";
    let timedOut = false;
    let forceKillTimer;
    const emitStderrLines = (chunk, flush = false) => {
      stderrBuffer += chunk;
      let newline = stderrBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        onStderrLine?.(line);
        newline = stderrBuffer.indexOf("\n");
      }
      if (flush && stderrBuffer) {
        onStderrLine?.(stderrBuffer);
        stderrBuffer = "";
      }
    };
    const timeoutTimer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    }, timeoutMs) : undefined;
    timeoutTimer?.unref?.();
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT * 4); });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-MAX_OUTPUT);
      emitStderrLines(text);
    });
    child.stderr.on("end", () => emitStderrLines("", true));
    child.on("error", (error) => { clearTimers(); reject(error); });
    child.on("close", (code) => { clearTimers(); resolve({ code, stdout, stderr, timedOut }); });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function remainingTime(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("development_runner_timed_out");
  return remaining;
}

export function parseRunnerResult(stdout) {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.status === "string" && typeof value.summary === "string") return value;
    } catch {}
  }
  return { status: "failed", summary: "Cloudflare development runner produced no valid result." };
}

export function parseProgressLine(line) {
  if (!line.startsWith("PROGRESS ")) return undefined;
  let value;
  try { value = JSON.parse(line.slice("PROGRESS ".length)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Number.isInteger(value.elapsedSec) || value.elapsedSec < 0 || value.elapsedSec > 86_400
    || !Number.isInteger(value.commits) || value.commits < 0 || value.commits > 10_000
    || (value.phase !== "agent" && value.phase !== "gate")) return undefined;
  if (value.latest !== undefined && (typeof value.latest !== "string" || value.latest.length > 200)) return undefined;
  const phase = value.phase === "gate" ? "verifying" : value.commits > 0 ? "implementing" : "analyzing";
  return {
    phase,
    elapsed_sec: value.elapsedSec,
    commits: value.commits,
    ...(typeof value.latest === "string" && value.latest ? { latest: value.latest } : {}),
  };
}

function safeRunnerFailureReason(stderr, code) {
  const lines = String(stderr ?? "").trim().split("\n").reverse();
  const commandFailure = lines.find((line) => /^[a-z0-9._/-]+ exited with code [0-9]+$/i.test(line.trim()));
  return commandFailure?.trim() ?? `runner_exit_${Number.isInteger(code) ? code : "unknown"}`;
}

async function ensureRepository(deadlineAt) {
  await mkdir("/srv/openryoko-development", { recursive: true });
  const probe = await run("/usr/bin/git", ["-C", "/srv/openryoko-development/repository", "rev-parse", "--git-dir"], {
    timeoutMs: remainingTime(deadlineAt),
  });
  if (probe.timedOut) throw new Error("development_runner_timed_out");
  if (probe.code === 0) {
    const fetched = await run("/usr/bin/git", ["-C", "/srv/openryoko-development/repository", "fetch", "origin", "main"], {
      timeoutMs: remainingTime(deadlineAt),
    });
    if (fetched.timedOut) throw new Error("development_runner_timed_out");
    if (fetched.code !== 0) throw new Error(`repository_fetch_failed:${fetched.code}`);
    return;
  }
  const cloned = await run("/usr/bin/git", ["clone", "https://github.com/Unson-LLC/mana-runtime.git", "/srv/openryoko-development/repository"], {
    timeoutMs: remainingTime(deadlineAt),
  });
  if (cloned.timedOut) throw new Error("development_runner_timed_out");
  if (cloned.code !== 0) throw new Error(`repository_clone_failed:${cloned.code}`);
}

function callbackBase(job) {
  return {
    job_id: job.job_id,
    event_id: job.event_id,
    placement_id: job.placement_id,
    workspace_id: job.workspace_id,
    channel_id: job.channel_id,
    thread_ts: job.thread_ts,
    requester_id: job.requester_id,
    quota_decision: job.quota_decision,
  };
}

export function buildTerminalCallback(job, runner) {
  const status = runner.status === "pr_ready" ? "completed"
    : (["needs_decision", "needs_input", "failed", "timed_out"].includes(runner.status) ? runner.status : "failed");
  return {
    ...callbackBase(job),
    status,
    summary: String(runner.summary ?? "Development runner failed safely.").slice(0, MAX_OUTPUT),
    ...(typeof runner.storyId === "string" ? { story_id: runner.storyId } : {}),
    ...(typeof runner.prUrl === "string" ? { pr_url: runner.prUrl } : {}),
    ...(Array.isArray(runner.questions) ? { questions: runner.questions } : {}),
    ...(Array.isArray(runner.gates) ? { gates: runner.gates } : {}),
    ...(runner.commits && typeof runner.commits === "object" ? { commits: runner.commits } : {}),
  };
}

async function postCallback(callback) {
  const response = await fetch(CALLBACK_PROXY, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mana-tenant-boundary-handle": process.env.MANA_TENANT_BOUNDARY_HANDLE ?? "",
    },
    body: JSON.stringify(callback),
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("development_callback_failed");
}

async function postProgress(job, progress) {
  const labels = { analyzing: "依頼を整理しています", implementing: "変更を進めています", verifying: "変更内容を確認しています" };
  await postCallback({
    ...callbackBase(job),
    status: "progress",
    summary: labels[progress.phase] ?? "改善を進めています",
    progress,
  });
}

async function postResult(job, runner) {
  await postCallback(buildTerminalCallback(job, runner));
}

export async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !/^\/tmp\/development-[A-Za-z0-9_-]{1,96}\.json$/.test(jobPath)) throw new Error("invalid_job_path");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  if (typeof job.job_id !== "string" || jobPath !== `/tmp/${job.job_id}.json`
    || !/^development-[A-Za-z0-9_-]{43}$/.test(job.job_id)) throw new Error("invalid_job_id");
  if (!Number.isInteger(job.runner_timeout_ms) || job.runner_timeout_ms <= 0 || job.runner_timeout_ms > 4_800_000) {
    throw new Error("invalid_runner_timeout");
  }
  const runnerDeadlineAt = Date.now() + job.runner_timeout_ms;
  let runner;
  let progressChain = Promise.resolve();
  const enqueueProgress = (progress) => {
    progressChain = progressChain.then(() => postProgress(job, progress)).catch(() => undefined);
  };
  try {
    enqueueProgress({ phase: "analyzing", elapsed_sec: 0, commits: 0 });
    await ensureRepository(runnerDeadlineAt);
    const runnerInput = job.mode === "resume"
      ? { storyId: job.story_id, answers: job.answers }
      : job.mode === "continueGates"
        ? { storyId: job.story_id, continueGates: true }
        : { request: job.request };
    const result = await run(process.execPath, ["/opt/mana/openryoko-development-runner.mjs"], {
      stdin: JSON.stringify(runnerInput),
      timeoutMs: remainingTime(runnerDeadlineAt),
      onStderrLine: (line) => {
        const progress = parseProgressLine(line);
        if (progress) enqueueProgress(progress);
      },
    });
    if (result.timedOut) {
      runner = {
        status: "timed_out",
        summary: "Cloudflare development runner reached its signed tenant-context deadline. No PR or deployment was performed.",
      };
    } else {
      runner = parseRunnerResult(result.stdout);
      if (runner.status === "failed") {
        runner = {
          ...runner,
          summary: `The isolated development runner stopped safely (${safeRunnerFailureReason(result.stderr, result.code)}). No PR or deployment was performed.`,
        };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "development_runner_failed";
    runner = {
      status: reason === "development_runner_timed_out" ? "timed_out" : "failed",
      summary: `Cloudflare development runner stopped safely (${reason}). No PR or deployment was performed.`,
    };
  }
  await progressChain;
  await postResult(job, runner);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "development_runner_failed"}\n`);
    process.exitCode = 1;
  });
}
