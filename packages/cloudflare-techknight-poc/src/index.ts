import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { handleSlackRequest } from "./slack.js";
import {
  handleSandboxAdminRequest,
} from "./sandbox-admin.js";
import {
  createTechKnightSandbox,
  type SandboxRuntimeEnv,
} from "./sandbox-runtime.js";
import type { SlackQueueEvent } from "./types.js";
import {
  isMeetingMinutesSelection,
  isMeetingMinutesSlackEvent,
  meetingMinutesRuntimeConfig,
  processMeetingMinutesSlackEvent,
  type MeetingMinutesEnvironment,
} from "./meeting-minutes-entrypoints.js";
import type { MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { handleMeetingMinutesInteractionEntrypoint } from "./slack-interactions.js";
import { processMeetingMinutesSelectionWithStatus } from "./meeting-minutes-lifecycle.js";
import { handleTaskWriteProxyRequest } from "./task-write-proxy.js";
import { peekTaskWriteApproval } from "./task-write-approval.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import { CloudflareMeetingMinutesGitHubClient } from "./meeting-minutes-github.js";
import { generateMeetingMinutesInSandbox } from "./meeting-minutes-generator.js";
import { TaskApiClient } from "@openryoko/task-runtime-core";
import { isReplyEligible, postSlackReply, processReplyEvent, ReplyPipelineError } from "./reply-pipeline.js";
import {
  processMeetingTaskEvent,
} from "./meeting-task-pipeline.js";
import {
  parseRuntimePlacements,
  resolveRuntimePlacement,
  runWithReplyTaskSearchBinding,
} from "./runtime-config.js";
import { routeRuntimeEvent } from "./runtime-event-router.js";
import { consumeTechKnightMessage } from "./queue-consumer.js";
import { isReplyCompleted, persistEventOnce, persistReplyCompletion } from "./workspace-store.js";
import { hydrateSlackQueueEventThreadContext } from "./slack-thread-context.js";
import { withDisposableResource } from "./disposable-resource.js";
import { resolveClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { resolveSlackUserProfile } from "./slack-user-profile.js";
import { runtimeWorkspaceName } from "./runtime-workspace-key.js";
import { executeRuntimeControlCommand, parseRuntimeControlCommand } from "./runtime-control-command.js";
import { readWorkspaceSession } from "./workspace-session.js";
import { runRuntimeDoctor } from "./runtime-doctor.js";
import { executeRuntimeCron, parsePlacementCronJobs } from "./runtime-cron.js";
import { handleSlackCommandRequest } from "./slack-command.js";
import { runRemoteDevelopmentRequest } from "./development-runner-client.js";
import { handleDevelopmentCallback } from "./development-callback.js";
import { appendSlackThreadParticipantProfiles } from "./slack-thread-participants.js";
import { hydrateSlackAttachments } from "./slack-attachments.js";
import { hydrateGraphContext, resolveGraphRequester } from "./brainbase-graph-runtime.js";
import { RuntimeSessionRegistry, upsertRuntimeSession } from "./runtime-session-registry.js";
import {
  consumeTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import { actorIdHash, emitTurnLog, type TurnRuntimeTrace } from "./turn-observability.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";
export { RuntimeSessionRegistry } from "./runtime-session-registry.js";

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  RUNTIME_CRON_JOBS_JSON?: string;
  DEVELOPMENT_RUNNER_BASE_URL?: string;
  DEVELOPMENT_RUNNER_TOKEN?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
  GITHUB_TOKEN?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  RUNTIME_PROJECT_CODES?: string;
  RUNTIME_EXECUTION_MODE?: string;
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  RUNTIME_TASK_WRITE_ENABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  RUNTIME_PLACEMENT_ID?: string;
  RUNTIME_PLACEMENTS_JSON?: string;
  RUNTIME_TASK_BOARD_ENABLED?: string;
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
  BRAINBASE_SLACK_PERSON_MAP_JSON?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  TENANT_ID: string;
  TECHKNIGHT_EVENTS: Queue<SlackQueueEvent | MeetingMinutesSelection>;
  TASK_BOARD_REPAIRS: Queue<TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS: DurableObjectNamespace;
  TASK_WRITE_APPROVALS: DurableObjectNamespace;
  TECHKNIGHT_WORKSPACE: DurableObjectNamespace<TechKnightWorkspace>;
  MEETING_MINUTES_WORKSPACE: DurableObjectNamespace<MeetingMinutesWorkspace>;
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
) {}

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

function meetingMinutesClients(env: Env) {
  const slack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "");
  const techKnightSlack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN_TECHKNIGHT ?? "");
  const github = new CloudflareMeetingMinutesGitHubClient(env.GITHUB_TOKEN ?? "");
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const techKnightChannels = new Set(meetingMinutesRuntimeConfig(env).destinations
    .filter((destination) => destination.github.owner === "Tech-Knight-inc")
    .map((destination) => destination.slackChannelId));
  const destinationSlack = (channelId: string) => techKnightChannels.has(channelId) ? techKnightSlack : slack;
  return {
    slack,
    resume: {
      postProcessingStatus: (run: MeetingMinutesRun) => slack.postProcessingStatus(run),
      download: (fileId: string) => slack.downloadTextFile(fileId),
      generate: (transcript: string) => {
        if (!env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("oauth_not_configured");
        return generateMeetingMinutesInSandbox(transcript, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`));
      },
      saveGitHub: (input: Parameters<typeof github.save>[0]) => github.save(input),
      createTask: async (input: Parameters<TaskApiClient["createTask"]>[0], idempotencyKey: string) => {
        const client = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
          token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (request, init) =>
            fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
        return client.createTask(input, idempotencyKey);
      },
      postParent: (channelId: string, fileName: string, summary: string, clientMsgId: string) =>
        destinationSlack(channelId).postParent(channelId, fileName, summary, clientMsgId),
      postThreadChunk: (channelId: string, threadTs: string, fileName: string, text: string,
        index: number, total: number, clientMsgId: string) =>
        destinationSlack(channelId).postThreadChunk(channelId, threadTs, fileName, text, index, total, clientMsgId),
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
    if (request.method === "POST" && url.pathname === "/development/callback") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      let callbackEvent: SlackQueueEvent | undefined;
      return handleDevelopmentCallback(request, {
        token: env.DEVELOPMENT_CALLBACK_TOKEN, tenantId: env.TENANT_ID,
        workspaceId: env.SLACK_EXPECTED_TEAM_ID, placements,
        isCompleted: async (eventId, payload) => {
          callbackEvent = { tenantId: env.TENANT_ID, eventId, workspaceId: payload.workspace_id,
            channelId: payload.channel_id, threadTs: payload.thread_ts, messageTs: payload.thread_ts,
            userId: payload.requester_id, eventType: "development_result", text: "", receivedAt: new Date().toISOString() };
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(callbackEvent));
          return withDisposableResource(
            () => getWorkspace(env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle),
            (workspace) => isReplyCompleted(workspace.fs, eventId),
          );
        },
        persistCompleted: async (eventId, responseTs) => {
          if (!callbackEvent) throw new Error("development_callback_workspace_missing");
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(callbackEvent));
          await withDisposableResource(
            () => getWorkspace(env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle),
            (workspace) => persistReplyCompletion(workspace.fs, { eventId, responseTs, completedAt: new Date().toISOString() }),
          );
        },
        post: (event, text) => postSlackReply(event, text, { slackBotToken: env.SLACK_BOT_TOKEN }),
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      const config = meetingMinutesRuntimeConfig(env);
      return handleMeetingMinutesInteractionEntrypoint(request, env, ctx, config.operatorUserIds,
        async ({ approvalId, payloadHash, approverId, channelId }) => {
          if (channelId !== env.SLACK_ALLOWED_CHANNEL_ID) return Response.json({ error: "task_write_approval_channel_mismatch" }, { status: 403 });
          const pending = await peekTaskWriteApproval(env.TASK_WRITE_APPROVALS, approvalId);
          if (pending.payloadHash !== payloadHash) return Response.json({ error: "task_write_approval_payload_mismatch" }, { status: 403 });
          const approved = await handleTaskWriteProxyRequest(new Request("https://task-write.internal/api/task-write", {
            method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": pending.capability,
              "x-mana-task-write-approval-id": approvalId, "x-mana-task-write-approver-id": approverId },
            body: JSON.stringify(pending.body),
          }), env);
          if (!approved.ok) return approved;
          return Response.json({ ok: true, approval_id: approvalId });
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
      send: (event) => env.TECHKNIGHT_EVENTS.send(event),
    });
  },

  async queue(batch: MessageBatch<SlackQueueEvent | MeetingMinutesSelection | TaskBoardRepairEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isTaskBoardRepairEvent(message.body)) {
        await consumeTaskBoardRepair({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, env);
        continue;
      }
      const meetingMinutesConfig = meetingMinutesRuntimeConfig(env);
      if (isMeetingMinutesSelection(message.body)) {
        const selection = message.body;
        if (selection.workspaceId !== env.SLACK_EXPECTED_TEAM_ID ||
          selection.channelId !== meetingMinutesConfig.routerChannelId) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_boundary_mismatch", runId: selection.runId }));
          message.ack();
          continue;
        }
        try {
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            env.TENANT_ID, selection.workspaceId, selection.runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
            const clients = meetingMinutesClients(env);
            await processMeetingMinutesSelectionWithStatus(workspace.fs, selection, meetingMinutesConfig, clients.resume, {
              updateStatus: (run, outcome) => clients.slack.updateRunStatus(run, outcome),
              logProjectionError: (entry) => console.warn(JSON.stringify({ event: "meeting_minutes_status_projection_failed", ...entry })),
            });
          });
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "meeting_minutes_selection_failed", runId: selection.runId,
            error: error instanceof Error ? error.message : "unexpected_error" }));
          message.retry();
        }
        continue;
      }
      if (isMeetingMinutesSlackEvent(message.body, meetingMinutesConfig)) {
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
      await consumeTechKnightMessage({
        body: message.body as SlackQueueEvent,
        ack: () => message.ack(),
        retry: () => message.retry(),
      }, {
        // Every ordinary reply must belong to an explicit placement. The
        // meeting-minutes router is also a normal Lightsail placement.
        expectedTenantId: env.TENANT_ID,
        expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
        expectedChannelIds: parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON)
          .map((placement) => placement.channelId),
        operatorUserIds: parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON)
          .find((placement) => placement.channelId === message.body.channelId)
          ?.audience?.allowedUserIds,
        process: async (event) => {
          const placement = resolveRuntimePlacement(event, {
            tenantId: env.TENANT_ID,
            workspaceId: env.SLACK_EXPECTED_TEAM_ID,
            placements: parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON),
          });
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
          const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(
            () => getWorkspace(handle),
            async (workspace) => {
              await persistEventOnce(workspace.fs, event);
              const workspaceSession = await readWorkspaceSession(workspace.fs);
              const sessionModel = workspaceSession.modelOverride;
              const claudeRuntime = resolveClaudeRuntimeConfig(
                env,
                sessionModel === "opus" || sessionModel === "sonnet"
                  ? sessionModel
                  : placementClaudeRuntime.model,
              );
              const controlCommand = parseRuntimeControlCommand(event.text);
              if (controlCommand && isReplyEligible(event, {
                expectedTenantId: env.TENANT_ID,
                expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                allowedChannelId: placement.channelId,
              })) {
                if (await isReplyCompleted(workspace.fs, event.eventId)) return { outcome: "already_completed" as const };
                const text = await executeRuntimeControlCommand({
                  fs: workspace.fs,
                  command: controlCommand,
                  commandId: event.eventId,
                  requestedAt: event.receivedAt,
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
                    run: async () => { throw new Error("cron_runner_not_configured"); },
                  }),
                  develop: (request) => runRemoteDevelopmentRequest({ request, placementId: placement.placementId,
                    requesterId: event.userId!, eventId: event.eventId, workspaceId: event.workspaceId,
                    channelId: event.channelId, threadTs: event.threadTs, callbackBaseUrl: env.DEVELOPMENT_CALLBACK_BASE_URL,
                    baseUrl: env.DEVELOPMENT_RUNNER_BASE_URL, token: env.DEVELOPMENT_RUNNER_TOKEN }),
                });
                const responseTs = await postSlackReply(event, text, { slackBotToken: env.SLACK_BOT_TOKEN });
                await persistReplyCompletion(workspace.fs, {
                  eventId: event.eventId,
                  responseTs,
                  completedAt: new Date().toISOString(),
                });
                return { outcome: "replied" as const, responseTs };
              }
              const hydrateThreadContext = async (input: SlackQueueEvent) => {
                const hydrated = await hydrateSlackQueueEventThreadContext(input, { botToken: env.SLACK_BOT_TOKEN });
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
                    oauthConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
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
                    const { taskWriteEnabled, taskWriteCapability } = await issueTaskWriteRequestContext(event, env, Date.now(), placement);
                    const profileResolution = await resolveSlackUserProfile({ userId: event.userId ?? "",
                      botToken: env.SLACK_BOT_TOKEN,
                    });
                    if (profileResolution.status !== "resolved") {
                      throw new ReplyPipelineError(profileResolution.status === "rejected"
                        ? "requester_profile_rejected" : "requester_profile_unavailable");
                    }
                    const graphOptions = {
                      baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
                      token: env.BRAINBASE_GRAPH_API_TOKEN,
                    };
                    const requesterResolution = await resolveGraphRequester(
                      event.workspaceId, event.userId ?? "", placement.projectCodes[0], graphOptions,
                    );
                    if (requesterResolution.status !== "resolved") {
                      throw new ReplyPipelineError(`requester_identity_${requesterResolution.status}`);
                    }
                    const graphContext = await hydrateGraphContext(event, placement.projectCodes[0], graphOptions);
                    if (graphContext.status === "unavailable") {
                      throw new ReplyPipelineError("graph_context_unavailable");
                    }
                    return processReplyEvent(workspace.fs, event, {
                    expectedTenantId: env.TENANT_ID,
                    expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                    allowedChannelId: placement.channelId,
                    slackBotToken: env.SLACK_BOT_TOKEN,
                    oauthConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                    claudeRuntime,
                    taskSearchEnabled: taskSearch.taskSearchEnabled,
                    taskWriteEnabled,
                    taskWriteCapability,
                    requesterIdentity: { slackUserId: event.userId ?? "", personId: requesterResolution.personId },
                    requesterProfile: profileResolution.profile,
                    graphContext: graphContext.content,
                    capabilities: placement.capabilities,
                    trace: { ...trace, model: claudeRuntime.model, effort: claudeRuntime.effort },
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                    hydrateThreadContext,
                    });
                  }),
              });
            },
          );
        },
        log: (entry) => console.log(JSON.stringify(entry)),
        logError: (entry) => console.error(JSON.stringify(entry)),
        errorCode: runtimeErrorCode,
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(env);
  },
} satisfies ExportedHandler<Env, SlackQueueEvent | MeetingMinutesSelection | TaskBoardRepairEvent>;
