#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "/etc/openryoko-development-runner.json";
const MAX_REQUEST_CHARS = 8000;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const LOCK_PATH = "/home/ryoko-dev/.openryoko-development-runner.lock";

function emit(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > MAX_REQUEST_CHARS + 256) throw new Error("request is too large");
  }
  const parsed = JSON.parse(input);
  if (!parsed || Object.keys(parsed).some((key) => key !== "request")) {
    throw new Error("unsupported request field");
  }
  if (typeof parsed.request !== "string" || !parsed.request.trim() || parsed.request.length > MAX_REQUEST_CHARS) {
    throw new Error("invalid request");
  }
  return parsed.request.trim();
}

export async function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? "/",
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
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
    let closedCode;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
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
  });
}

function validateConfig(config) {
  for (const key of ["repository", "worktreesRoot", "vibeproBin"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) throw new Error(`invalid ${key}`);
  }
  if (typeof config.baseRef !== "string" || !/^origin\/[a-zA-Z0-9._/-]+$/.test(config.baseRef)) {
    throw new Error("invalid baseRef");
  }
  if (!Number.isInteger(config.maxDurationMs) || config.maxDurationMs < 60000 || config.maxDurationMs > 5_400_000) {
    throw new Error("invalid maxDurationMs");
  }
}

function safeResultFromRun(raw, storyId) {
  const result = JSON.parse(raw);
  const status = result?.state?.status;
  if (status === "pr_ready") {
    return { status: "pr_ready", storyId, summary: "VibePro gates are ready. PR creation requires a human action." };
  }
  if (["needs_input", "blocked", "paused"].includes(status)) {
    return { status: "needs_input", storyId, summary: `VibePro stopped safely (${status}). Review the run before resuming.` };
  }
  return { status: "failed", storyId, summary: `VibePro ended without PR readiness (${String(status ?? "unknown")}).` };
}

export async function main() {
let lockHeld = false;
try {
  try {
    await mkdir(LOCK_PATH);
    lockHeld = true;
    await writeFile(path.join(LOCK_PATH, "owner"), `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another development task is already running");
    throw error;
  }
  const request = await readStdin();
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  validateConfig(config);

  const digest = createHash("sha256").update(request).digest("hex").slice(0, 8);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const storyId = `story-slack-${stamp}-${digest}`;
  const branch = `codex/${storyId}`;
  const worktree = path.join(config.worktreesRoot, storyId);

  await mkdir(config.worktreesRoot, { recursive: true });
  await runCommand("/usr/bin/git", ["fetch", "--prune", "origin"], { cwd: config.repository });
  await runCommand("/usr/bin/git", ["worktree", "add", "-b", branch, worktree, config.baseRef], { cwd: config.repository });
  await runCommand(config.vibeproBin, ["init", ".", "--language", "ja", "--story-id", storyId, "--title", request.slice(0, 120)], { cwd: worktree });

  const storyDir = path.join(worktree, "docs", "management", "stories", "active");
  await mkdir(storyDir, { recursive: true });
  await writeFile(path.join(storyDir, `${storyId}.md`), [
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

  const raw = await runCommand(config.vibeproBin, [
    "execute", "run", ".", "--story-id", storyId,
    "--until", "pr-ready", "--autonomy", "guarded",
    "--provider-fallbacks", "claude-code",
    "--max-duration-ms", String(config.maxDurationMs), "--json",
  ], { cwd: worktree });
  emit(safeResultFromRun(raw, storyId));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "unknown runner error"}\n`);
  emit({ status: "failed", summary: "The isolated development runner stopped safely. No PR or deployment was performed." }, 1);
} finally {
  if (lockHeld) await rm(LOCK_PATH, { recursive: true, force: true });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
