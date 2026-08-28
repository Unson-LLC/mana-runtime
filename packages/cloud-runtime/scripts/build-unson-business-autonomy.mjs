#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertAutonomyDeploymentDisabled,
  renderAutonomyWorkerConfig,
} from "./autonomy-worker-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_CONFIG = path.join(ROOT, "wrangler.unson-business.jsonc");
const GENERATED_CONFIG = path.join(ROOT, `.wrangler.unson-business.autonomy.${process.pid}.jsonc`);
const OUTDIR = path.join(ROOT, ".wrangler", "autonomy-dry-run");

async function main() {
  const source = await readFile(SOURCE_CONFIG, "utf8");
  assertAutonomyDeploymentDisabled(source);
  const rendered = renderAutonomyWorkerConfig(source);
  await mkdir(OUTDIR, { recursive: true });
  await writeFile(GENERATED_CONFIG, rendered, { encoding: "utf8", mode: 0o600 });
  try {
    const result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--config", GENERATED_CONFIG, "--dry-run", "--outdir", OUTDIR],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    if (result.error || result.status !== 0) {
      throw new Error("autonomy_worker_dry_run_failed");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "dry-run",
      source_config: path.basename(SOURCE_CONFIG),
      entrypoint: "src/autonomy-worker.ts",
      outdir: path.relative(ROOT, OUTDIR),
      persisted: false,
    })}\n`);
  } finally {
    await rm(GENERATED_CONFIG, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "autonomy_worker_dry_run_failed"}\n`);
  process.exitCode = 1;
});
