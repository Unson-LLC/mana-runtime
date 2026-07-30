import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { recordConfigChange } from "../shared/config-history.js";

export function loadJobs(): CronJob[] {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    return JSON.parse(raw) as CronJob[];
  } catch {
    return [];
  }
}

export function saveJobs(
  jobs: CronJob[],
  meta?: { source?: string; operatorAuthenticated?: boolean },
): void {
  const dir = path.dirname(CRON_JOBS);
  fs.mkdirSync(dir, { recursive: true });
  recordConfigChange(CRON_JOBS, meta?.source ?? "cron", {
    ...(meta?.operatorAuthenticated !== undefined && { operatorAuthenticated: meta.operatorAuthenticated }),
  });
  fs.writeFileSync(CRON_JOBS, JSON.stringify(jobs, null, 2) + "\n", "utf-8");
}

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
