#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CALLBACK_PROXY = "https://development-callback.internal/callback";
const MAX_OUTPUT = 12_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT * 4); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
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

async function ensureRepository() {
  await mkdir("/srv/openryoko-development", { recursive: true });
  const probe = await run("/usr/bin/git", ["-C", "/srv/openryoko-development/repository", "rev-parse", "--git-dir"]);
  if (probe.code === 0) {
    const fetched = await run("/usr/bin/git", ["-C", "/srv/openryoko-development/repository", "fetch", "origin", "main"]);
    if (fetched.code !== 0) throw new Error(`repository_fetch_failed:${fetched.code}`);
    return;
  }
  const cloned = await run("/usr/bin/git", ["clone", "https://github.com/Unson-LLC/mana-runtime.git", "/srv/openryoko-development/repository"]);
  if (cloned.code !== 0) throw new Error(`repository_clone_failed:${cloned.code}`);
}

async function postResult(job, runner) {
  const status = runner.status === "pr_ready" ? "completed" :
    (["needs_decision", "needs_input", "failed"].includes(runner.status) ? runner.status : "failed");
  const callback = {
    job_id: `development-${job.event_id}`,
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
  });
  if (!response.ok) throw new Error("development_callback_failed");
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !/^\/tmp\/development-[A-Za-z0-9_-]{1,96}\.json$/.test(jobPath)) throw new Error("invalid_job_path");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  let runner;
  try {
    await ensureRepository();
    const result = await run("/usr/bin/node", ["/opt/mana/openryoko-development-runner.mjs"], {
      stdin: JSON.stringify({ mode: "new", request: job.request }),
    });
    runner = parseRunnerResult(result.stdout);
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
