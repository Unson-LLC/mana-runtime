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
import { enabledTaskBoardTargets, parseTaskBoardTargets, taskBoardTargetsForProjects,
  type TaskBoardTarget } from "./task-board-targets.js";
import type { TenantContextEnvelope } from "./multitenancy/contracts.js";
import type { TenantQueueBody } from "./multitenancy/runtime-boundaries.js";

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
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  TASK_BOARD_REPAIRS: { send(message: TenantQueueBody<TaskBoardRepairEvent>): Promise<unknown> };
  TASK_BOARD_BINDINGS?: TaskBoardBindingNamespace;
  RUNTIME_PLACEMENTS_JSON?: string;
}

export function taskBoardRepairEventId(repair: TaskBoardRepairEvent): string {
  return `task-board-repair:${repair.targetId}:${repair.requestedAt}`;
}

export async function createCanonicalTaskBoardRepairMessage(
  repair: TaskBoardRepairEvent,
  resolveTenantContext: (repair: TaskBoardRepairEvent) => Promise<TenantContextEnvelope>,
): Promise<TenantQueueBody<TaskBoardRepairEvent>> {
  const tenantContext = await resolveTenantContext(structuredClone(repair));
  if (tenantContext.slack.event_id !== taskBoardRepairEventId(repair)
    || tenantContext.slack.channel_id !== repair.channelId
    || tenantContext.slack.thread_ts !== repair.requestedAt
    || !tenantContext.slack.requester_id) throw new Error("task_board_tenant_context_scope_mismatch");
  return {
    schema_version: "1.0",
    tenant_context: tenantContext,
    payload: { ...repair, tenantId: tenantContext.tenant.tenant_id },
  };
}

export function taskBoardTargets(env: TaskBoardRuntimeEnv): TaskBoardTarget[] {
  if (env.TASK_BOARD_TARGETS_JSON?.trim()) return parseTaskBoardTargets(env.TASK_BOARD_TARGETS_JSON);
  const schedulingEnabled = env.RUNTIME_TASK_BOARD_ENABLED === "true"
    || (env.RUNTIME_PLACEMENTS_JSON
      ? parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON).some((placement) => placement.taskBoardEnabled)
      : false);
  if (schedulingEnabled) throw new Error("task_board_targets_required");
  return [];
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

