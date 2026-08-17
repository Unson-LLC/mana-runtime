import { signTaskWriteCapability } from "@openryoko/write-broker";
import { parseRuntimePlacements, parseRuntimeProjectCodes } from "./runtime-config.js";
import {
  createManagedTaskBoardCanvas,
  refreshTaskBoard,
  TaskBoardCanvasProvisioningError,
  type TaskBoardEnv,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import {
  completeTaskBoardBinding,
  releaseTaskBoardBinding,
  reserveTaskBoardBinding,
  type TaskBoardBindingCoordinates,
  type TaskBoardBindingNamespace,
} from "./task-board-binding.js";
import type { SlackQueueEvent } from "./types.js";
import { enabledTaskBoardTargets, parseTaskBoardTargets, taskBoardSlackToken, taskBoardTargetsForProjects,
  type TaskBoardTarget } from "./task-board-targets.js";

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
  TASK_BOARD_BINDINGS?: TaskBoardBindingNamespace;
  RUNTIME_PLACEMENTS_JSON?: string;
}

function legacyTargets(env: TaskBoardRuntimeEnv): TaskBoardTarget[] {
  if (env.RUNTIME_PLACEMENTS_JSON) return parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON)
    .filter((placement) => placement.taskBoardEnabled)
    .map((placement) => ({ targetId: `legacy-${placement.placementId}`, organizationId: "unson-business" as const,
      workspaceId: env.SLACK_EXPECTED_TEAM_ID, channelId: placement.channelId, projectCodes: placement.projectCodes,
      enabled: false, autoProvision: false, manaCanvasId: null, bindingRevision: null }));
  return env.RUNTIME_TASK_BOARD_ENABLED === "true" ? [{ targetId: "legacy-default", organizationId: "unson-business",
    workspaceId: env.SLACK_EXPECTED_TEAM_ID, channelId: env.SLACK_ALLOWED_CHANNEL_ID,
    projectCodes: parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES), enabled: false, autoProvision: false,
    manaCanvasId: null, bindingRevision: null }] : [];
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
  createCanvas: (channelId: string, token: string) => Promise<string> = createManagedTaskBoardCanvas,
): Promise<void> {
  const repair = message.body;
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === repair.targetId);
  if (
    repair.tenantId !== env.TENANT_ID ||
    !target || !target.enabled || (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision ||
    repair.workspaceId !== target.workspaceId || repair.channelId !== target.channelId ||
    repair.manaCanvasId !== target.manaCanvasId || repair.bindingRevision !== target.bindingRevision
  ) {
    const rejectionReason = repair.tenantId !== env.TENANT_ID ? "tenant_mismatch" :
      !target ? "target_unknown" : !target.enabled ? "target_disabled" :
        (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision ? "canvas_binding_missing" :
          repair.workspaceId !== target.workspaceId || repair.channelId !== target.channelId
            ? "workspace_channel_mismatch" : "binding_snapshot_mismatch";
    console.error(JSON.stringify({ event: "task_board_repair_rejected", targetId: repair.targetId,
      reason: rejectionReason,
      expectedBindingRevision: target?.bindingRevision ?? null }));
    message.ack();
    return;
  }
  try {
    const token = taskBoardSlackToken(target, env);
    let canvasId = target.manaCanvasId;
    if (!canvasId) {
      if (!target.autoProvision || !env.TASK_BOARD_BINDINGS) {
        console.error(JSON.stringify({ event: "task_board_repair_rejected", targetId: target.targetId,
          reason: "canvas_binding_store_missing", expectedBindingRevision: target.bindingRevision }));
        message.ack();
        return;
      }
      const coordinates: TaskBoardBindingCoordinates = {
        tenantId: env.TENANT_ID,
        targetId: target.targetId,
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        bindingRevision: target.bindingRevision,
      };
      const reservation = await reserveTaskBoardBinding(env.TASK_BOARD_BINDINGS, coordinates);
      if (reservation.status === "bound") {
        canvasId = reservation.canvasId;
      } else if (reservation.status === "provisioning") {
        console.warn(JSON.stringify({ event: "task_board_canvas_provisioning_pending",
          targetId: target.targetId, bindingRevision: target.bindingRevision }));
        message.ack();
        return;
      } else {
        try {
          canvasId = await createCanvas(target.channelId, token);
        } catch (error) {
          if (error instanceof TaskBoardCanvasProvisioningError && error.definitive) {
            await releaseTaskBoardBinding(env.TASK_BOARD_BINDINGS, coordinates);
            throw error;
          }
          console.error(JSON.stringify({ event: "task_board_canvas_provisioning_uncertain",
            targetId: target.targetId, bindingRevision: target.bindingRevision }));
          message.ack();
          return;
        }
        await completeTaskBoardBinding(env.TASK_BOARD_BINDINGS, coordinates, canvasId);
      }
    }
    await refresh({ ...env,
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_BOT_TOKEN: token,
      SLACK_ALLOWED_CHANNEL_ID: target.channelId,
      TASK_BOARD_CANVAS_ID: canvasId,
      RUNTIME_PROJECT_CODES: target.projectCodes.join(",") });
    message.ack();
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ event: "task_board_repair_failed", targetId: target.targetId, code }));
    if (code === "task_board_canvas_binding_mismatch" || code === "task_board_not_configured") message.ack();
    else message.retry();
  }
}

