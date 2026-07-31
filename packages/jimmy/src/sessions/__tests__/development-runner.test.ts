import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDevelopmentResult, parseProgressLine, runDevelopmentRequest } from "../development-runner.js";
// The production runner is intentionally plain ESM so it can be installed as a standalone script.
// @ts-expect-error no TypeScript declaration is shipped for the standalone runner.
import { RUNNER_VERSION, acquireDevelopmentLock, assessLockStaleness, buildAgentArgs, buildAgentPrompt, buildResumeAgentPrompt, buildAnswersAddArgs, buildAnswersCommitArgs, buildHumanAnswersSection, buildPrShipArgs, buildProgressLine, buildStoryAddArgs, buildStoryCommitArgs, ensureGitignoreEntry, extractBlockingGates, parseEnvFile, parsePrShipReadiness, readQuestionsFile, readStdin, resultFromAgentRun, resultFromQuestions, runCommand, validateConfig, validateQuestionsDocument } from "../../../../../scripts/development-runner/run.mjs";

const RUNNER_URL = pathToFileURL(path.resolve("../..", "scripts/development-runner/run.mjs")).href;

/** Drives the standalone runner's readStdin() in a real child process (it reads the live process.stdin global). */
async function callReadStdin(input: string): Promise<{ ok: true; payload: any } | { ok: false; message: string }> {
  const script = [
    `import { readStdin } from ${JSON.stringify(RUNNER_URL)};`,
    `try { const payload = await readStdin(); process.stdout.write(JSON.stringify(payload)) }`,
    `catch (error) { process.stderr.write(error.message); process.exitCode = 1 }`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(input);
  const code: number | null = await new Promise((resolveExit) => child.once("close", resolveExit));
  if (code === 0) return { ok: true, payload: JSON.parse(stdout) };
  return { ok: false, message: stderr };
}

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

  it("drives development through a Claude Code agent bounded by the VibePro safety boundary", () => {
    const prompt = buildAgentPrompt("story-safe-change", "READMEを改善する", "main");
    expect(prompt).toContain("READMEを改善する");
    expect(prompt).toContain("story-safe-change");
    expect(prompt).toContain("vibepro pr prepare . --story-id story-safe-change --base main");
    expect(prompt).toContain("PR作成・merge・push・deploy・secretsの変更・runtime本体checkoutの変更は行わない");
    expect(buildAgentArgs(prompt)).toEqual(["-p", "--dangerously-skip-permissions", prompt]);
  });

  it("re-derives readiness deterministically from pr ship instead of trusting the agent", () => {
    expect(buildPrShipArgs("story-safe-change", "codex/story-safe-change", "main")).toEqual([
      "pr", "ship", ".",
      "--base", "main", "--head", "codex/story-safe-change",
      "--story-id", "story-safe-change", "--dry-run",
    ]);
  });

  it("treats a pr create next command as the only pr_ready signal", () => {
    const ready = "## Blocking\n\n## Next Commands\n\n- vibepro pr create . --base main --head codex/story-x --story-id story-x\n";
    const notReady = [
      "- critical_gate: 必須設計図が不足: threat_model",
      "- waiver_or_evidence: 10 non-critical unresolved gate(s) require evidence or an auditable waiver.",
      "## Next Commands",
      "- vibepro review prepare . --id story-x --stage gate --role gate_evidence",
      "- vibepro pr prepare . --story-id story-x --base main",
    ].join("\n");
    expect(parsePrShipReadiness(ready)).toBe(true);
    expect(parsePrShipReadiness(notReady)).toBe(false);
    expect(parsePrShipReadiness("")).toBe(false);

    expect(resultFromAgentRun(ready, "story-safe-change")).toEqual({
      status: "pr_ready",
      storyId: "story-safe-change",
      summary: "VibePro gates are ready. PR creation requires a human action.",
    });
    const stopped = resultFromAgentRun(notReady, "story-safe-change");
    expect(stopped.status).toBe("needs_input");
    expect(stopped.storyId).toBe("story-safe-change");
    expect(stopped.summary).toContain("2 gate(s) remain");
    expect(stopped.summary.length).toBeLessThanOrEqual(1000);
  });

  it("ignores a pr create mention outside the Next Commands section", () => {
    const output = "- vibepro pr create . --base main --head x --story-id story-x\n## Next Commands\n- vibepro pr prepare . --story-id story-x --base main\n";
    expect(parsePrShipReadiness(output)).toBe(false);
  });

  it("lists unresolved gates from the pr ship report", () => {
    expect(extractBlockingGates([
      "- critical_gate: Scope requires a split decision",
      "- other: noise",
      "- waiver_or_evidence: 3 unresolved gate(s)",
    ].join("\n"))).toEqual(["Scope requires a split decision", "3 unresolved gate(s)"]);
  });

  it("parses the agent environment file strictly", () => {
    expect(parseEnvFile('# key for the agent\nANTHROPIC_API_KEY="sk-test"\n\nCLAUDE_CODE_FLAG=1\n')).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_FLAG: "1",
    });
    expect(() => parseEnvFile("export FOO=bar\n")).toThrow("invalid agent environment line");
    expect(() => parseEnvFile("foo=bar\n")).toThrow("invalid agent environment line");
  });

  it("fails closed when the installed runner version differs from root-owned config", () => {
    const baseConfig = {
      repository: "/srv/openryoko-development/repository",
      worktreesRoot: "/srv/openryoko-development/worktrees",
      vibeproBin: "/usr/local/bin/vibepro",
      claudeBin: "/usr/local/bin/claude",
      baseRef: "origin/main",
      maxDurationMs: 60_000,
    };

    expect(() => validateConfig({ ...baseConfig, runnerVersion: "stale" })).toThrow("runner version mismatch");
    expect(() => validateConfig({ ...baseConfig, runnerVersion: RUNNER_VERSION })).not.toThrow();
    expect(() => validateConfig({ ...baseConfig, runnerVersion: RUNNER_VERSION, claudeBin: "claude" })).toThrow("invalid claudeBin");
    expect(() => validateConfig({ ...baseConfig, runnerVersion: RUNNER_VERSION, agentEnvFile: "relative.env" })).toThrow("invalid agentEnvFile");
    expect(() => validateConfig({ ...baseConfig, runnerVersion: RUNNER_VERSION, agentEnvFile: "/home/ryoko-dev/.config/openryoko/agent-environment" })).not.toThrow();
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

  it("parses a well-formed PROGRESS stderr line", () => {
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":1440,"commits":3,"latest":"fix: x"}')).toEqual({
      phase: "agent", elapsedSec: 1440, commits: 3, latest: "fix: x",
    });
    expect(parseProgressLine('PROGRESS {"phase":"gate","elapsedSec":900,"commits":5}')).toEqual({
      phase: "gate", elapsedSec: 900, commits: 5,
    });
  });

  it("ignores lines that are not PROGRESS-prefixed, malformed JSON, or schema-invalid", () => {
    expect(parseProgressLine("some other stderr diagnostic line")).toBeNull();
    expect(parseProgressLine("PROGRESS not json")).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":1,"commits":1,"extra":"x"}')).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"unknown","elapsedSec":1,"commits":1}')).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":-1,"commits":1}')).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":1.5,"commits":1}')).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":1,"commits":1001}')).toBeNull();
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":1,"commits":-1}')).toBeNull();
    expect(parseProgressLine(`PROGRESS {"phase":"agent","elapsedSec":1,"commits":1,"latest":"${"x".repeat(301)}"}`)).toBeNull();
    expect(parseProgressLine('PROGRESS []')).toBeNull();
    expect(parseProgressLine('PROGRESS null')).toBeNull();
  });

  /** Like childReturning, but lets the caller write stderr before stdout/close. */
  function childReturningAfterStderr(stdout: string, stderrLines: string[], code = 0) {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      for (const line of stderrLines) child.stderr.write(line);
      child.stderr.end();
      child.stdout.end(stdout);
      child.emit("close", code);
    });
    return child;
  }

  it("streams PROGRESS lines from the runner's stderr into onProgress in real time", async () => {
    const seen: unknown[] = [];
    const spawnFn = vi.fn(() => childReturningAfterStderr(
      '{"status":"pr_ready","storyId":"story-safe-change","summary":"ready"}',
      [
        'PROGRESS {"phase":"agent","elapsedSec":60,"commits":0}\n',
        "just a diagnostic line, not progress\n",
        'PROGRESS {"phase":"agent","elapsedSec":120,"commits":2,"latest":"fix: y"}\n',
      ],
    )) as any;

    const result = await runDevelopmentRequest(
      { enabled: true, bin: "/usr/bin/sudo" },
      "READMEを改善する",
      spawnFn,
      (progress) => seen.push(progress),
    );

    expect(result.status).toBe("pr_ready");
    expect(seen).toEqual([
      { phase: "agent", elapsedSec: 60, commits: 0 },
      { phase: "agent", elapsedSec: 120, commits: 2, latest: "fix: y" },
    ]);
  });

  it("ignores an oversized stderr stream instead of failing the run", async () => {
    const seen: unknown[] = [];
    const spawnFn = vi.fn(() => childReturningAfterStderr(
      '{"status":"pr_ready","storyId":"story-safe-change","summary":"ready"}',
      [
        // Exceed the 1MB stderr parse cap before any valid PROGRESS line arrives.
        `${"x".repeat(2 * 1024 * 1024)}\n`,
        'PROGRESS {"phase":"agent","elapsedSec":60,"commits":1}\n',
      ],
    )) as any;

    const result = await runDevelopmentRequest(
      { enabled: true, bin: "/usr/bin/sudo" },
      "READMEを改善する",
      spawnFn,
      (progress) => seen.push(progress),
    );

    expect(result.status).toBe("pr_ready");
    expect(seen).toEqual([]);
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
      const contenderExit = await collectExit(contender);
      expect(contenderExit.code).toBe(23);
      expect(contenderExit.stderr).toContain("another development task is already running");
      expect(contenderExit.stderr).toContain("is still alive");

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

describe("stale development lock reclamation", () => {
  const DEAD_PID = 99999999;

  async function makeStaleLock(ownerContent: string | null = `${DEAD_PID}\n`) {
    const directory = await mkdtemp(path.join(tmpdir(), "openryoko-stale-lock-"));
    const lockPath = path.join(directory, "runner.lock");
    await mkdir(lockPath);
    if (ownerContent !== null) await writeFile(path.join(lockPath, "owner"), ownerContent);
    return { directory, lockPath };
  }

  it("reclaims a lock whose owner is dead with no surviving development-user process", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      const release = await acquireDevelopmentLock(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => [process.pid],
      });
      expect((await readFile(path.join(lockPath, "owner"), "utf8")).trim()).toBe(String(process.pid));
      await release();
      await expect(readFile(path.join(lockPath, "owner"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed while the lock owner is alive", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive: () => true,
        listLiveUserPids: async () => [process.pid],
      })).rejects.toThrow(`another development task is already running (lock owner process ${DEAD_PID} is still alive)`);
      expect((await readFile(path.join(lockPath, "owner"), "utf8")).trim()).toBe(String(DEAD_PID));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the owner file is missing", async () => {
    const { directory, lockPath } = await makeStaleLock(null);
    try {
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => [],
      })).rejects.toThrow("lock owner file is missing or unreadable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the owner pid is malformed", async () => {
    const { directory, lockPath } = await makeStaleLock("not-a-pid\n");
    try {
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => [],
      })).rejects.toThrow("lock owner pid is malformed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when other development-user processes survive the dead owner", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => [process.pid, 4242],
      })).rejects.toThrow("1 process(es) still run as the development user");
      expect((await readFile(path.join(lockPath, "owner"), "utf8")).trim()).toBe(String(DEAD_PID));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when live processes cannot be enumerated", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => { throw new Error("no /proc"); },
      })).rejects.toThrow("cannot enumerate live processes for the development user");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores a lock that turns fresh between assessment and removal", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      // First assessment sees a dead owner; the re-assessment after the
      // atomic quarantine rename sees it alive (as if the pid was recycled or
      // the lock replaced). The lock must be given back untouched.
      const isPidAlive = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      await expect(acquireDevelopmentLock(lockPath, {
        isPidAlive,
        listLiveUserPids: async () => [process.pid],
      })).rejects.toThrow("another development task is already running");
      expect((await readFile(path.join(lockPath, "owner"), "utf8")).trim()).toBe(String(DEAD_PID));
      await expect(readFile(path.join(`${lockPath}.reclaim-${process.pid}`, "owner"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("assesses staleness without mutating the lock", async () => {
    const { directory, lockPath } = await makeStaleLock();
    try {
      const verdict = await assessLockStaleness(lockPath, {
        isPidAlive: () => false,
        listLiveUserPids: async () => [process.pid],
      });
      expect(verdict).toEqual({
        stale: true,
        reason: `lock owner process ${DEAD_PID} is dead and no other development-user process survives`,
      });
      expect((await readFile(path.join(lockPath, "owner"), "utf8")).trim()).toBe(String(DEAD_PID));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Human-in-the-Loop stdin contract", () => {
  it("accepts a new-request payload", async () => {
    const result = await callReadStdin(JSON.stringify({ request: "READMEを改善する" }));
    expect(result).toEqual({ ok: true, payload: { mode: "new", request: "READMEを改善する" } });
  });

  it("accepts a resume payload with storyId and answers", async () => {
    const result = await callReadStdin(JSON.stringify({
      storyId: "story-safe-change",
      answers: [{ id: "q1", answer: "option A" }],
    }));
    expect(result).toEqual({
      ok: true,
      payload: { mode: "resume", storyId: "story-safe-change", answers: [{ id: "q1", answer: "option A" }] },
    });
  });

  it("rejects a payload carrying both request and storyId/answers", async () => {
    const result = await callReadStdin(JSON.stringify({
      request: "x", storyId: "story-safe-change", answers: [{ id: "q1", answer: "a" }],
    }));
    expect(result).toEqual({ ok: false, message: "request and storyId/answers are mutually exclusive" });
  });

  it("rejects an unsupported field", async () => {
    const result = await callReadStdin(JSON.stringify({ request: "x", extra: "y" }));
    expect(result).toEqual({ ok: false, message: "unsupported request field" });
  });

  it("rejects an invalid storyId", async () => {
    const result = await callReadStdin(JSON.stringify({ storyId: "not-a-story", answers: [{ id: "q1", answer: "a" }] }));
    expect(result).toEqual({ ok: false, message: "invalid storyId" });
  });

  it("rejects zero or more than 10 answers", async () => {
    expect(await callReadStdin(JSON.stringify({ storyId: "story-x", answers: [] })))
      .toEqual({ ok: false, message: "answers must contain 1-10 entries" });
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, answer: "a" }));
    expect(await callReadStdin(JSON.stringify({ storyId: "story-x", answers: tooMany })))
      .toEqual({ ok: false, message: "answers must contain 1-10 entries" });
  });

  it("rejects an invalid answer id and an oversized answer", async () => {
    expect(await callReadStdin(JSON.stringify({ storyId: "story-x", answers: [{ id: "BAD ID", answer: "a" }] })))
      .toEqual({ ok: false, message: "invalid answer id" });
    expect(await callReadStdin(JSON.stringify({ storyId: "story-x", answers: [{ id: "q1", answer: "x".repeat(2001) }] })))
      .toEqual({ ok: false, message: "invalid answer text" });
  });

  it("rejects duplicate answer ids", async () => {
    const result = await callReadStdin(JSON.stringify({
      storyId: "story-x",
      answers: [{ id: "q1", answer: "a" }, { id: "q1", answer: "b" }],
    }));
    expect(result).toEqual({ ok: false, message: "duplicate answer id: q1" });
  });
});

describe("questions.json Human-in-the-Loop contract", () => {
  it("validates a well-formed questions document", () => {
    const doc = {
      questions: [
        {
          id: "auth_strategy",
          question: "認証はどちらにしますか？",
          options: [
            { label: "OAuth", description: "既存IdPを使う", recommended: true },
            { label: "独自実装" },
          ],
          allow_free_text: true,
        },
      ],
    };
    expect(validateQuestionsDocument(doc)).toEqual(doc);
  });

  it("normalizes an omitted options/allow_free_text into defaults", () => {
    expect(validateQuestionsDocument({ questions: [{ id: "q1", question: "続けますか？" }] })).toEqual({
      questions: [{ id: "q1", question: "続けますか？", options: [], allow_free_text: false }],
    });
  });

  it("rejects an unsupported top-level field", () => {
    expect(() => validateQuestionsDocument({ questions: [], extra: true }))
      .toThrow("unsupported field");
  });

  it("rejects zero or more than 5 questions", () => {
    expect(() => validateQuestionsDocument({ questions: [] })).toThrow("1-5 questions");
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: "x" }));
    expect(() => validateQuestionsDocument({ questions: many })).toThrow("1-5 questions");
  });

  it("rejects more than 5 options per question", () => {
    const options = Array.from({ length: 6 }, (_, i) => ({ label: `opt${i}` }));
    expect(() => validateQuestionsDocument({ questions: [{ id: "q1", question: "x", options }] }))
      .toThrow("at most 5 entries");
  });

  it("rejects an oversized question or option field", () => {
    expect(() => validateQuestionsDocument({ questions: [{ id: "q1", question: "x".repeat(301) }] }))
      .toThrow("invalid question text");
    expect(() => validateQuestionsDocument({
      questions: [{ id: "q1", question: "x", options: [{ label: "y".repeat(81) }] }],
    })).toThrow("invalid option label");
    expect(() => validateQuestionsDocument({
      questions: [{ id: "q1", question: "x", options: [{ label: "y", description: "z".repeat(201) }] }],
    })).toThrow("invalid option description");
  });

  it("rejects a duplicate question id and an invalid id shape", () => {
    expect(() => validateQuestionsDocument({
      questions: [{ id: "q1", question: "a" }, { id: "q1", question: "b" }],
    })).toThrow("duplicate question id: q1");
    expect(() => validateQuestionsDocument({ questions: [{ id: "BAD ID", question: "a" }] }))
      .toThrow("invalid question id");
  });

  it("reads and validates .openryoko/questions.json from a worktree", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openryoko-questions-"));
    try {
      expect(await readQuestionsFile(directory)).toBeNull();

      await mkdir(path.join(directory, ".openryoko"), { recursive: true });
      const doc = { questions: [{ id: "q1", question: "続けますか？", options: [], allow_free_text: true }] };
      await writeFile(path.join(directory, ".openryoko", "questions.json"), JSON.stringify(doc));
      expect(await readQuestionsFile(directory)).toEqual(doc);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on a malformed questions.json instead of silently ignoring it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openryoko-questions-bad-"));
    try {
      await mkdir(path.join(directory, ".openryoko"), { recursive: true });
      await writeFile(path.join(directory, ".openryoko", "questions.json"), JSON.stringify({ questions: [] }));
      await expect(readQuestionsFile(directory)).rejects.toThrow("1-5 questions");

      await writeFile(path.join(directory, ".openryoko", "questions.json"), "{not json");
      await expect(readQuestionsFile(directory)).rejects.toThrow("not valid JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits a needs_decision result shape from a validated questions document", () => {
    const doc = validateQuestionsDocument({ questions: [{ id: "q1", question: "続けますか？" }] });
    const result = resultFromQuestions("story-x", doc);
    expect(result.status).toBe("needs_decision");
    expect(result.storyId).toBe("story-x");
    expect(result.questions).toEqual(doc.questions);
    expect(result.summary).toContain("1 question(s)");
  });
});

describe(".gitignore and Story-doc helpers for the resume round-trip", () => {
  it("appends a missing .gitignore entry exactly once", () => {
    expect(ensureGitignoreEntry("", ".openryoko/")).toBe(".openryoko/\n");
    expect(ensureGitignoreEntry("node_modules/\n", ".openryoko/")).toBe("node_modules/\n.openryoko/\n");
    expect(ensureGitignoreEntry("node_modules/\n.openryoko/\n", ".openryoko/")).toBe("node_modules/\n.openryoko/\n");
  });

  it("renders the Human answers section appended to a Story doc", () => {
    const section = buildHumanAnswersSection([
      { id: "auth_strategy", answer: "OAuth / 既存IdPで進める" },
      { id: "q2", answer: "はい" },
    ]);
    expect(section).toBe(
      "\n## Human answers\n\n- auth_strategy: OAuth / 既存IdPで進める\n- q2: はい\n",
    );
  });

  it("records the human answers as a scoped, deterministic local commit", () => {
    expect(buildAnswersAddArgs("docs/management/stories/active/story-safe-change.md")).toEqual([
      "add", "-f", "--", "docs/management/stories/active/story-safe-change.md",
    ]);
    expect(buildAnswersCommitArgs("story-safe-change")).toEqual([
      "-c", "user.name=OpenRyoko Development Runner",
      "-c", "user.email=openryoko-runner@localhost",
      "commit", "-m", "chore: record story-safe-change human answers",
    ]);
  });

  it("builds a resume agent prompt bounded to the 1-round-trip rule", () => {
    const prompt = buildResumeAgentPrompt("story-safe-change", "main");
    expect(prompt).toContain("story-safe-change");
    expect(prompt).toContain("## Human answers");
    expect(prompt).toContain("再度質問はしない");
    expect(prompt).toContain("vibepro pr prepare . --story-id story-safe-change --base main");
  });

  it("tells the first-round agent prompt about the questions.json escape hatch", () => {
    const prompt = buildAgentPrompt("story-safe-change", "何かを実装して", "main");
    expect(prompt).toContain(".openryoko/questions.json");
    expect(prompt).toContain("最大5問");
  });
});

describe("PROGRESS stderr line for Slack typing status", () => {
  it("omits latest for the agent phase when there are zero commits", () => {
    const line = buildProgressLine("agent", 1440, 0, undefined);
    expect(line.startsWith("PROGRESS ")).toBe(true);
    expect(JSON.parse(line.slice("PROGRESS ".length))).toEqual({ phase: "agent", elapsedSec: 1440, commits: 0 });
  });

  it("includes latest for the agent phase once there is at least one commit", () => {
    const line = buildProgressLine("agent", 1440, 3, "fix(slack): show real progress");
    expect(JSON.parse(line.slice("PROGRESS ".length))).toEqual({
      phase: "agent",
      elapsedSec: 1440,
      commits: 3,
      latest: "fix(slack): show real progress",
    });
  });

  it("collapses newlines and cuts latest to 200 chars", () => {
    const messy = `first line\nsecond line\t\t${"x".repeat(250)}`;
    const parsed = JSON.parse(buildProgressLine("agent", 10, 1, messy).slice("PROGRESS ".length));
    expect(parsed.latest).not.toContain("\n");
    expect(parsed.latest.length).toBeLessThanOrEqual(200);
    expect(parsed.latest).toBe(messy.replace(/\s+/g, " ").trim().slice(0, 200));
  });

  it("never includes latest for the gate phase, even when one is passed", () => {
    const line = buildProgressLine("gate", 900, 5, "should not appear");
    expect(JSON.parse(line.slice("PROGRESS ".length))).toEqual({ phase: "gate", elapsedSec: 900, commits: 5 });
  });

  it("keeps latest omitted when commits is zero regardless of a stray latest value", () => {
    const line = buildProgressLine("agent", 5, 0, "stray value");
    expect(JSON.parse(line.slice("PROGRESS ".length))).toEqual({ phase: "agent", elapsedSec: 5, commits: 0 });
  });
});
