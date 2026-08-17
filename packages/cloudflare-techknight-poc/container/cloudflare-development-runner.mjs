#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CALLBACK_PROXY = "https://development-callback.internal/callback";
const MAX_OUTPUT = 12_000;
const CALLBACK_TIMEOUT_MS = 8_000;
const FORCE_KILL_DELAY_MS = 1_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer;
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
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
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

function parseRunnerResult(stdout) {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.status === "string" && typeof value.summary === "string") return value;
    } catch {}
  }
  return { status: "failed", summary: "Cloudflare development runner produced no valid result." };
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

async function postResult(job, runner) {
  const status = runner.status === "pr_ready" ? "completed" :
    (["needs_decision", "needs_input", "failed"].includes(runner.status) ? runner.status : "failed");
  const callback = {
    job_id: job.job_id,
    event_id: job.event_id,
    placement_id: job.placement_id,
    workspace_id: job.workspace_id,
    channel_id: job.channel_id,
    thread_ts: job.thread_ts,
    requester_id: job.requester_id,
    status,
    summary: String(runner.summary ?? "Development runner failed safely.").slice(0, MAX_OUTPUT),
    ...(typeof runner.storyId === "string" ? { story_id: runner.storyId } : {}),
  };
  const response = await fetch(CALLBACK_PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(callback),
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("development_callback_failed");
}

async function main() {
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
  try {
    await ensureRepository(runnerDeadlineAt);
    const result = await run(process.execPath, ["/opt/mana/openryoko-development-runner.mjs"], {
      stdin: JSON.stringify({ request: job.request }),
      timeoutMs: remainingTime(runnerDeadlineAt),
    });
    if (result.timedOut) {
      runner = { status: "failed", summary: "Cloudflare development runner reached its signed tenant-context deadline. No PR or deployment was performed." };
    } else {
      runner = parseRunnerResult(result.stdout);
      if (runner.status === "failed") {
        runner = { ...runner, summary: `The isolated development runner stopped safely (${safeRunnerFailureReason(result.stderr, result.code)}). No PR or deployment was performed.` };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "development_runner_failed";
    runner = { status: "failed", summary: `Cloudflare development runner stopped safely (${reason}). No PR or deployment was performed.` };
  }
  await postResult(job, runner);
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "development_runner_failed"}\n`);
  process.exitCode = 1;
});