export async function enqueueScheduledTaskBoardRepair(
  env: TaskBoardRuntimeEnv,
  now = new Date().toISOString(),
): Promise<void> {
  const configuredTargets = taskBoardTargets(env);
  const activeTargets = enabledTaskBoardTargets(configuredTargets);
  configuredTargets.filter((target) => !activeTargets.includes(target)).forEach((target) => console.info(JSON.stringify({
    event: "task_board_repair_suppressed", targetId: target.targetId,
    reason: !target.enabled ? "target_disabled" : "canvas_binding_missing",
  })));
  const results = await Promise.allSettled(activeTargets.map((target) => env.TASK_BOARD_REPAIRS.send({
      eventType: "task_board_repair",
      tenantId: env.TENANT_ID,
      targetId: target.targetId,
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      manaCanvasId: target.manaCanvasId,
      bindingRevision: target.bindingRevision!,
      reason: "scheduled",
      requestedAt: now,
    })));
  if (results.some((result) => result.status === "rejected")) throw new Error("task_board_schedule_enqueue_failed");
}

export async function enqueueTaskBoardRepairsForProjects(env: TaskBoardRuntimeEnv, projectIds: readonly string[],
  reason: TaskBoardRepairEvent["reason"]): Promise<void> {
  let configuredTargets;
  try { configuredTargets = taskBoardTargets(env); }
  catch (error) { console.error("task_board_targets_invalid", error); return; }
  const affected = new Set(projectIds);
  const matchingTargets = configuredTargets.filter((target) =>
    target.projectCodes.some((project) => affected.has(project)));
  const targets = taskBoardTargetsForProjects(configuredTargets, projectIds);
  matchingTargets.filter((target) => !targets.includes(target)).forEach((target) => console.info(JSON.stringify({
    event: "task_board_repair_suppressed", targetId: target.targetId,
    reason: !target.enabled ? "target_disabled" : "canvas_binding_missing",
  })));
  const results = await Promise.allSettled(targets.map((target) => env.TASK_BOARD_REPAIRS.send({
    eventType: "task_board_repair", targetId: target.targetId, tenantId: env.TENANT_ID,
    workspaceId: target.workspaceId, channelId: target.channelId,
    manaCanvasId: target.manaCanvasId, bindingRevision: target.bindingRevision!, reason,
    requestedAt: new Date().toISOString(),
  })));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error("task_board_repair_enqueue_failed", {
      targetId: targets[index]?.targetId, reason, error: result.reason,
    });
  });
}

export async function enqueueMeetingMinutesTaskBoardRepair(env: TaskBoardRuntimeEnv, targetId: string,
  reason: TaskBoardRepairEvent["reason"]): Promise<void> {
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === targetId);
  if (!target) throw new Error(`meeting_minutes_task_board_target_not_found:${targetId}`);
  if (!target.enabled || (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision) {
    console.info(JSON.stringify({ event: "task_board_repair_suppressed", targetId,
      reason: !target.enabled ? "target_disabled" : "canvas_binding_missing" }));
    return;
  }
  await env.TASK_BOARD_REPAIRS.send({
    eventType: "task_board_repair", targetId: target.targetId, tenantId: env.TENANT_ID,
    workspaceId: target.workspaceId, channelId: target.channelId,
    manaCanvasId: target.manaCanvasId, bindingRevision: target.bindingRevision, reason,
    requestedAt: new Date().toISOString(),
  });
}
