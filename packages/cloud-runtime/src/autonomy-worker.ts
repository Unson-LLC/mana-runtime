import worker from "./index.js";
import {
  runAutonomyScheduledEntrypoint,
  type AutonomyEntrypointEnv,
} from "./autonomy-entrypoint.js";

export * from "./index.js";

export interface AutonomyWorkerEnv extends AutonomyEntrypointEnv {
  MANA_AUTONOMY_CRON?: string;
}

type FetchParameters = Parameters<typeof worker.fetch>;
type QueueParameters = Parameters<typeof worker.queue>;
type ScheduledController = Parameters<typeof worker.scheduled>[0];
type WorkerEnv = Parameters<typeof worker.scheduled>[1] & AutonomyWorkerEnv;

function autonomyCron(env: AutonomyWorkerEnv): string | undefined {
  const value = env.MANA_AUTONOMY_CRON?.trim();
  if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

export default {
  fetch(
    request: FetchParameters[0],
    env: FetchParameters[1] & AutonomyWorkerEnv,
    context: FetchParameters[2],
  ) {
    return worker.fetch(request, env, context);
  },
  queue(
    batch: QueueParameters[0],
    env: QueueParameters[1] & AutonomyWorkerEnv,
  ) {
    return worker.queue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await worker.scheduled(controller, env);
    const expectedCron = autonomyCron(env);
    if (!expectedCron || controller.cron !== expectedCron) return;
    try {
      const outcome = await runAutonomyScheduledEntrypoint(env);
      console.log(JSON.stringify({
        event: "mana_autonomy_scheduled",
        outcome,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }));
    } catch {
      console.error(JSON.stringify({
        event: "mana_autonomy_scheduled",
        outcome: "failed",
        code: "autonomy_scheduled_failed",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }));
      throw new Error("autonomy_scheduled_failed");
    }
  },
};
