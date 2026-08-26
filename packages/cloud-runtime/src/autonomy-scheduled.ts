import { parseAutonomyExperiment } from "./autonomy-experiment.js";
import { issueAutonomyTaskWriteCapability } from "./autonomy-task-write.js";

export interface AutonomyScheduledEnv {
  MANA_AUTONOMY_EXPERIMENT_JSON?: string;
  MANA_AUTONOMY_DISABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
}

export interface AutonomyScheduledRuntimeConfig {
  placementId: string;
  perRunBudget?: number;
}

export interface AutonomyScheduledRun {
  runId: string;
  actorId: string;
  project: string;
  taskWriteCapability: string;
  experimentId: string;
  experimentExpiresAt: number;
}

export async function runScheduledAutonomy(input: {
  env: AutonomyScheduledEnv;
  config: AutonomyScheduledRuntimeConfig;
  now?: number;
  run: (input: AutonomyScheduledRun) => Promise<void>;
}): Promise<"inactive" | "disabled" | "ran"> {
  const now = input.now ?? Date.now();
  const experiment = parseAutonomyExperiment(
    input.env.MANA_AUTONOMY_EXPERIMENT_JSON,
    input.env.MANA_AUTONOMY_DISABLED,
    now,
  );
  if (!experiment) return "inactive";
  if (experiment.disabled) return "disabled";
  const secret = input.env.TASK_WRITE_CAPABILITY_SECRET;
  const workspaceId = input.env.SLACK_EXPECTED_TEAM_ID;
  if (!secret || !workspaceId || !input.config.placementId) {
    throw new Error("autonomy_runtime_not_configured");
  }

  const runId = `${experiment.id}:${new Date(now).toISOString()}`;
  const taskWriteCapability = await issueAutonomyTaskWriteCapability({
    runId,
    secret,
    now,
    config: {
      actorId: experiment.actorId,
      workspaceId,
      placementId: input.config.placementId,
      project: experiment.project,
      experimentExpiresAt: experiment.expiresAt,
      perRunBudget: input.config.perRunBudget ?? 2,
    },
  });

  await input.run({
    runId,
    actorId: experiment.actorId,
    project: experiment.project,
    taskWriteCapability,
    experimentId: experiment.id,
    experimentExpiresAt: experiment.expiresAt,
  });
  return "ran";
}
