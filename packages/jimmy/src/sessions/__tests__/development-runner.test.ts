import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDevelopmentResult, runDevelopmentRequest } from "../development-runner.js";
// The production runner is intentionally plain ESM so it can be installed as a standalone script.
// @ts-expect-error no TypeScript declaration is shipped for the standalone runner.
import { RUNNER_VERSION, buildStoryAddArgs, buildStoryCommitArgs, buildValidatedResumeArgs, buildVibeproRunArgs, parseNoProgressRecovery, resumeNoProgressOnce, runCommand, runVibeproUntilSafeStop, safeResultFromRun, validateConfig } from "../../../../../scripts/development-runner/run.mjs";

function childReturning(stdout: string, code = 0) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

describe("development runner", () => {
  it("records only the generated Story and VibePro selection inputs", () => {
    expect(buildStoryAddArgs("docs/management/stories/active/story-safe-change.md")).toEqual([
      "add", "-f", "--", ".gitignore", ".vibepro/config.json",
      "docs/management/stories/active/story-safe-change.md",
    ]);
  });

  it("records the Slack request as a deterministic local Story commit", () => {
    expect(buildStoryCommitArgs("story-safe-change")).toEqual([
      "-c", "user.name=OpenRyoko Development Runner",
      "-c", "user.email=openryoko-runner@localhost",
      "commit", "-m", "chore: record story-safe-change request",
    ]);
  });

  it("uses the locally-contained Codex runtime before Claude Code fallback", () => {
    expect(buildVibeproRunArgs("story-safe-change", 60_000)).toEqual(expect.arrayContaining([
      "--provider-fallbacks",
      "codex,claude-code",
    ]));
  });

  it.each(["waiting_for_runtime", "waiting_for_human"])("returns %s as an actionable safe stop", (status) => {
    expect(safeResultFromRun(JSON.stringify({ state: { status } }), "story-safe-change")).toEqual({
      status: "needs_input",
      storyId: "story-safe-change",
      summary: `VibePro stopped safely (${status}). Review the run before resuming.`,
    });
  });

  it("reconstructs a fixed resume argv only for the current no_progress Story", async () => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-"));
    const managed = path.join(outer, ".worktrees", "vibepro", "story-safe-change-abc123");
    await mkdir(managed, { recursive: true });
    const raw = JSON.stringify({ state: {
      status: "blocked",
      stop_reason: { code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${managed} --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } } },
    } });

    try {
      expect(parseNoProgressRecovery(raw, "story-safe-change")).toEqual({
        managedWorktree: managed,
        runId: "run-20260727T003335Z-373e6b15",
      });
      expect(await buildValidatedResumeArgs(raw, "story-safe-change", outer)).toEqual([
        "execute", "resume", await realpath(managed),
        "--story-id", "story-safe-change",
        "--run-id", "run-20260727T003335Z-373e6b15",
        "--until", "pr-ready",
        "--json",
      ]);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it.each([
    ["other stop", { status: "blocked", stop_reason: { code: "needs_decision" } }],
    ["other Story", { status: "blocked", stop_reason: { code: "no_progress", details: { recovery: { next_command: "vibepro execute resume /tmp/x --story-id story-other --run-id run-20260727T003335Z-373e6b15 --until pr-ready" } } } }],
    ["extra argument", { status: "blocked", stop_reason: { code: "no_progress", details: { recovery: { next_command: "vibepro execute resume /tmp/x --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready; touch /tmp/x" } } } }],
  ])("rejects unsafe recovery: %s", (_name, state) => {
    expect(parseNoProgressRecovery(JSON.stringify({ state }), "story-safe-change")).toBeNull();
  });

  it("rejects a managed-worktree symlink that escapes the current Story", async () => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-"));
    const outside = await mkdtemp(path.join(tmpdir(), "openryoko-outside-"));
    const root = path.join(outer, ".worktrees", "vibepro");
    const linked = path.join(root, "story-safe-change-escape");
    await mkdir(root, { recursive: true });
    await symlink(outside, linked);
    const raw = JSON.stringify({ state: { status: "blocked", stop_reason: {
      code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${linked} --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } },
    } } });

    try {
      expect(await buildValidatedResumeArgs(raw, "story-safe-change", outer)).toBeNull();
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("resumes no_progress once inside the remaining wall-clock budget", async () => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-"));
    const managed = path.join(outer, ".worktrees", "vibepro", "story-safe-change-abc123");
    await mkdir(managed, { recursive: true });
    const raw = JSON.stringify({ state: { status: "blocked", stop_reason: {
      code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${managed} --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } },
    } } });
    const runCommandFn = vi.fn(async (_bin: string, _args: string[], _options: Record<string, unknown>) =>
      JSON.stringify({ state: { status: "pr_ready" } }));

    try {
      const result = await resumeNoProgressOnce(raw, {
        storyId: "story-safe-change",
        outerWorktree: outer,
        vibeproBin: "/usr/local/bin/vibepro",
        deadlineMs: Date.now() + 60_000,
        runCommandFn,
      });
      expect(safeResultFromRun(result, "story-safe-change").status).toBe("pr_ready");
      expect(runCommandFn).toHaveBeenCalledTimes(1);
      expect(runCommandFn.mock.calls[0][2]).toEqual(expect.objectContaining({
        cwd: outer,
        timeoutMs: expect.any(Number),
      }));
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("does not resume after the wall-clock budget is exhausted", async () => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-"));
    const managed = path.join(outer, ".worktrees", "vibepro", "story-safe-change-abc123");
    await mkdir(managed, { recursive: true });
    const raw = JSON.stringify({ state: { status: "blocked", stop_reason: {
      code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${managed} --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } },
    } } });
    const runCommandFn = vi.fn();

    try {
      expect(await resumeNoProgressOnce(raw, {
        storyId: "story-safe-change",
        outerWorktree: outer,
        vibeproBin: "/usr/local/bin/vibepro",
        deadlineMs: Date.now() - 1,
        runCommandFn,
      })).toBe(raw);
      expect(runCommandFn).not.toHaveBeenCalled();
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it.each([
    ["reaches pr_ready after one bounded resume", "pr_ready", "pr_ready", 1],
    ["stops after a resumed run reports no_progress again", "blocked", "needs_input", 1],
  ])("orchestrates the final output surface: %s", async (_name, resumedStatus, expectedStatus, expectedCalls) => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-flow-"));
    const managed = path.join(outer, ".worktrees", "vibepro", "story-safe-change-abc123");
    await mkdir(managed, { recursive: true });
    const noProgress = () => JSON.stringify({ state: { status: "blocked", stop_reason: {
      code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${managed} --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } },
    } } });
    const runCommandFn = vi.fn(async () => resumedStatus === "pr_ready"
      ? JSON.stringify({ state: { status: "pr_ready" } })
      : noProgress());

    try {
      const result = await runVibeproUntilSafeStop(noProgress(), {
        storyId: "story-safe-change",
        outerWorktree: outer,
        vibeproBin: "/usr/local/bin/vibepro",
        deadlineMs: Date.now() + 60_000,
        runCommandFn,
      });
      expect(result.status).toBe(expectedStatus);
      expect(runCommandFn).toHaveBeenCalledTimes(expectedCalls);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid recovery", Date.now() + 60_000],
    ["exhausted budget", Date.now() - 1],
  ])("keeps a safe final stop without spawning for %s", async (caseName, deadlineMs) => {
    const outer = await mkdtemp(path.join(tmpdir(), "openryoko-resume-flow-"));
    const runCommandFn = vi.fn();
    const raw = caseName === "invalid recovery"
      ? JSON.stringify({ state: { status: "blocked", stop_reason: { code: "no_progress" } } })
      : JSON.stringify({ state: { status: "blocked", stop_reason: { code: "no_progress", details: { recovery: {
        next_command: `vibepro execute resume ${outer}/.worktrees/vibepro/story-safe-change-abc123 --story-id story-safe-change --run-id run-20260727T003335Z-373e6b15 --until pr-ready`,
      } } } } });
    if (caseName === "exhausted budget") {
      await mkdir(path.join(outer, ".worktrees", "vibepro", "story-safe-change-abc123"), { recursive: true });
    }

    try {
      expect((await runVibeproUntilSafeStop(raw, {
        storyId: "story-safe-change",
        outerWorktree: outer,
        vibeproBin: "/usr/local/bin/vibepro",
        deadlineMs,
        runCommandFn,
      })).status).toBe("needs_input");
      expect(runCommandFn).not.toHaveBeenCalled();
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("fails closed when the installed runner version differs from root-owned config", () => {
    const baseConfig = {
      repository: "/srv/openryoko-development/repository",
      worktreesRoot: "/srv/openryoko-development/worktrees",
      vibeproBin: "/usr/local/bin/vibepro",
      baseRef: "origin/main",
      maxDurationMs: 60_000,
    };

    expect(() => validateConfig({ ...baseConfig, runnerVersion: "stale" })).toThrow("runner version mismatch");
    expect(() => validateConfig({ ...baseConfig, runnerVersion: RUNNER_VERSION })).not.toThrow();
  });
  it("passes the request over stdin and strips the gateway environment", async () => {
    process.env.SLACK_BOT_TOKEN = "must-not-leak";
    let options: any;
    let stdin = "";
    const spawnFn = vi.fn((_bin, _args, receivedOptions) => {
      options = receivedOptions;
      const child = childReturning('{"status":"pr_ready","storyId":"story-safe-change","prUrl":"https://github.com/Unson-LLC/brainbase-mana/pull/3","summary":"ready"}');
      child.stdin.on("data", (chunk: Buffer) => { stdin += chunk.toString(); });
      return child;
    }) as any;

    const result = await runDevelopmentRequest(
      { enabled: true, bin: "/usr/bin/sudo", args: ["-n", "-u", "ryoko-dev", "/opt/bin/run"] },
      "READMEを改善する",
      spawnFn,
    );

    expect(result.status).toBe("pr_ready");
    expect(JSON.parse(stdin)).toEqual({ request: "READMEを改善する" });
    expect(options.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(options.env).toEqual(expect.objectContaining({ PATH: expect.any(String), LANG: expect.any(String) }));
  });

  it("rejects arbitrary URLs and extra output fields", () => {
    expect(() => parseDevelopmentResult('{"status":"pr_ready","prUrl":"https://evil.example/pr/1","summary":"x"}')).toThrow("invalid PR URL");
    expect(() => parseDevelopmentResult('{"status":"failed","summary":"x","secret":"value"}')).toThrow("unsupported field");
  });

  it.each([
    '{"status":"failed","summary":"truncated"',
    '{"status":"failed","summary":"one"}\n{"status":"failed","summary":"two"}',
  ])("rejects malformed or multiple JSON results with a stable safe error", (raw) => {
    expect(() => parseDevelopmentResult(raw)).toThrow("development runner returned malformed JSON");
  });

  it.each([
    ["truncated", '{"status":"failed","summary":"truncated"'],
    ["multiple", '{"status":"failed","summary":"one"}\n{"status":"failed","summary":"two"}'],
  ])("fails closed for %s JSON emitted as real child-process bytes", async (_caseName, raw) => {
    await expect(runDevelopmentRequest(
      {
        enabled: true,
        bin: process.execPath,
        args: ["-e", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(raw)}))`],
      },
      "READMEを改善する",
    )).rejects.toThrow("development runner returned malformed JSON");
  });

  it("enforces status-dependent result fields", () => {
    expect(() => parseDevelopmentResult('{"status":"pr_ready","summary":"x"}')).toThrow("without a story id");
    expect(() => parseDevelopmentResult('{"status":"queued","storyId":"story-x","prUrl":"https://github.com/Unson-LLC/brainbase-mana/pull/3","summary":"x"}')).toThrow("PR URL for queued");
    expect(parseDevelopmentResult('{"status":"failed","summary":"stopped"}')).toEqual({
      status: "failed",
      summary: "stopped",
    });
  });

  it("waits for process close after timing out", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const promise = runDevelopmentRequest(
        { enabled: true, bin: "/usr/bin/sudo", timeoutMs: 10 },
        "x",
        vi.fn(() => child) as any,
      );
      let settled = false;
      void promise.catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(settled).toBe(false);

      child.emit("close", null);
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the request pending until a timed-out process group is gone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openryoko-development-timeout-"));
    const descendantPidPath = path.join(directory, "descendant.pid");
    const script = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      "const descendant=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:'ignore'})",
      `writeFileSync(${JSON.stringify(descendantPidPath)},String(descendant.pid))`,
      "process.on('SIGTERM',()=>process.exit(0))",
      "process.stdin.resume()",
      "setInterval(()=>{},1000)",
    ].join(";");

    try {
      const request = runDevelopmentRequest({
        enabled: true,
        bin: process.execPath,
        args: ["-e", script],
        timeoutMs: 1_000,
      }, "x");
      const rejection = expect(request).rejects.toThrow("timed out");

      let descendantPid: number | undefined;
      const readyDeadline = Date.now() + 750;
      while (descendantPid === undefined && Date.now() < readyDeadline) {
        try {
          descendantPid = Number(await readFile(descendantPidPath, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(descendantPid).toEqual(expect.any(Number));
      if (descendantPid === undefined) throw new Error("descendant did not become ready before timeout");

      await rejection;
      expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("requires an absolute executable path", async () => {
    await expect(runDevelopmentRequest({ enabled: true, bin: "sudo" }, "x")).rejects.toThrow("must be absolute");
  });

  it("rejects oversized requests before spawning", async () => {
    const spawnFn = vi.fn() as any;
    await expect(runDevelopmentRequest({ enabled: true, bin: "/usr/bin/sudo" }, "x".repeat(8001), spawnFn))
      .rejects.toThrow("too large");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("waits for an oversized runner subprocess to close", async () => {
    const promise = runCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(1024)); setInterval(()=>{},1000)",
    ], { maxOutputBytes: 16, terminationGraceMs: 10 });

    await expect(promise).rejects.toThrow("command output exceeded limit");
  });

  it("terminates a command when its wall-clock budget expires", async () => {
    await expect(runCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)",
    ], { timeoutMs: 10, terminationGraceMs: 10 })).rejects.toThrow("command timed out");
  });

  it("escalates the process group after its leader exits", async () => {
    const promise = runCommand(process.execPath, [
      "-e",
      [
        "const {spawn}=require('node:child_process')",
        "spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:'ignore'})",
        "process.stdout.write('x'.repeat(1024))",
        "process.on('SIGTERM',()=>process.exit(0))",
        "setInterval(()=>{},1000)",
      ].join(";"),
    ], { maxOutputBytes: 16, terminationGraceMs: 25 });

    await expect(promise).rejects.toThrow("command output exceeded limit");
  });

  it("keeps the durable lock exclusive across runner processes and releases it for a restarted process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openryoko-development-lock-"));
    const lockPath = path.join(directory, "runner.lock");
    const runnerUrl = pathToFileURL(path.resolve("../..", "scripts/development-runner/run.mjs")).href;
    const script = [
      `import { acquireDevelopmentLock } from ${JSON.stringify(runnerUrl)}`,
      `let release`,
      `try { release = await acquireDevelopmentLock(${JSON.stringify(lockPath)}) } catch (error) { process.stderr.write(error.message); process.exit(23) }`,
      `process.stdout.write("acquired\\n")`,
      `process.stdin.resume()`,
      `process.stdin.on("end", async () => { await release(); process.exit(0) })`,
    ].join(";");

    const start = () => spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const waitForExit = (child: ReturnType<typeof start>) => new Promise<number | null>((resolveExit) => {
      child.once("close", resolveExit);
    });
    const collectExit = (child: ReturnType<typeof start>) => new Promise<{ code: number | null; stderr: string }>((resolveExit) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("close", (code) => resolveExit({ code, stderr }));
    });
    const waitForAcquired = (child: ReturnType<typeof start>) => new Promise<void>((resolveAcquired, rejectAcquired) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes("acquired\n")) resolveAcquired();
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("close", (code) => rejectAcquired(new Error(`lock process exited ${code}: ${stderr}`)));
    });

    try {
      const first = start();
      await waitForAcquired(first);

      const contender = start();
      expect(await collectExit(contender)).toEqual({
        code: 23,
        stderr: "another development task is already running",
      });

      first.stdin.end();
      expect(await waitForExit(first)).toBe(0);

      const restarted = start();
      await waitForAcquired(restarted);
      restarted.stdin.end();
      expect(await waitForExit(restarted)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
