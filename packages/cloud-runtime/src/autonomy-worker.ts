import worker from "./index.js";
import {
  runAutonomyScheduledEntrypoint,
  type AutonomyEntrypointEnv,
} from "./autonomy-entrypoint.js";

export * from "./index.js";

type FetchParameters = Parameters<typeof worker.fetch>;
type QueueParameters = Parameters<typeof worker.queue>;
type ScheduledController = Parameters<typeof worker.scheduled>[0];
type WorkerEnv = Parameters<typeof worker.scheduled>[1] & AutonomyEntrypointEnv;

export default {
  fetch(
    request: FetchParameters[0],
    env: FetchParameters[1] & AutonomyEntrypointEnv,
    context: FetchParameters[2],
  ) {
    return worker.fetch(request, env, context);
  },
  queue(
    batch: QueueParameters[0],
    env: QueueParameters[1] & AutonomyEntrypointEnv,
  ) {
    return worker.queue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await worker.scheduled(controller, env);
    const outcome = await runAutonomyScheduledEntrypoint(env);
    console.log(JSON.stringify({
      event: "mana_autonomy_scheduled",
      outcome,
      scheduledTime: controller.scheduledTime,
    }));
  },
};
