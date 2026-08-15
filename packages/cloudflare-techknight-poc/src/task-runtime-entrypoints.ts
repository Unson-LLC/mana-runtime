import { signTaskWriteCapability } from "@openryoko/write-broker";
import { parseRuntimePlacements, parseRuntimeProjectCodes } from "./runtime-config.js";
import {
  refreshTaskBoard,
  type TaskBoardEnv,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import type { SlackQueueEvent } from "./types.js";
import { parseTaskBoardTargets, taskBoardSlackToken, type TaskBoardTarget } from "./task-board-targets.js";

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

function legacyTargets(env: TaskBoardRuntimeEnv): TaskBoardTarget[] {
  if (env.RUNTIME_PLACEMENTS_JSON) return parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON)
    .filter((placement) => placement.taskBoardEnabled)
    .map((placement) => ({ targetId: `legacy-${placement.placementId}`, organizationId: "unson-business" as const,
      workspaceId: env.SLACK_EXPECTED_TEAM_ID, channelId: placement.channelId, projectCodes: placement.projectCodes }));
  return env.RUNTIME_TASK_BOARD_ENABLED === "true" ? [{ targetId: "legacy-default", organizationId: "unson-business",
    workspaceId: env.SLACK_EXPECTED_TEAM_ID, channelId: env.SLACK_ALLOWED_CHANNEL_ID,
    projectCodes: parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES) }] : [];
}

export function taskBoardTargets(env: TaskBoardRuntimeEnv): TaskBoardTarget[] {
  return env.TASK_BOARD_TARGETS_JSON ? parseTaskBoardTargets(env.TASK_BOARD_TARGETS_JSON) : legacyTargets(env);
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
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === repair.targetId);
  if (
    repair.tenantId !== env.TENANT_ID ||
    !target || repair.workspaceId !== target.workspaceId || repair.channelId !== target.channelId
  ) {
    console.error(JSON.stringify({ event: "task_board_repair_rejected", reason: "scope_mismatch" }));
    message.ack();
    return;
  }
  try {
    await refresh({ ...env,
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_BOT_TOKEN: taskBoardSlackToken(target, env),
      SLACK_ALLOWED_CHANNEL_ID: target.channelId,
      RUNTIME_PROJECT_CODES: target.projectCodes.join(",") });
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
  const results = await Promise.allSettled(taskBoardTargets(env).map((target) => env.TASK_BOARD_REPAIRS.send({
      eventType: "task_board_repair",
      tenantId: env.TENANT_ID,
      targetId: target.targetId,
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      reason: "scheduled",
      requestedAt: now,
    })));
  if (results.some((result) => result.status === "rejected")) throw new Error("task_board_schedule_enqueue_failed");
}
