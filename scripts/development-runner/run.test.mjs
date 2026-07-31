// Unit tests for the isolated development runner's result-spool delivery
// (scripts/development-runner/run.mjs). Uses Node's built-in test runner —
// this script has no build step and is deployed standalone, so it stays
// outside the pnpm/turbo/vitest pipeline like the rest of scripts/.
//
// Run with: node --test scripts/development-runner/run.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSpoolPayload,
  cleanOldSpools,
  validateConfig,
  writeResultSpool,
} from "./run.mjs";

const BASE_CONFIG = {
  repository: "/srv/openryoko-development/repository",
  worktreesRoot: "/srv/openryoko-development/worktrees",
  vibeproBin: "/usr/local/bin/vibepro",
  claudeBin: "/usr/local/bin/claude",
  baseRef: "origin/main",
  maxDurationMs: 300000,
  runnerVersion: "2026-07-31.5",
};

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "openryoko-runner-test-"));
}

test("buildSpoolPayload adds finishedAt and runnerPid without mutating the input", () => {
  const result = { status: "pr_ready", storyId: "story-abc", summary: "ok" };
  const payload = buildSpoolPayload(result);
  assert.equal(payload.status, "pr_ready");
  assert.equal(payload.storyId, "story-abc");
  assert.equal(payload.runnerPid, process.pid);
  assert.match(payload.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.finishedAt, undefined, "the original result must not be mutated");
});

test("writeResultSpool writes an atomically-renamed file with the story id as filename", async () => {
  const dir = await tmpDir();
  try {
    const result = { status: "needs_input", storyId: "story-xyz", summary: "gates remain" };
    await writeResultSpool(dir, result);
    const target = path.join(dir, "story-xyz.json");
    const info = await stat(target);
    assert.equal(info.mode & 0o777, 0o644);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    assert.equal(parsed.status, "needs_input");
    assert.equal(parsed.storyId, "story-xyz");
    assert.equal(typeof parsed.finishedAt, "string");
    assert.equal(parsed.runnerPid, process.pid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeResultSpool creates the spool directory when missing", async () => {
  const parent = await tmpDir();
  try {
    const nested = path.join(parent, "nested", "results");
    await writeResultSpool(nested, { status: "pr_ready", storyId: "story-nested", summary: "ok" });
    const parsed = JSON.parse(await readFile(path.join(nested, "story-nested.json"), "utf8"));
    assert.equal(parsed.storyId, "story-nested");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("writeResultSpool is a no-op without a storyId (early failures spool nothing)", async () => {
  const dir = await tmpDir();
  try {
    await writeResultSpool(dir, { status: "failed", summary: "boom" });
    const entries = await readFile(dir, "utf8").catch(() => null);
    // Directory should still be readable but contain no spool file.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeResultSpool is a no-op without a configured spool dir", async () => {
  // Must not throw even though there is nowhere to write.
  await writeResultSpool(undefined, { status: "pr_ready", storyId: "story-abc", summary: "ok" });
});

test("writeResultSpool fails silent when the target path cannot be created", async () => {
  // A regular file used as the "directory" makes mkdir(recursive) fail.
  const dir = await tmpDir();
  const blocker = path.join(dir, "blocker");
  await writeFile(blocker, "not a directory");
  try {
    // Should not throw.
    await writeResultSpool(path.join(blocker, "results"), {
      status: "pr_ready",
      storyId: "story-blocked",
      summary: "ok",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanOldSpools removes files older than maxAgeMs and keeps newer ones", async () => {
  const dir = await tmpDir();
  try {
    const oldFile = path.join(dir, "story-old.json");
    const freshFile = path.join(dir, "story-fresh.json");
    await writeFile(oldFile, "{}");
    await writeFile(freshFile, "{}");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, eightDaysAgo, eightDaysAgo);

    await cleanOldSpools(dir);

    await assert.rejects(stat(oldFile));
    await stat(freshFile); // still present
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanOldSpools ignores non-.json entries and a missing directory", async () => {
  const dir = await tmpDir();
  try {
    const noise = path.join(dir, "not-a-result.txt");
    await writeFile(noise, "noise");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(noise, eightDaysAgo, eightDaysAgo);
    await cleanOldSpools(dir);
    await stat(noise); // untouched

    // Missing directory must not throw.
    await cleanOldSpools(path.join(dir, "does-not-exist"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanOldSpools is a no-op without a configured spool dir", async () => {
  await cleanOldSpools(undefined);
});

test("validateConfig accepts an absolute resultsSpoolDir", () => {
  assert.doesNotThrow(() =>
    validateConfig({ ...BASE_CONFIG, resultsSpoolDir: "/srv/openryoko-development/results" }),
  );
});

test("validateConfig accepts a config without resultsSpoolDir (back-compat)", () => {
  assert.doesNotThrow(() => validateConfig({ ...BASE_CONFIG }));
});

test("validateConfig rejects a relative resultsSpoolDir", () => {
  assert.throws(
    () => validateConfig({ ...BASE_CONFIG, resultsSpoolDir: "relative/results" }),
    /invalid resultsSpoolDir/,
  );
});

test("validateConfig rejects a non-string resultsSpoolDir", () => {
  assert.throws(
    () => validateConfig({ ...BASE_CONFIG, resultsSpoolDir: 42 }),
    /invalid resultsSpoolDir/,
  );
});
