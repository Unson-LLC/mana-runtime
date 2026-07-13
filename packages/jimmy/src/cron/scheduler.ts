import cron from "node-cron";
import type {
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { loadJobs, saveJobs } from "./jobs.js";

/** Max random delay applied to each scheduled cron fire to de-synchronize the
 *  herd of jobs that share a schedule (e.g. every-15-min jobs all firing at :00). */
const CRON_JITTER_MS = 20 * 1000;

let tasks: cron.ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
}

export function reloadScheduler(jobs: CronJob[]): void {
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        // Jitter the fire by 0–CRON_JITTER_MS to spread the :00/:15/:30/:45
        // thundering herd (multiple jobs spawning `claude` in the same instant).
        // Reduces load spikes and lock contention on shared resources; the OAuth
        // refresh race is fixed separately by the spawn gate, this is defence in
        // depth. Manual triggers (triggerCronJob) bypass the jitter intentionally.
        const jitter = Math.floor(Math.random() * CRON_JITTER_MS);
        setTimeout(() => {
          runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
        }, jitter);
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  await runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
  return job;
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
