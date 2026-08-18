import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { handleSlackRequest } from "./slack.js";
import { hasAnthropicCredential } from "./anthropic-auth.js";
import {
  handleSandboxAdminRequest,
  isSandboxAdminAuthorized,
} from "./sandbox-admin.js";
import {
  createTechKnightSandbox,
  type SandboxRuntimeEnv,
} from "./sandbox-runtime.js";
import type { SlackQueueEvent } from "./types.js";
import {
  currentMeetingMinutesActionTs,
  isMeetingMinutesSelection,
  isMeetingMinutesRedo,
  isMeetingMinutesRouterFileEvent,
  meetingMinutesRuntimeConfig,
  processMeetingMinutesSlackEvent,
  processMeetingMinutesRedo,
  type MeetingMinutesEnvironment,
} from "./meeting-minutes-entrypoints.js";
import type { MeetingMinutesDestination, MeetingMinutesRecovery, MeetingMinutesRedo, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { handleMeetingMinutesInteractionEntrypoint } from "./slack-interactions.js";
import { processMeetingMinutesSelectionWithStatus } from "./meeting-minutes-lifecycle.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import { meetingMinutesFailureLog } from "./meeting-minutes-diagnostics.js";
import { handleMeetingMinutesTaskAction } from "./meeting-minutes-task-actions.js";
import { handleTaskWriteProxyRequest } from "./task-write-proxy.js";
import { peekTaskWriteApproval } from "./task-write-approval.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import { resolveMeetingMinutesDestinationSlackToken } from "./meeting-minutes-slack-routing.js";
import { CloudflareMeetingMinutesGitHubClient } from "./meeting-minutes-github.js";
import { classifyMeetingMinutesDestinationInSandbox,
  generateMeetingMinutesInSandbox } from "./meeting-minutes-generator.js";
import { MeetingMinutesBrainbaseContextClient, resolveMeetingMinutesContextMode } from "./meeting-minutes-brainbase-context.js";
import { TaskApiClient, TaskApiError } from "@openryoko/task-runtime-core";
import { deterministicRuntimeUuid, isReplyEligible, postSlackReply, processReplyEvent, ReplyPipelineError } from "./reply-pipeline.js";
import { resolveActorIdentityResolverFromEnv } from "./slack-actor-identity.js";
import {
  processMeetingTaskEvent,
} from "./meeting-task-pipeline.js";
import {
  parseRuntimePlacements,
  RuntimeBindingError,
  resolveRuntimePlacement,
  runWithReplyTaskSearchBinding,
} from "./runtime-config.js";
import { routeRuntimeEvent } from "./runtime-event-router.js";
import { consumeTechKnightMessage } from "./queue-consumer.js";
import { isReplyCompleted, persistEventOnce, persistReplyCompletion } from "./workspace-store.js";
import { hydrateSlackQueueEventThreadContext } from "./slack-thread-context.js";
import { withDisposableResource } from "./disposable-resource.js";
import { resolveClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { requesterProfileOrFallback, resolveSlackUserProfile } from "./slack-user-profile.js";
import { runtimeWorkspaceName } from "./runtime-workspace-key.js";
import { executeRuntimeControlCommand, parseRuntimeControlCommand, renderRuntimeControlCommandError, RuntimeControlCommandError } from "./runtime-control-command.js";
import { markClaudeSessionStarted, markWorkspaceEngaged, readWorkspaceSession, reconcilePermissionRevision } from "./workspace-session.js";
import { runRuntimeDoctor } from "./runtime-doctor.js";
import { executeRuntimeCron, parsePlacementCronJobs } from "./runtime-cron.js";
import { createManualCronEvent } from "./runtime-cron-event.js";
import { handleSlackCommandRequest } from "./slack-command.js";
import { runCloudflareDevelopmentRequest } from "./development-runner-client.js";
import { handleDevelopmentCallback } from "./development-callback.js";
import { appendSlackThreadParticipantProfiles } from "./slack-thread-participants.js";
import { hydrateSlackAttachments } from "./slack-attachments.js";
import { hydrateGraphContext, listGraphPeople, resolveGraphPersonByName, resolveGraphRequester } from "./brainbase-graph-runtime.js";
import { RuntimeSessionRegistry, upsertRuntimeSession } from "./runtime-session-registry.js";
import {
  consumeTaskBoardRepair,
  enqueueMeetingMinutesTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  enqueueTaskBoardRepairsForProjects,
  issueTaskWriteRequestContext,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import { parseTaskBoardTargets } from "./task-board-targets.js";
import { actorIdHash, emitTurnLog, type TurnRuntimeTrace } from "./turn-observability.js";
import { claimRuntimeEvent, completeRuntimeEvent, releaseRuntimeEvent, runtimeDeliveryId } from "./runtime-event-claim.js";
import { runRuntimeTriage } from "./runtime-triage.js";
import { armMeetingMinutesRecovery, isMeetingMinutesRecovery, MEETING_MINUTES_RECOVERY_DELAY_SECONDS,
  recoverStaleMeetingMinutesRun } from "./meeting-minutes-recovery.js";
import { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";
import {
  gateMeetingMinutesCommandQueueMessage,
  gateMeetingMinutesRouterQueueMessage,
  handleMeetingMinutesIntakeAdminRequest,
  interceptMeetingMinutesIntakePause,
} from "./meeting-minutes-intake-entrypoints.js";
import {
  ContractLedgerState,
  contractLedgerConfig,
  enqueueScheduledContractLedgerSync,
  isContractLedgerEvent,
  notifyContractLedgerDeadLetter,
  parseContractLedgerSlackAction,
  processContractLedgerApproval,
  processContractLedgerSync,
  scheduledContractLedgerEvent,
  type ContractLedgerApprovalEvent,
  type ContractLedgerEnvironment,
  type ContractLedgerSyncEvent,
} from "./contract-ledger.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";
export { TaskBoardBinding } from "./task-board-binding.js";
export { RuntimeSessionRegistry } from "./runtime-session-registry.js";
export { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";
export { ContractLedgerState } from "./contract-ledger.js";

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment, ContractLedgerEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_SIGNING_SECRET_TECHKNIGHT?: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON?: string;
  RUNTIME_CRON_JOBS_JSON?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  TASK_WRITE_APPROVAL_CHANNEL_ID?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
  GITHUB_TOKEN?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  MEETING_MINUTES_CONTEXT_MODE?: string;
  RUNTIME_PROJECT_CODES?: string;
  RUNTIME_EXECUTION_MODE?: string;
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  RUNTIME_TASK_WRITE_ENABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  RUNTIME_PLACEMENT_ID?: string;
  RUNTIME_PLACEMENTS_JSON?: string;
  RUNTIME_TASK_BOARD_ENABLED?: string;
  TASK_BOARD_TARGETS_JSON?: string;
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
  BRAINBASE_SLACK_PERSON_MAP_JSON?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  TENANT_ID: string;
  TECHKNIGHT_EVENTS: Queue<SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery>;
  TASK_BOARD_REPAIRS: Queue<TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS: DurableObjectNamespace;
  TASK_WRITE_APPROVALS: DurableObjectNamespace;
  TASK_BOARD_BINDINGS: DurableObjectNamespace;
  TECHKNIGHT_WORKSPACE: DurableObjectNamespace<TechKnightWorkspace>;
  MEETING_MINUTES_WORKSPACE: DurableObjectNamespace<MeetingMinutesWorkspace>;
  MEETING_MINUTES_DEPLOYMENT_GATE: DurableObjectNamespace<MeetingMinutesDeploymentGate>;
  RUNTIME_SESSION_REGISTRY: DurableObjectNamespace<RuntimeSessionRegistry>;
}

interface WorkspaceEnv {}

class WorkspaceBase extends DurableObject<WorkspaceEnv> {
  get workspaceStorage(): DurableObjectStorage {
    return this.ctx.storage;
  }
}

export class TechKnightWorkspace extends withWorkspace(
  WorkspaceBase,
  (self) => ({
    // @cloudflare/computer 0.1.1 was published against Workers types v4.
    storage: self.workspaceStorage as unknown as DurableObjectStorageLike,
  }),
) {
  async claimRuntimeEvent(eventId: string): Promise<boolean> {
    return claimRuntimeEvent(this.ctx.storage, eventId);
  }

  async completeRuntimeEvent(eventId: string, responseTs?: string): Promise<void> {
    await completeRuntimeEvent(this.ctx.storage, eventId, responseTs);
  }

  async releaseRuntimeEvent(eventId: string): Promise<void> {
    await releaseRuntimeEvent(this.ctx.storage, eventId);
  }

  async claimDevelopmentCallback(eventId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(eventId)) throw new Error("event_id_invalid");
    const key = `development-callback:${eventId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(key)) return false;
      await transaction.put(key, { status: "pending", claimedAt: new Date().toISOString() });
      return true;
    });
  }

  async completeDevelopmentCallback(eventId: string, responseTs: string): Promise<void> {
    const key = `development-callback:${eventId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<{ status?: string }>(key);
      if (current?.status !== "pending") throw new Error("development_callback_claim_missing");
      await transaction.put(key, { status: "completed", responseTs, completedAt: new Date().toISOString() });
    });
  }

  async releaseDevelopmentCallback(eventId: string): Promise<void> {
    const key = `development-callback:${eventId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<{ status?: string }>(key);
      if (current?.status === "pending") await transaction.delete(key);
    });
  }
}

export class MeetingMinutesWorkspace extends withWorkspace(
  WorkspaceBase,
  (self) => ({ storage: self.workspaceStorage as unknown as DurableObjectStorageLike }),
) {}

function workspaceName(event: SlackQueueEvent): string {
  return runtimeWorkspaceName(event);
}

function runtimeErrorCode(error: unknown): string {
  if (error instanceof ReplyPipelineError) return error.code;
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unexpected_error";
}

function meetingMinutesWorkspaceName(tenantId: string, workspaceId: string, runId: string): string {
  return [tenantId, workspaceId, "meeting-minutes", runId].join(":");
}

function meetingMinutesDeploymentGate(env: Env): DurableObjectStub<MeetingMinutesDeploymentGate> {
  return env.MEETING_MINUTES_DEPLOYMENT_GATE.get(env.MEETING_MINUTES_DEPLOYMENT_GATE.idFromName(env.TENANT_ID));
}

function meetingMinutesCommandGateDependencies(env: Env, enabled: boolean) {
  return {
    enabled,
    isPaused: () => meetingMinutesDeploymentGate(env).isIntakePaused(),
    notify: (command: MeetingMinutesSelection | MeetingMinutesRedo) =>
      meetingMinutesClients(env).slack.postIntakePausedToUser(command.channelId, command.userId),
    logPaused: (command: MeetingMinutesSelection | MeetingMinutesRedo) => console.warn(JSON.stringify({
      event: "meeting_minutes_command_intake_paused", kind: command.kind, runId: command.runId,
    })),
    logDisabled: (command: MeetingMinutesSelection | MeetingMinutesRedo) => console.warn(JSON.stringify({
      event: "meeting_minutes_command_intake_disabled", kind: command.kind, runId: command.runId,
    })),
    logNotificationFailure: (command: MeetingMinutesSelection | MeetingMinutesRedo, error: unknown) =>
      console.warn(JSON.stringify({
        event: "meeting_minutes_command_intake_notice_failed", kind: command.kind, runId: command.runId,
        error: error instanceof Error ? error.message : "unexpected_error",
      })),
  };
}

function meetingMinutesClients(env: Env) {
  const slack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "");
  const github = new CloudflareMeetingMinutesGitHubClient(env.GITHUB_TOKEN ?? "");
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const destinations = meetingMinutesRuntimeConfig(env).destinations;
  const destinationSlack = (channelId: string) => {
    const organizationIds = [...new Set(destinations
      .filter((destination) => destination.slackChannelId === channelId)
      .map((destination) => destination.organization.id))];
    if (organizationIds.length !== 1) throw new Error("meeting_minutes_destination_slack_routing_invalid");
    const [organizationId] = organizationIds;
    return new MeetingMinutesSlackClient(resolveMeetingMinutesDestinationSlackToken(env, organizationId));
  };
  const taskClient = () => new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
    token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
  const contextMode = resolveMeetingMinutesContextMode(env.MEETING_MINUTES_CONTEXT_MODE);
  const contextClient = new MeetingMinutesBrainbaseContextClient(env.BRAINBASE_TASK_API_BASE_URL ?? "",
    env.BRAINBASE_TASK_API_TOKEN ?? "");
  return {
    slack,
    classify: (transcript: string, candidates: Parameters<typeof classifyMeetingMinutesDestinationInSandbox>[1]) => {
      if (!hasAnthropicCredential(env)) throw new Error("oauth_not_configured");
      return classifyMeetingMinutesDestinationInSandbox(transcript, candidates, claudeRuntime,
        createTechKnightSandbox(env, `meeting-minutes-routing-${crypto.randomUUID()}`));
    },
    resume: {
      contextMode,
      resolveContext: (identity: Parameters<MeetingMinutesBrainbaseContextClient["resolve"]>[0], receiptId?: string) =>
        contextClient.resolve(identity, receiptId),
      postProcessingStatus: (run: MeetingMinutesRun) => slack.postProcessingStatus(run),
      download: (fileId: string) => slack.downloadTextFile(fileId),
      generate: (transcript: string, destination: MeetingMinutesDestination,
        context: Parameters<typeof generateMeetingMinutesInSandbox>[2], mode: Parameters<typeof generateMeetingMinutesInSandbox>[3],
        observe?: Parameters<typeof generateMeetingMinutesInSandbox>[6]) => {
        if (!hasAnthropicCredential(env)) throw new Error("oauth_not_configured");
        return generateMeetingMinutesInSandbox(transcript, destination, context, mode, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`), observe);
      },
      saveGitHub: (input: Parameters<typeof github.save>[0]) => github.save(input),
      createTask: async (input: Parameters<TaskApiClient["createTask"]>[0], idempotencyKey: string) => {
        return taskClient().createTask(input, idempotencyKey);
      },
      findExistingTask: async (title: string, projectCodes: readonly string[]) => {
        const normalizedTitle = title.trim().toLocaleLowerCase("ja");
        const exact: Array<{ id: string }> = [];
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const page = await taskClient().listTasks({ project_code: [...projectCodes], limit: 50,
            ...(cursor ? { cursor } : {}) });
          exact.push(...page.items
            .filter((task) => task.title.trim().toLocaleLowerCase("ja") === normalizedTitle)
            .map((task) => ({ id: task.id })));
          if (exact.length > 1) return undefined;
          if (!page.next_cursor) return exact.length === 1 ? exact[0] : undefined;
          cursor = page.next_cursor;
        }
        return undefined;
      },
      // Destination project IDs belong to the task destination contract and are
      // not Graph person scopes. Resolve globally, then let non-unique names
      // fail closed in resolveGraphPersonByName.
      resolveAssignee: (name: string, _projectId: string) => resolveGraphPersonByName(name, undefined, {
        baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
        token: env.BRAINBASE_GRAPH_API_TOKEN,
      }),
      postParent: (channelId: string, fileName: string, summary: string, clientMsgId: string) =>
        destinationSlack(channelId).postParent(channelId, fileName, summary, clientMsgId),
      postTaskCard: (run: MeetingMinutesRun) => destinationSlack(run.destination!.slackChannelId).postTaskCard(run),
      repairTaskBoard: (targetId: string) =>
        enqueueMeetingMinutesTaskBoardRepair(env, targetId, "task_write"),
      postThreadChunk: (channelId: string, threadTs: string, fileName: string, text: string,
        index: number, total: number, clientMsgId: string) =>
        destinationSlack(channelId).postThreadChunk(channelId, threadTs, fileName, text, index, total, clientMsgId),
    },
    redo: {
      deleteGitHub: (destination: MeetingMinutesDestination, paths: readonly string[]) =>
        github.delete(destination.github, paths),
      deleteTask: async (taskId: string, idempotencyKey: string) => {
        const client = taskClient();
        try {
          const task = await client.getTask(taskId);
          await client.deleteTask(taskId, task.version, idempotencyKey);
        } catch (error) {
          if (error instanceof TaskApiError && error.status === 404) return;
          throw error;
        }
      },
      retractSharedMinutes: (destination: MeetingMinutesDestination,
        parentTs: string, fileName: string) =>
        destinationSlack(destination.slackChannelId).retractSharedMinutes(destination.slackChannelId, parentTs, fileName),
      showDestinationSelection: (run: MeetingMinutesRun, destinations: Parameters<typeof slack.showDestinationSelection>[1]) =>
        slack.showDestinationSelection(run, destinations),
      showRedoFailure: (run: MeetingMinutesRun) => slack.showRedoFailure(run),
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        tenant: env.TENANT_ID,
        meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
        taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED === "true",
        taskWriteEnabled: env.RUNTIME_TASK_WRITE_ENABLED === "true",
        taskBoardEnabled: env.RUNTIME_TASK_BOARD_ENABLED === "true",
        meetingMinutesEnabled: env.MEETING_MINUTES_ENABLED === "true",
      });
    }
    if (url.pathname.startsWith("/admin/sandbox/")) {
      return handleSandboxAdminRequest(request, env, {
        createSandbox: (id) => createTechKnightSandbox(env, id),
      });
    }
    if (request.method === "GET" && url.pathname === "/admin/meeting-minutes/deploy-gate") {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(await meetingMinutesDeploymentGate(env).status());
    }
    if (request.method === "POST" && url.pathname === "/admin/meeting-minutes/intake") {
      const gate = meetingMinutesDeploymentGate(env);
      return handleMeetingMinutesIntakeAdminRequest(request, {
        authorize: (candidate) => isSandboxAdminAuthorized(candidate, env.SANDBOX_PROBE_TOKEN),
        setPaused: (paused) => gate.setIntakePaused(paused),
        status: () => gate.status(),
      });
    }
    const runAdminMatch = url.pathname.match(/^\/admin\/meeting-minutes\/runs\/([A-Za-z0-9_-]{3,260})(\/retry|\/adopt-tasks)?$/);
    if (runAdminMatch && (request.method === "GET" || request.method === "POST")) {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const runId = runAdminMatch[1]!;
      const workspaceId = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        env.TENANT_ID, env.SLACK_EXPECTED_TEAM_ID, runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(workspaceId) as unknown as WorkspaceHandle;
      let run = await withDisposableResource(() => getWorkspace(handle),
        (workspace) => loadMeetingMinutesRun(workspace.fs, runId));
      if (!run) return Response.json({ error: "meeting_minutes_run_not_found" }, { status: 404 });
      if (request.method === "POST") {
        if (!runAdminMatch[2] || !run.destination) {
          return Response.json({ error: "meeting_minutes_retry_not_available" }, { status: 409 });
        }
        if (runAdminMatch[2] === "/adopt-tasks") {
          const payload = await request.json().catch(() => null) as { taskIds?: unknown } | null;
          const taskIds = Array.isArray(payload?.taskIds) && payload.taskIds.every((id) =>
            typeof id === "string" && id.length >= 3 && id.length <= 512)
            ? [...new Set(payload.taskIds)] : [];
          const generatedTasks = run.generated?.tasks ?? [];
          const conflictRepair = run.taskRegistration?.failure?.status === 409;
          const incompleteAdoption = run.taskRegistration?.registered.length === generatedTasks.length &&
            run.diagnostics?.stage === "task_registration";
          if ((!conflictRepair && !incompleteAdoption) ||
            taskIds.length !== generatedTasks.length) {
            return Response.json({ error: "meeting_minutes_task_adoption_invalid" }, { status: 409 });
          }
          const taskApi = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
            token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (input, init) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) });
          const tasks = await Promise.all(taskIds.map((taskId) => taskApi.getTask(taskId)));
          const projectCodes = run.destination.taskProjectCodes;
          if (tasks.some((task) => !projectCodes.every((code) => (task.project_codes ?? []).includes(code)))) {
            return Response.json({ error: "meeting_minutes_task_adoption_scope_mismatch" }, { status: 409 });
          }
          run = await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
            const current = (await loadMeetingMinutesRun(workspace.fs, runId))!;
            const repairFailure = current.taskRegistration?.failure ?? { index: 0, stage: "task_registration" as const,
              message: "meeting_minutes_task_registration_failed", status: 409,
              failedAt: new Date().toISOString() };
            current.taskRegistration = { registered: tasks.map((task, index) => ({ index,
              title: task.title, taskId: task.id, status: "reused" as const,
              projectCodes: [...projectCodes] })), failure: repairFailure };
            current.updatedAt = new Date().toISOString();
            await saveMeetingMinutesRun(workspace.fs, current);
            return current;
          });
        }
        const selection = { kind: "meeting_minutes_selection", runId,
          destinationId: run.destination!.id, workspaceId: run.workspaceId,
          channelId: run.sourceChannelId, userId: run.approvedBy ?? "admin-retry",
          actionTs: currentMeetingMinutesActionTs() } satisfies MeetingMinutesSelection;
        run = await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
          const clients = meetingMinutesClients(env);
          await processMeetingMinutesSelectionWithStatus(workspace.fs, selection,
            meetingMinutesRuntimeConfig(env), clients.resume, {
              updateStatus: (candidate, outcome) => clients.slack.updateRunStatus(candidate, outcome),
            });
          return (await loadMeetingMinutesRun(workspace.fs, runId))!;
        });
      }
      return Response.json({ runId: run.runId, status: run.status,
        destinationId: run.destination?.id, diagnostics: run.diagnostics,
        taskRegistration: { registeredCount: run.taskRegistration?.registered.length ?? 0,
          failure: run.taskRegistration?.failure,
          failedCandidateTitle: run.taskRegistration?.failure
            ? run.generated?.tasks?.[run.taskRegistration.failure.index]?.title : undefined },
        checkpoint: { hasGitHub: Boolean(run.github), hasSlackParent: Boolean(run.slack?.parentTs),
          postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 },
        ...(request.method === "POST" ? { enqueued: true } : {}) });
    }
    if (request.method === "POST" && url.pathname === "/internal/contract-ledger/sync") {
      const authorization = request.headers.get("authorization");
      if (!env.CONTRACT_LEDGER_TRIGGER_TOKEN || authorization !== `Bearer ${env.CONTRACT_LEDGER_TRIGGER_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const config = contractLedgerConfig(env);
      if (!config.enabled) return Response.json({ error: "contract_ledger_disabled" }, { status: 503 });
      const event = scheduledContractLedgerEvent(new Date(), config.fromDate);
      await env.CONTRACT_LEDGER_SYNCS.send(event);
      return Response.json({ ok: true, queued: true, runId: event.runId, idempotencyKey: event.idempotencyKey });
    }
    if (request.method === "POST" && url.pathname === "/development/callback") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      let callbackWorkspace: DurableObjectStub<TechKnightWorkspace> | undefined;
      return handleDevelopmentCallback(request, {
        token: env.DEVELOPMENT_CALLBACK_TOKEN, tenantId: env.TENANT_ID,
        workspaceId: env.SLACK_EXPECTED_TEAM_ID, placements,
        claim: async (eventId, payload) => {
          const callbackEvent: SlackQueueEvent = { tenantId: env.TENANT_ID, eventId, workspaceId: payload.workspace_id,
            channelId: payload.channel_id, threadTs: payload.thread_ts, messageTs: payload.thread_ts,
            userId: payload.requester_id, eventType: "development_result", text: "", receivedAt: new Date().toISOString() };
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(callbackEvent));
          callbackWorkspace = env.TECHKNIGHT_WORKSPACE.get(id);
          return callbackWorkspace.claimDevelopmentCallback(eventId);
        },
        complete: async (eventId, responseTs) => {
          if (!callbackWorkspace) throw new Error("development_callback_workspace_missing");
          await callbackWorkspace.completeDevelopmentCallback(eventId, responseTs);
        },
        release: async (eventId) => {
          if (!callbackWorkspace) return;
          await callbackWorkspace.releaseDevelopmentCallback(eventId);
        },
        post: (event, text) => postSlackReply(event, text, { slackBotToken: env.SLACK_BOT_TOKEN }),
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      const config = meetingMinutesRuntimeConfig(env);
      return handleMeetingMinutesInteractionEntrypoint(request, env, ctx, config.operatorUserIds,
        async ({ approvalId, payloadHash, approverId, channelId }) => {
          const approvalChannelId = env.TASK_WRITE_APPROVAL_CHANNEL_ID ?? env.SLACK_ALLOWED_CHANNEL_ID;
          if (channelId !== approvalChannelId) return Response.json({ error: "task_write_approval_channel_mismatch" }, { status: 403 });
          const pending = await peekTaskWriteApproval(env.TASK_WRITE_APPROVALS, approvalId);
          if (pending.payloadHash !== payloadHash) return Response.json({ error: "task_write_approval_payload_mismatch" }, { status: 403 });
          const approved = await handleTaskWriteProxyRequest(new Request("https://task-write.internal/api/task-write", {
            method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": pending.capability,
              "x-mana-task-write-approval-id": approvalId, "x-mana-task-write-approver-id": approverId },
            body: JSON.stringify(pending.body),
          }), env);
          if (!approved.ok) return approved;
          return Response.json({ ok: true, approval_id: approvalId });
        }, async (runId) => {
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            env.TENANT_ID, env.SLACK_EXPECTED_TEAM_ID, runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(() => getWorkspace(handle), async (workspace) =>
            (await loadMeetingMinutesRun(workspace.fs, runId))?.sourceThreadTs);
        }, async (payload) => {
          const parsedTeamIds = (() => { try { return JSON.parse(env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON ?? "{}") as Record<string, string>; }
            catch { return {}; } })();
          const loadWorkspace = async <T>(runId: string, operation: (workspace: { fs: Parameters<typeof loadMeetingMinutesRun>[0] }) => Promise<T>) => {
            const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
              env.TENANT_ID, env.SLACK_EXPECTED_TEAM_ID, runId));
            const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
            return withDisposableResource(() => getWorkspace(handle), operation);
          };
          const taskClient = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
            token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (request, init) =>
              fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
          let cachedRun: MeetingMinutesRun | undefined;
          return handleMeetingMinutesTaskAction(payload, { sourceTeamId: env.SLACK_EXPECTED_TEAM_ID,
            destinationTeamIds: parsedTeamIds,
            destinations: config.destinations,
            operatorUserIds: config.operatorUserIds,
            loadRun: async (runId) => { cachedRun = await loadWorkspace(runId, (workspace) => loadMeetingMinutesRun(workspace.fs, runId)); return cachedRun; },
            saveRun: (run) => loadWorkspace(run.runId, async (workspace) => { await saveMeetingMinutesRun(workspace.fs, run); }),
            getTask: (taskId) => taskClient.getTask(taskId),
            updateTask: (taskId, input, key) => taskClient.updateTask(taskId, input, key),
            deleteTask: (taskId, version, key) => taskClient.deleteTask(taskId, version, key),
            updateCard: async (run) => {
              const token = resolveMeetingMinutesDestinationSlackToken(env, run.destination!.organization.id);
              const client = new MeetingMinutesSlackClient(token);
              await client.updateTaskCard(run); },
            notifyScopeMismatch: async (run, userId) => {
              const token = resolveMeetingMinutesDestinationSlackToken(env, run.destination!.organization.id);
              await new MeetingMinutesSlackClient(token).postTaskScopeMismatch(run, userId);
            },
            openView: async (organizationId, triggerId, view) => {
              const token = resolveMeetingMinutesDestinationSlackToken(env, organizationId);
              await new MeetingMinutesSlackClient(token).openTaskEditView(triggerId, view);
            }, listPeople: () => listGraphPeople(undefined, {
              baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
              token: env.BRAINBASE_GRAPH_API_TOKEN,
            }), repairTaskBoard: (targetId) => enqueueMeetingMinutesTaskBoardRepair(
              env, targetId, "task_write",
            ), defer: (work) => ctx.waitUntil(work),
          });
        }, () => meetingMinutesDeploymentGate(env).isIntakePaused(), async (payload) => {
          const event = parseContractLedgerSlackAction(payload, contractLedgerConfig(env));
          if (!event) return undefined;
          await env.CONTRACT_LEDGER_SYNCS.send(event);
          return Response.json({ ok: true, queued: true, decision: event.decision, envelope_id: event.envelopeId });
        });
    }
    if (request.method === "POST" && url.pathname === "/slack/commands") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const developmentPlacements = placements.filter((placement) => placement.developmentEnabled === true);
      return handleSlackCommandRequest(request, { signingSecret: env.SLACK_SIGNING_SECRET, tenantId: env.TENANT_ID,
        expectedTeamId: env.SLACK_EXPECTED_TEAM_ID,
        placements: developmentPlacements.map((placement) => ({ channelId: placement.channelId,
          allowedUserIds: placement.audience?.allowedUserIds ?? [] })),
        send: (event) => env.TECHKNIGHT_EVENTS.send(event) });
    }
    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return handleSlackRequest(request, {
      signingSecret: env.SLACK_SIGNING_SECRET,
      tenantId: env.TENANT_ID,
      expectedTeamId: env.SLACK_EXPECTED_TEAM_ID,
      expectedAppId: env.SLACK_EXPECTED_APP_ID,
      intercept: async (event) => {
        const config = meetingMinutesRuntimeConfig(env);
        if (!isMeetingMinutesRouterFileEvent(event, config.routerChannelId)) return false;
        return interceptMeetingMinutesIntakePause(event, {
          isPaused: () => meetingMinutesDeploymentGate(env).isIntakePaused(),
          notify: (channelId, threadTs) => new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "")
            .postIntakePaused(channelId, threadTs),
          defer: (work) => ctx.waitUntil(work),
          logPaused: (eventId) => console.warn(JSON.stringify({ event: "meeting_minutes_intake_paused", eventId })),
          logNotificationFailure: (eventId, error) => console.warn(JSON.stringify({
            event: "meeting_minutes_intake_pause_notice_failed", eventId,
            error: error instanceof Error ? error.message : "unexpected_error",
          })),
        });
      },
      send: (event) => env.TECHKNIGHT_EVENTS.send(event),
    });
  },

  async queue(batch: MessageBatch<SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isContractLedgerEvent(message.body)) {
        if (batch.queue === "unson-business-contract-ledger-syncs-dlq") {
          try { await notifyContractLedgerDeadLetter(message.body, env); message.ack(); }
          catch (error) {
            console.error(JSON.stringify({ event: "contract_ledger_dlq_notification_failed", runId: message.body.runId,
              error: error instanceof Error ? error.message : "unexpected_error" }));
            message.retry();
          }
          continue;
        }
        try {
          if (message.body.kind === "contract_ledger_sync") {
            const receipt = await processContractLedgerSync(message.body, env);
            console.log(JSON.stringify({ event: "contract_ledger_sync_completed", ...receipt }));
          } else {
            const outcome = await processContractLedgerApproval(message.body, env);
            console.log(JSON.stringify({ event: "contract_ledger_approval_completed", runId: message.body.runId,
              envelopeId: message.body.envelopeId, decision: message.body.decision, outcome }));
          }
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "contract_ledger_processing_failed", kind: message.body.kind,
            runId: message.body.runId, error: error instanceof Error ? error.message : "unexpected_error" }));
          message.retry();
        }
        continue;
      }
      if (isTaskBoardRepairEvent(message.body)) {
        await consumeTaskBoardRepair({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, env);
        continue;
      }
      const meetingMinutesConfig = meetingMinutesRuntimeConfig(env);
      if (isMeetingMinutesRedo(message.body)) {
        const command = message.body;
        const commandGate = await gateMeetingMinutesCommandQueueMessage({
          body: command, ack: () => message.ack(), retry: () => message.retry(),
        }, meetingMinutesCommandGateDependencies(env, meetingMinutesConfig.enabled));
        if (commandGate === "blocked") continue;
        try {
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            env.TENANT_ID, command.workspaceId, command.runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
            const clients = meetingMinutesClients(env);
            await processMeetingMinutesRedo(workspace.fs, command, meetingMinutesConfig, clients.redo);
          });
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_redo_failed", runId: command.runId,
            error: error instanceof Error ? error.message : "unexpected_error" }));
          message.retry();
        }
        continue;
      }
      if (isMeetingMinutesRecovery(message.body)) {
        const recovery = message.body;
        try {
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            env.TENANT_ID, recovery.workspaceId, recovery.runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          const outcome = await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
            const clients = meetingMinutesClients(env);
            return recoverStaleMeetingMinutesRun(workspace.fs, recovery, {
              updateStatus: (run, status) => clients.slack.updateRunStatus(run, status),
            });
          });
          if (outcome === "not_due") {
            await env.TECHKNIGHT_EVENTS.send(recovery, { delaySeconds: 60 });
          } else if (outcome !== "superseded") {
            await meetingMinutesDeploymentGate(env).markTerminal(recovery.runId);
          }
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_recovery_failed", runId: recovery.runId,
            error: error instanceof Error ? error.message : "unexpected_error" }));
          message.retry();
        }
        continue;
      }
      if (isMeetingMinutesSelection(message.body)) {
        const selection = message.body;
        if (selection.workspaceId !== env.SLACK_EXPECTED_TEAM_ID ||
          selection.channelId !== meetingMinutesConfig.routerChannelId) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_boundary_mismatch", runId: selection.runId }));
          message.ack();
          continue;
        }
        const commandGate = await gateMeetingMinutesCommandQueueMessage({
          body: selection, ack: () => message.ack(), retry: () => message.retry(),
        }, meetingMinutesCommandGateDependencies(env, meetingMinutesConfig.enabled));
        if (commandGate === "blocked") continue;
        let failedMeetingMinutesRun: MeetingMinutesRun | undefined;
        try {
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            env.TENANT_ID, selection.workspaceId, selection.runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
            const clients = meetingMinutesClients(env);
            const armed = await armMeetingMinutesRecovery(workspace.fs, selection);
            if (!armed.terminal) {
              await meetingMinutesDeploymentGate(env).markActive({ runId: selection.runId,
                startedAt: new Date().toISOString(),
                deadlineAt: new Date(Date.now() + armed.delaySeconds * 1_000).toISOString() });
              await env.TECHKNIGHT_EVENTS.send(armed.event, {
                delaySeconds: Math.min(armed.delaySeconds, MEETING_MINUTES_RECOVERY_DELAY_SECONDS),
              });
            }
            try {
              await processMeetingMinutesSelectionWithStatus(workspace.fs, selection, meetingMinutesConfig, clients.resume, {
                updateStatus: (run, outcome) => clients.slack.updateRunStatus(run, outcome),
                logProjectionError: (entry) => console.warn(JSON.stringify({ event: "meeting_minutes_status_projection_failed", ...entry })),
              });
            } catch (error) {
              const persisted = await loadMeetingMinutesRun(workspace.fs, selection.runId);
              failedMeetingMinutesRun = persisted;
              if (persisted?.status === "completed" || persisted?.lifecycle?.recoveryProjectedAt) {
                await meetingMinutesDeploymentGate(env).markTerminal(selection.runId);
              }
              throw error;
            }
          });
          await meetingMinutesDeploymentGate(env).markTerminal(selection.runId);
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_failed",
            ...(failedMeetingMinutesRun ? meetingMinutesFailureLog(failedMeetingMinutesRun) : {
              runId: selection.runId, stage: "unknown", code: "UNCLASSIFIED_FAILURE", retryable: true,
            }) }));
          message.retry();
        }
        continue;
      }
      const meetingMinutesRouterGate = await gateMeetingMinutesRouterQueueMessage({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          enabled: meetingMinutesConfig.enabled,
          routerChannelId: meetingMinutesConfig.routerChannelId,
          isPaused: () => meetingMinutesDeploymentGate(env).isIntakePaused(),
          notify: (channelId, threadTs) => meetingMinutesClients(env).slack.postIntakePaused(channelId, threadTs),
          logPaused: (eventId) => console.warn(JSON.stringify({ event: "meeting_minutes_intake_paused", eventId })),
          logDisabled: (eventId) => console.warn(JSON.stringify({ event: "meeting_minutes_intake_disabled", eventId })),
          logNotificationFailure: (eventId, error) => console.warn(JSON.stringify({
            event: "meeting_minutes_intake_pause_notice_failed", eventId,
            error: error instanceof Error ? error.message : "unexpected_error",
          })),
        });
      if (meetingMinutesRouterGate === "blocked") continue;
      if (meetingMinutesRouterGate === "ready") {
        await consumeTechKnightMessage({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          expectedTenantId: env.TENANT_ID,
          expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
          expectedChannelId: meetingMinutesConfig.routerChannelId,
          process: async (event) => {
            for (const file of event.files ?? []) {
              if (!/\.txt$/i.test(file.name)) continue;
              const runId = `${event.eventId}_${file.id}`;
              const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
                env.TENANT_ID, event.workspaceId, runId,
              ));
              const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
              await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
                const clients = meetingMinutesClients(env);
                await processMeetingMinutesSlackEvent(workspace.fs, { ...event, files: [file] }, meetingMinutesConfig, {
                  download: (fileId) => clients.slack.downloadTextFile(fileId),
                  classifyDestination: (transcript, destinations) => clients.classify(transcript, destinations),
                  requestDestination: (run, destinations) => clients.slack.requestDestination(run, destinations),
                });
              });
            }
            return { outcome: "awaiting_destination" };
          },
          log: (entry) => console.log(JSON.stringify(entry)),
          logError: (entry) => console.error(JSON.stringify(entry)),
          errorCode: (error) => error instanceof Error ? error.message : "unexpected_error",
        });
        continue;
      }
      const ordinaryEvent = message.body as SlackQueueEvent;
      const ordinaryPlacements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      let resolvedPlacement;
      try {
        resolvedPlacement = resolveRuntimePlacement(ordinaryEvent, {
          tenantId: env.TENANT_ID,
          workspaceId: env.SLACK_EXPECTED_TEAM_ID,
          placements: ordinaryPlacements,
        });
      } catch (error) {
        console.log(JSON.stringify({ event: "techknight_slack_reply_ignored", eventId: ordinaryEvent.eventId,
          channelId: ordinaryEvent.channelId,
          reason: error instanceof RuntimeBindingError ? error.code : "placement_not_allowed" }));
        message.ack();
        continue;
      }
      await consumeTechKnightMessage({
        body: message.body as SlackQueueEvent,
        ack: () => message.ack(),
        retry: () => message.retry(),
      }, {
        // Every ordinary reply must belong to an explicit placement. The
        // meeting-minutes router is also a normal Lightsail placement.
        expectedTenantId: env.TENANT_ID,
        expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
        expectedChannelIds: [resolvedPlacement.channelId],
        operatorUserIds: resolvedPlacement.audience?.allowedUserIds,
        process: async (event) => {
          const placement = resolvedPlacement;
          const placementClaudeRuntime = resolveClaudeRuntimeConfig(env, placement.agent?.model);
          const trace: TurnRuntimeTrace = { placementId: placement.placementId, projectCodes: placement.projectCodes,
            actorIdHash: await actorIdHash(event), workerVersion: env.CF_VERSION_METADATA?.id,
            model: placementClaudeRuntime.model, effort: placementClaudeRuntime.effort };
          emitTurnLog("log", "mana_turn_received", event, trace, { outcome: "accepted", eventType: event.eventType });
          emitTurnLog("log", "mana_placement_resolved", event, trace, { outcome: "resolved", taskWriteEnabled: placement.taskWriteEnabled });
          await upsertRuntimeSession(env.RUNTIME_SESSION_REGISTRY, {
            sessionId: workspaceName(event), placementId: placement.placementId, workspaceId: event.workspaceId,
            channelId: event.channelId, threadTs: event.threadTs, ...(event.userId ? { requesterId: event.userId } : {}),
            status: "active", updatedAt: event.receivedAt,
          });
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const workspaceStub = env.TECHKNIGHT_WORKSPACE.get(id);
          const deliveryId = runtimeDeliveryId(event);
          let deliveryClaimed = false;
          const handle = workspaceStub as unknown as WorkspaceHandle;
          try {
            const result = await withDisposableResource(
              () => getWorkspace(handle),
              async (workspace) => {
              await persistEventOnce(workspace.fs, event);
               await reconcilePermissionRevision(workspace.fs, placement.permissionRevision ?? "legacy-v1", event.receivedAt);
               const workspaceSession = await readWorkspaceSession(workspace.fs);
              const replyEligible = isReplyEligible(event, {
                expectedTenantId: env.TENANT_ID,
                expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                allowedChannelId: placement.channelId,
                respondPolicy: placement.respondTo,
                isEngagedThread: workspaceSession.engaged === true,
                botAttributedAppMentionUserIds: placement.audience?.allowedUserIds,
              });
              // Slack may emit an ordinary message before the app_mention for the
              // same post. An ineligible variant must never claim the shared
              // message delivery id and suppress the eligible variant.
              const ambientTriageCandidate = event.eventType === "message"
                && event.channelType !== "im"
                && Boolean(event.userId)
                && !event.botId
                && event.subtype !== "bot_message";
              if (!replyEligible && !ambientTriageCandidate) return { outcome: "ignored" as const };
              if (!await workspaceStub.claimRuntimeEvent(deliveryId)) {
                return { outcome: "already_processing" as const };
              }
              deliveryClaimed = true;
              const sessionModel = workspaceSession.modelOverride;
              const claudeRuntime = resolveClaudeRuntimeConfig(
                env,
                sessionModel === "opus" || sessionModel === "sonnet"
                  ? sessionModel
                  : placementClaudeRuntime.model,
              );
              let controlCommand;
              try {
                controlCommand = parseRuntimeControlCommand(event.text);
              } catch (error) {
                if (!(error instanceof RuntimeControlCommandError)) throw error;
                const responseTs = await postSlackReply(event, renderRuntimeControlCommandError(error), { slackBotToken: env.SLACK_BOT_TOKEN });
                await persistReplyCompletion(workspace.fs, {
                  eventId: event.eventId,
                  responseTs,
                  completedAt: new Date().toISOString(),
                });
                await markWorkspaceEngaged(workspace.fs, new Date().toISOString());
                return { outcome: "replied" as const, responseTs };
              }
              if (controlCommand) {
                if (await isReplyCompleted(workspace.fs, event.eventId)) return { outcome: "already_completed" as const };
                const text = await executeRuntimeControlCommand({
                  fs: workspace.fs,
                  command: controlCommand,
                  commandId: event.eventId,
                  requestedAt: event.receivedAt,
                  messageTs: event.messageTs,
                  placementId: placement.placementId,
                  projectCodes: placement.projectCodes,
                  currentModel: claudeRuntime.model,
                  allowedModels: ["sonnet", "opus"],
                  taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED === "true",
                  taskWriteEnabled: placement.taskWriteEnabled,
                  doctor: () => runRuntimeDoctor(env, placement.capabilities?.mcp ?? []),
                  cron: (action, target) => executeRuntimeCron({
                    fs: workspace.fs,
                    jobs: parsePlacementCronJobs(env.RUNTIME_CRON_JOBS_JSON, placement.channelId),
                    action,
                    ...(target ? { target } : {}),
                    run: async (job) => {
                      await env.TECHKNIGHT_EVENTS.send(
                        createManualCronEvent(event, job, new Date().toISOString()),
                      );
                    },
                  }),
                  develop: (request) => runCloudflareDevelopmentRequest({ request, placementId: placement.placementId,
                    requesterId: event.userId!, eventId: event.eventId, workspaceId: event.workspaceId,
                    channelId: event.channelId, threadTs: event.threadTs, callbackBaseUrl: env.DEVELOPMENT_CALLBACK_BASE_URL,
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId, "2h") }),
                });
                const responseTs = await postSlackReply(event, text, { slackBotToken: env.SLACK_BOT_TOKEN });
                await persistReplyCompletion(workspace.fs, {
                  eventId: event.eventId,
                  responseTs,
                  completedAt: new Date().toISOString(),
                });
                await markWorkspaceEngaged(workspace.fs, new Date().toISOString());
                return { outcome: "replied" as const, responseTs };
              }
              const hydrateThreadContext = async (input: SlackQueueEvent) => {
                const hydrated = await hydrateSlackQueueEventThreadContext(input, { botToken: env.SLACK_BOT_TOKEN,
                  contextAfterTs: workspaceSession.contextAfterTs });
                const withParticipants = { ...hydrated,
                  threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext,
                    { botToken: env.SLACK_BOT_TOKEN }) };
                return hydrateSlackAttachments(withParticipants, { botToken: env.SLACK_BOT_TOKEN });
              };
              return routeRuntimeEvent(event, {
                meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
                processMeetingTask: () => {
                  const binding = placement;
                  return processMeetingTaskEvent(workspace.fs, event, {
                    binding,
                    brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
                    brainbaseTaskToken: env.BRAINBASE_TASK_API_TOKEN,
                    slackBotToken: env.SLACK_BOT_TOKEN,
                    oauthConfigured: hasAnthropicCredential(env),
                    claudeRuntime,
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                    hydrateThreadContext,
                  });
                },
                processReply: async () => runWithReplyTaskSearchBinding(event, {
                    tenantId: env.TENANT_ID,
                    workspaceId: env.SLACK_EXPECTED_TEAM_ID,
                    channelId: placement.channelId,
                    projectCodes: placement.projectCodes.join(","),
                    taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED,
                    brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
                    brainbaseTaskToken: env.BRAINBASE_TASK_API_TOKEN,
                  }, async (taskSearch) => {
                    const profileResolution = await resolveSlackUserProfile({ userId: event.userId ?? "",
                      botToken: env.SLACK_BOT_TOKEN,
                    });
                    // users.info is enrichment, not the authorization boundary. Some Slack
                    // installations intentionally omit users:read. Canonical Graph identity
                    // resolution below remains mandatory and fail-closed; a profile outage must
                    // not prevent an otherwise authorized requester from using the runtime.
                    let requesterProfile;
                    try {
                      requesterProfile = requesterProfileOrFallback(event.userId ?? "", profileResolution);
                    } catch {
                      throw new ReplyPipelineError("requester_profile_rejected");
                    }
                    const graphOptions = {
                      baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
                      token: env.BRAINBASE_GRAPH_API_TOKEN,
                    };
                    const actorIdentityResolver = resolveActorIdentityResolverFromEnv(env);
                    const mappedActor = await actorIdentityResolver?.(event);
                    const requesterResolution = mappedActor
                      ? { status: "resolved" as const, personId: mappedActor.personId }
                      : await resolveGraphRequester(
                          event.workspaceId, event.userId ?? "", placement.projectCodes[0], graphOptions,
                        );
                    if (requesterResolution.status !== "resolved") {
                      throw new ReplyPipelineError(`requester_identity_${requesterResolution.status}`);
                    }
                    const { taskWriteEnabled, taskWriteCapability } = await issueTaskWriteRequestContext(
                      event, env, Date.now(), placement, requesterResolution.personId,
                    );
                    const graphContext = await hydrateGraphContext(event, placement.projectCodes[0], graphOptions);
                    if (graphContext.status === "unavailable") {
                      throw new ReplyPipelineError("graph_context_unavailable");
                    }
                    const claudeSessionId = await deterministicRuntimeUuid(
                      `${workspaceName(event)}:generation:${workspaceSession.generation}`,
                    );
                    const replyResult = await processReplyEvent(workspace.fs, event, {
                    expectedTenantId: env.TENANT_ID,
                    expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                    allowedChannelId: placement.channelId,
                    slackBotToken: env.SLACK_BOT_TOKEN,
                    oauthConfigured: hasAnthropicCredential(env),
                    claudeRuntime,
                    taskSearchEnabled: taskSearch.taskSearchEnabled,
                    taskWriteEnabled,
                    taskWriteCapability,
                    requesterIdentity: { slackUserId: event.userId ?? "", personId: requesterResolution.personId },
                    requesterProfile,
                    graphContext: graphContext.content,
                    runtimeContext: placement.runtimeContext ? { ...placement.runtimeContext,
                      escalationEmployee: placement.agent?.escalationEmployee } : undefined,
                    capabilities: placement.capabilities,
                    resolveActorIdentity: actorIdentityResolver,
                    trace: { ...trace, model: claudeRuntime.model, effort: claudeRuntime.effort },
                    respondPolicy: placement.respondTo,
                    isEngagedThread: workspaceSession.engaged === true,
                    botAttributedAppMentionUserIds: placement.audience?.allowedUserIds,
                    triage: async (triageEvent) => {
                      const hydrated = await hydrateThreadContext(triageEvent);
                      const recentThread = (hydrated.threadContext ?? "").split("\n").filter(Boolean).slice(-10)
                        .map((text) => ({ speaker: "thread", text }));
                      const decision = await runRuntimeTriage({
                        botName: "まな",
                        persona: placement.runtimeContext?.persona,
                        speakerName: requesterProfile.displayName ?? requesterProfile.realName ?? requesterProfile.handle ?? "Slack user",
                        channelType: triageEvent.channelType ?? "channel",
                        messageText: triageEvent.text,
                        attachmentNames: triageEvent.files?.map((file) => file.name),
                        recentThread,
                      }, {
                        model: claudeRuntime.model,
                        effort: claudeRuntime.effort,
                        createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                      });
                      emitTurnLog("log", "mana_triage_decided", triageEvent, trace, {
                        outcome: decision.action,
                        reasonCode: decision.reason,
                      });
                      return decision;
                    },
                    claudeSession: {
                      id: claudeSessionId,
                      sandboxId: `techknight-session-${claudeSessionId}`,
                      resume: workspaceSession.claudeSessionStartedGeneration === workspaceSession.generation,
                    },
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                    hydrateThreadContext,
                    });
                    if (replyResult.outcome === "replied") {
                      await markClaudeSessionStarted(workspace.fs, workspaceSession.generation, new Date().toISOString());
                    }
                    return replyResult;
                  }),
              });
              },
            );
            if (deliveryClaimed) await workspaceStub.completeRuntimeEvent(deliveryId,
              "responseTs" in result && typeof result.responseTs === "string" ? result.responseTs : undefined);
            return result;
          } catch (error) {
            const replyPersisted = deliveryClaimed && await withDisposableResource(
              () => getWorkspace(handle),
              (currentWorkspace) => isReplyCompleted(currentWorkspace.fs, event.eventId),
            ).catch(() => false);
            if (replyPersisted) {
              await workspaceStub.completeRuntimeEvent(deliveryId).catch(() => undefined);
              return { outcome: "already_completed" as const };
            }
            if (deliveryClaimed) await workspaceStub.releaseRuntimeEvent(deliveryId);
            throw error;
          }
        },
        log: (entry) => console.log(JSON.stringify(entry)),
        logError: (entry) => console.error(JSON.stringify(entry)),
        errorCode: runtimeErrorCode,
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(env);
    await enqueueScheduledContractLedgerSync(controller, env);
  },
} satisfies ExportedHandler<Env, SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>;
