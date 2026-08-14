import { signTaskWriteCapability } from "@openryoko/write-broker";
import { parseRuntimePlacements, parseRuntimeProjectCodes } from "./runtime-config.js";
import {
  refreshTaskBoard,
  type TaskBoardEnv,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import type { SlackQueueEvent } from "./types.js";

interface TaskWriteRuntimeEnv {
  RUNTIME_TASK_WRITE_ENABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  RUNTIME_PLACEMENT_ID?: string;
  RUNTIME_PROJECT_CODES?: string;
}

interface TaskWritePlacement {
  placementId: string;
  projectCodes: string[];
  taskWriteEnabled: boolean;
}

interface TaskBoardRuntimeEnv extends TaskBoardEnv {
  TENANT_ID: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  TASK_BOARD_REPAIRS: { send(message: TaskBoardRepairEvent): Promise<unknown> };
  RUNTIME_PLACEMENTS_JSON?: string;
}

interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export async function issueTaskWriteRequestContext(
  event: SlackQueueEvent,
  env: TaskWriteRuntimeEnv,
  now = Date.now(),
  placement?: TaskWritePlacement,
  requesterPersonId?: string,
): Promise<{ taskWriteEnabled: boolean; taskWriteCapability?: string }> {
  if (env.RUNTIME_TASK_WRITE_ENABLED !== "true" || placement?.taskWriteEnabled === false) return { taskWriteEnabled: false };
  const projects = placement?.projectCodes ?? parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES);
  const placementId = placement?.placementId ?? env.RUNTIME_PLACEMENT_ID;
  if (!env.TASK_WRITE_CAPABILITY_SECRET || !placementId || projects.length === 0 || !event.userId) {
    throw new Error("task_write_not_configured");
  }
  return {
    taskWriteEnabled: true,
    taskWriteCapability: await signTaskWriteCapability({
      version: 1,
      audience: "mana-task-write",
      requestId: event.eventId,
      actor: { provider: "slack", id: event.userId, workspace: event.workspaceId,
        ...(requesterPersonId ? { personId: requesterPersonId } : {}) },
      placementId,
      projects,
      operations: ["task.create", "task.update", "task.transition"],
      expiresAt: now + 180_000,
      nonce: event.eventId,
      budget: 3,
    }, env.TASK_WRITE_CAPABILITY_SECRET),
  };
}

export async function consumeTaskBoardRepair(
  message: QueueMessageLike<TaskBoardRepairEvent>,
  env: TaskBoardRuntimeEnv,
  refresh: (bindings: TaskBoardEnv) => Promise<unknown> = refreshTaskBoard,
): Promise<void> {
  const repair = message.body;
  const placement = env.RUNTIME_PLACEMENTS_JSON
    ? parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON).find((candidate) => candidate.channelId === repair.channelId && candidate.taskBoardEnabled)
    : undefined;
  if (
    repair.tenantId !== env.TENANT_ID ||
    repair.workspaceId !== env.SLACK_EXPECTED_TEAM_ID ||
    (env.RUNTIME_PLACEMENTS_JSON ? !placement : repair.channelId !== env.SLACK_ALLOWED_CHANNEL_ID)
  ) {
    console.error(JSON.stringify({ event: "task_board_repair_rejected", reason: "scope_mismatch" }));
    message.ack();
    return;
  }
  try {
    await refresh(placement ? { ...env,
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_ALLOWED_CHANNEL_ID: placement.channelId,
      RUNTIME_PROJECT_CODES: placement.projectCodes.join(",") } : env);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({ event: "task_board_repair_failed", code: error instanceof Error ? error.message : "unknown" }));
    message.retry();
  }
}

export async function enqueueScheduledTaskBoardRepair(
  env: TaskBoardRuntimeEnv,
  now = new Date().toISOString(),
): Promise<void> {
  const placements = env.RUNTIME_PLACEMENTS_JSON
    ? parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON).filter((placement) => placement.taskBoardEnabled)
    : env.RUNTIME_TASK_BOARD_ENABLED === "true"
      ? [{ channelId: env.SLACK_ALLOWED_CHANNEL_ID }]
      : [];
  for (const placement of placements) {
    await env.TASK_BOARD_REPAIRS.send({
      eventType: "task_board_repair",
      tenantId: env.TENANT_ID,
      workspaceId: env.SLACK_EXPECTED_TEAM_ID,
      channelId: placement.channelId,
      reason: "scheduled",
      requestedAt: now,
    });
  }
}
