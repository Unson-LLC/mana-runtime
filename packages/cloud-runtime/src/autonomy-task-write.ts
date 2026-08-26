import { signTaskWriteCapability } from "@openryoko/write-broker";

export interface AutonomyTaskWriteConfig {
  actorId: string;
  workspaceId: string;
  placementId: string;
  project: string;
  experimentExpiresAt: number;
  perRunBudget?: number;
}

export async function issueAutonomyTaskWriteCapability(input: {
  runId: string;
  config: AutonomyTaskWriteConfig;
  secret: string;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Date.now();
  const budget = input.config.perRunBudget ?? 2;
  if (!input.runId || input.runId.length > 128
    || !input.config.actorId || input.config.actorId.length > 128
    || !input.config.workspaceId || input.config.workspaceId.length > 128
    || !input.config.placementId || input.config.placementId.length > 128
    || !input.config.project || input.config.project.length > 128
    || !Number.isInteger(budget) || budget < 1 || budget > 3
    || !Number.isFinite(input.config.experimentExpiresAt)
    || input.config.experimentExpiresAt <= now) {
    throw new Error("autonomy_task_write_not_configured");
  }

  return signTaskWriteCapability({
    version: 1,
    audience: "mana-task-write",
    requestId: input.runId,
    actor: { provider: "service", id: input.config.actorId, workspace: input.config.workspaceId },
    placementId: input.config.placementId,
    projects: [input.config.project],
    operations: ["task.create", "task.update", "task.transition"],
    expiresAt: Math.min(now + 180_000, input.config.experimentExpiresAt),
    nonce: input.runId,
    budget,
  }, input.secret);
}