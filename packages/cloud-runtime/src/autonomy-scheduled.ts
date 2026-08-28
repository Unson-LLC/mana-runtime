import {
  claimAutonomyRun,
  completeAutonomyRun,
  failAutonomyRun,
  readAutonomyRunProjection,
  type AutonomyRunEvidence,
  type AutonomyRunHistoryNamespace,
  type AutonomyRunProjection,
} from "./autonomy-run-history.js";
import { parseAutonomyExperiment } from "./autonomy-experiment.js";
import { issueAutonomyTaskWriteCapability } from "./autonomy-task-write.js";

export interface AutonomyScheduledEnv {
  MANA_AUTONOMY_EXPERIMENT_JSON?: string;
  MANA_AUTONOMY_DISABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
  TASK_WRITE_BUDGETS?: AutonomyRunHistoryNamespace;
}

export interface AutonomyScheduledRuntimeConfig {
  placementId: string;
  perRunBudget?: number;
}

export interface AutonomyCanonicalStateRequest {
  runId: string;
  actorId: string;
  project: string;
  experimentId: string;
}

export interface AutonomyScheduledRun<TCanonicalState = unknown> {
  runId: string;
  actorId: string;
  project: string;
  taskWriteCapability: string;
  experimentId: string;
  experimentExpiresAt: number;
  historicalContext: AutonomyRunProjection;
  canonicalState: TCanonicalState;
}

export interface AutonomyScheduledRunResult {
  outcomeCode?: string;
  evidence?: AutonomyRunEvidence[];
}

export async function runScheduledAutonomy<TCanonicalState>(input: {
  env: AutonomyScheduledEnv;
  config: AutonomyScheduledRuntimeConfig;
  now?: number;
  readCanonicalState: (input: AutonomyCanonicalStateRequest) => Promise<TCanonicalState>;
  run: (
    input: AutonomyScheduledRun<TCanonicalState>,
  ) => Promise<AutonomyScheduledRunResult | void>;
}): Promise<"inactive" | "disabled" | "busy" | "replayed" | "ran"> {
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
  const history = input.env.TASK_WRITE_BUDGETS;
  if (!secret || !workspaceId || !history || !input.config.placementId) {
    throw new Error("autonomy_runtime_not_configured");
  }

  const runId = `${experiment.id}:${new Date(now).toISOString()}`;
  const disposition = await claimAutonomyRun(history, {
    runId,
    experimentId: experiment.id,
    actorId: experiment.actorId,
    project: experiment.project,
    startedAt: now,
    experimentExpiresAt: experiment.expiresAt,
  });
  if (disposition === "busy") return "busy";
  if (disposition === "replay") return "replayed";

  try {
    const historicalContext = await readAutonomyRunProjection(history, experiment.id);
    const canonicalState = await input.readCanonicalState({
      runId,
      actorId: experiment.actorId,
      project: experiment.project,
      experimentId: experiment.id,
    });
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

    const result = await input.run({
      runId,
      actorId: experiment.actorId,
      project: experiment.project,
      taskWriteCapability,
      experimentId: experiment.id,
      experimentExpiresAt: experiment.expiresAt,
      historicalContext,
      canonicalState,
    });

    await completeAutonomyRun(history, experiment.id, {
      runId,
      completedAt: now,
      outcomeCode: result?.outcomeCode,
      evidence: result?.evidence,
    });
    return "ran";
  } catch (cause) {
    await failAutonomyRun(history, experiment.id, {
      runId,
      completedAt: now,
      errorCode: "autonomy_run_failed",
    }).catch(() => undefined);
    throw cause;
  }
}