export async function processTaskBoardRepair(
  repair: TaskBoardRepairEvent,
  env: TaskBoardRuntimeEnv,
  expectedTenantId: string,
  credentialFetch: typeof fetch,
  refresh: (bindings: TaskBoardEnv, options?: { fetch?: typeof fetch }) => Promise<unknown> = refreshTaskBoard,
  createCanvas: (channelId: string, token: string | undefined,
    options?: { fetch?: typeof fetch }) => Promise<string> = createManagedTaskBoardCanvas,
): Promise<void> {
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === repair.targetId);
  if (
    repair.tenantId !== expectedTenantId ||
    !target || target.organizationId !== env.TENANT_ID || !target.enabled
    || (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision ||
    repair.workspaceId !== target.workspaceId || repair.channelId !== target.channelId ||
    repair.manaCanvasId !== target.manaCanvasId || repair.bindingRevision !== target.bindingRevision
  ) {
    const rejectionReason = repair.tenantId !== expectedTenantId ? "tenant_mismatch" :
      !target ? "target_unknown" : target.organizationId !== env.TENANT_ID ? "target_tenant_mismatch"
        : !target.enabled ? "target_disabled" :
        (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision ? "canvas_binding_missing" :
          repair.workspaceId !== target.workspaceId || repair.channelId !== target.channelId
            ? "workspace_channel_mismatch" : "binding_snapshot_mismatch";
    console.error(JSON.stringify({ event: "task_board_repair_rejected", targetId: repair.targetId,
      reason: rejectionReason,
      expectedBindingRevision: target?.bindingRevision ?? null }));
    throw new Error("task_board_scope_mismatch");
  }
  let canvasId = target.manaCanvasId;
  if (!canvasId) {
    if (!target.autoProvision || !env.TASK_BOARD_BINDINGS) {
      console.error(JSON.stringify({ event: "task_board_repair_rejected", targetId: target.targetId,
        reason: "canvas_binding_store_missing", expectedBindingRevision: target.bindingRevision }));
      throw new Error("task_board_scope_mismatch");
    }
    const coordinates: TaskBoardBindingCoordinates = {
      tenantId: expectedTenantId,
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
      return;
    } else {
      try {
        canvasId = await createCanvas(target.channelId, undefined, { fetch: credentialFetch });
      } catch (error) {
        if (error instanceof TaskBoardCanvasProvisioningError && error.definitive) {
          await releaseTaskBoardBinding(env.TASK_BOARD_BINDINGS, coordinates);
          throw error;
        }
        console.error(JSON.stringify({ event: "task_board_canvas_provisioning_uncertain",
          targetId: target.targetId, bindingRevision: target.bindingRevision }));
        return;
      }
      await completeTaskBoardBinding(env.TASK_BOARD_BINDINGS, coordinates, canvasId);
    }
  }
  await refresh({ ...env,
    RUNTIME_TASK_BOARD_ENABLED: "true",
    BRAINBASE_TASK_API_TOKEN: undefined,
    SLACK_BOT_TOKEN: undefined,
    SLACK_ALLOWED_CHANNEL_ID: target.channelId,
    TASK_BOARD_CANVAS_ID: canvasId,
    RUNTIME_PROJECT_CODES: target.projectCodes.join(",") }, { fetch: credentialFetch });
}

export async function enqueueScheduledTaskBoardRepair(
  env: TaskBoardRuntimeEnv,
  now: string,
  resolveTenantContext: (repair: TaskBoardRepairEvent) => Promise<TenantContextEnvelope>,
): Promise<void> {
  const configuredTargets = taskBoardTargets(env);
  const taskBoardPlacements = env.RUNTIME_PLACEMENTS_JSON
    ? parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON).filter((placement) => placement.taskBoardEnabled)
    : [];
  const placementForTarget = (target: TaskBoardTarget) => taskBoardPlacements.find((placement) =>
    placement.channelId === target.channelId
    && placement.projectCodes.length === target.projectCodes.length
    && placement.projectCodes.every((project) => target.projectCodes.includes(project)));
  const activeTargets = enabledTaskBoardTargets(configuredTargets).filter((target) =>
    target.organizationId === env.TENANT_ID
    && target.workspaceId === env.SLACK_EXPECTED_TEAM_ID
    && Boolean(placementForTarget(target)));
  configuredTargets.filter((target) => !activeTargets.includes(target)).forEach((target) => console.info(JSON.stringify({
    event: "task_board_repair_suppressed", targetId: target.targetId,
    reason: !target.enabled ? "target_disabled"
      : (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision ? "canvas_binding_missing"
        : target.organizationId !== env.TENANT_ID ? "tenant_mismatch"
          : target.workspaceId !== env.SLACK_EXPECTED_TEAM_ID ? "workspace_mismatch"
            : "placement_scope_missing",
  })));
  const results = await Promise.allSettled(activeTargets.map(async (target) => {
    const repair: TaskBoardRepairEvent = {
      eventType: "task_board_repair",
      tenantId: "",
      targetId: target.targetId,
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      manaCanvasId: target.manaCanvasId,
      bindingRevision: target.bindingRevision!,
      reason: "scheduled",
      requestedAt: now,
    };
    await env.TASK_BOARD_REPAIRS.send(await createCanonicalTaskBoardRepairMessage(repair, resolveTenantContext));
  }));
  if (results.some((result) => result.status === "rejected")) throw new Error("task_board_schedule_enqueue_failed");
}

export async function enqueueTaskBoardRepairsForProjects(env: TaskBoardRuntimeEnv, projectIds: readonly string[],
  reason: TaskBoardRepairEvent["reason"],
  resolveTenantContext: (repair: TaskBoardRepairEvent) => Promise<TenantContextEnvelope>,
): Promise<void> {
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
  const results = await Promise.allSettled(targets.map(async (target) => {
    const repair: TaskBoardRepairEvent = {
    eventType: "task_board_repair", targetId: target.targetId, tenantId: "",
    workspaceId: target.workspaceId, channelId: target.channelId,
    manaCanvasId: target.manaCanvasId ?? null, bindingRevision: target.bindingRevision!, reason,
    requestedAt: new Date().toISOString(),
    };
    return env.TASK_BOARD_REPAIRS.send(await createCanonicalTaskBoardRepairMessage(repair, resolveTenantContext));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error("task_board_repair_enqueue_failed", {
      targetId: targets[index]?.targetId, reason, error: result.reason,
    });
  });
}

export async function enqueueMeetingMinutesTaskBoardRepair(env: TaskBoardRuntimeEnv, targetId: string,
  reason: TaskBoardRepairEvent["reason"],
  resolveTenantContext: (repair: TaskBoardRepairEvent) => Promise<TenantContextEnvelope>,
): Promise<void> {
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === targetId);
  if (!target) throw new Error(`meeting_minutes_task_board_target_not_found:${targetId}`);
  if (!target.enabled || (!target.manaCanvasId && !target.autoProvision) || !target.bindingRevision) {
    console.info(JSON.stringify({ event: "task_board_repair_suppressed", targetId,
      reason: !target.enabled ? "target_disabled" : "canvas_binding_missing" }));
    return;
  }
  const repair: TaskBoardRepairEvent = {
    eventType: "task_board_repair", targetId: target.targetId, tenantId: "",
    workspaceId: target.workspaceId, channelId: target.channelId,
    manaCanvasId: target.manaCanvasId ?? null, bindingRevision: target.bindingRevision, reason,
    requestedAt: new Date().toISOString(),
  };
  await env.TASK_BOARD_REPAIRS.send(await createCanonicalTaskBoardRepairMessage(repair, resolveTenantContext));
}
