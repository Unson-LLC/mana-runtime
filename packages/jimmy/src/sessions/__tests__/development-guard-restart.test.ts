import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const GUARD_PATH = path.resolve("../..", "scripts/development-runner/guard-restart.sh");
const DEAD_PID = 99999999;

interface GuardRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs guard-restart.sh with a temp lock path and a fake `pgrep` on PATH so
 * the "surviving development-user process" probe is deterministic in tests.
 */
async function runGuard(options: {
  lockOwner?: string | null;
  createLock?: boolean;
  pgrepExit: number;
  args?: string[];
  pollSeconds?: string;
}): Promise<GuardRun> {
  const directory = await mkdtemp(path.join(tmpdir(), "openryoko-guard-"));
  const lockPath = path.join(directory, "runner.lock");
  if (options.createLock ?? true) {
    await mkdir(lockPath);
    if (options.lockOwner !== null && options.lockOwner !== undefined) {
      await writeFile(path.join(lockPath, "owner"), options.lockOwner);
    }
  }
  const fakeBin = path.join(directory, "bin");
  await mkdir(fakeBin);
  const pgrepPath = path.join(fakeBin, "pgrep");
  await writeFile(pgrepPath, `#!/usr/bin/env bash\nexit ${options.pgrepExit}\n`);
  await chmod(pgrepPath, 0o755);

  try {
    return await new Promise<GuardRun>((resolve, reject) => {
      const child = spawn("bash", [GUARD_PATH, ...(options.args ?? [])], {
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          OPENRYOKO_DEV_LOCK: lockPath,
          OPENRYOKO_DEV_USER: "ryoko-dev",
          OPENRYOKO_GUARD_POLL_SECONDS: options.pollSeconds ?? "0.1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("guard-restart.sh", () => {
  it("allows the restart when no lock exists", async () => {
    const result = await runGuard({ createLock: false, pgrepExit: 0 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no development run is active");
  });

  it("blocks the restart while the lock owner is alive", async () => {
    const result = await runGuard({ lockOwner: `${process.pid}\n`, pgrepExit: 1 });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Do NOT restart openryoko now");
  });

  it("blocks the restart when the owner is dead but development-user processes survive", async () => {
    const result = await runGuard({ lockOwner: `${DEAD_PID}\n`, pgrepExit: 0 });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Do NOT restart openryoko now");
  });

  it("blocks fail-closed when the owner file is missing but processes survive", async () => {
    const result = await runGuard({ lockOwner: null, pgrepExit: 0 });
    expect(result.code).toBe(1);
  });

  it("allows the restart over a provably stale lock", async () => {
    const result = await runGuard({ lockOwner: `${DEAD_PID}\n`, pgrepExit: 1 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("stale lock");
    expect(result.stdout).toContain("Safe to restart openryoko");
  });

  it("waits for an active run to finish when --wait is given", async () => {
    // The owner is a real short-lived process; the guard polls until it exits.
    const sleeper = spawn("sleep", ["0.4"], { stdio: "ignore" });
    try {
      const result = await runGuard({
        lockOwner: `${sleeper.pid}\n`,
        pgrepExit: 1,
        args: ["--wait", "10"],
        pollSeconds: "0.1",
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("waiting for it to finish");
      expect(result.stdout).toContain("Safe to restart openryoko");
    } finally {
      sleeper.kill("SIGKILL");
    }
  }, 15000);

  it("rejects unknown arguments with a usage error", async () => {
    const result = await runGuard({ createLock: false, pgrepExit: 1, args: ["--bogus"] });
    expect(result.code).toBe(2);
  });
});
