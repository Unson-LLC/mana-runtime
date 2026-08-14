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
import { processReplyEvent, ReplyPipelineError } from "./reply-pipeline.js";
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
import { persistEventOnce } from "./workspace-store.js";
import { hydrateSlackQueueEventThreadContext } from "./slack-thread-context.js";
import { withDisposableResource } from "./disposable-resource.js";
import { resolveClaudeRuntimeConfig } from "./claude-runtime-config.js";
import {
  consumeTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import {
  actorIdHash,
  emitTurnLog,
  type TurnRuntimeTrace,
} from "./turn-observability.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
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
  CF_VERSION_METADATA?: { id: string; tag?: string };
  TENANT_ID: string;
  TECHKNIGHT_EVENTS: Queue<SlackQueueEvent | MeetingMinutesSelection>;
  TASK_BOARD_REPAIRS: Queue<TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS: DurableObjectNamespace;
  TASK_WRITE_APPROVALS: DurableObjectNamespace;
  TECHKNIGHT_WORKSPACE: DurableObjectNamespace<TechKnightWorkspace>;
  MEETING_MINUTES_WORKSPACE: DurableObjectNamespace<MeetingMinutesWorkspace>;
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
  return [event.tenantId, event.workspaceId, event.channelId, event.threadTs].join(":");
}

function meetingMinutesWorkspaceName(tenantId: string, workspaceId: string, runId: string): string {
  return [tenantId, workspaceId, "meeting-minutes", runId].join(":");
}

function runtimeErrorCode(error: unknown): string {
  if (error instanceof ReplyPipelineError) return error.code;
  if (
    typeof error === "object" && error !== null &&
    typeof (error as { code?: unknown }).code === "string"
  ) return (error as { code: string }).code;
  return "unexpected_error";
}

function meetingMinutesClients(env: Env) {
  const slack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "");
  const unsonSlack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN_UNSON ?? "");
  const techKnightSlack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN_TECHKNIGHT ?? "");
  const github = new CloudflareMeetingMinutesGitHubClient(env.GITHUB_TOKEN ?? "");
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const destinations = meetingMinutesRuntimeConfig(env).destinations;
  const unsonChannels = new Set(destinations
    .filter((destination) => destination.organization.id === "unson")
    .map((destination) => destination.slackChannelId));
  const techKnightChannels = new Set(destinations
    .filter((destination) => destination.organization.id === "tech-knight")
    .map((destination) => destination.slackChannelId));
  const destinationSlack = (channelId: string) => {
    if (unsonChannels.has(channelId)) return unsonSlack;
    if (techKnightChannels.has(channelId)) return techKnightSlack;
    return slack;
  };
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
          log: (entry) => console.log(entry),
          logError: (entry) => console.error(entry),
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
        process: async (event) => {
          const placement = resolveRuntimePlacement(event, {
            tenantId: env.TENANT_ID,
            workspaceId: env.SLACK_EXPECTED_TEAM_ID,
            placements: parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON),
          });
          const claudeRuntime = resolveClaudeRuntimeConfig(env);
          const trace: TurnRuntimeTrace = {
            placementId: placement.placementId,
            projectCodes: placement.projectCodes,
            actorIdHash: await actorIdHash(event),
            workerVersion: env.CF_VERSION_METADATA?.id,
            model: claudeRuntime.model,
            effort: claudeRuntime.effort,
          };
          emitTurnLog("log", "mana_turn_received", event, trace, {
            outcome: "accepted",
            eventType: event.eventType,
          });
          emitTurnLog("log", "mana_placement_resolved", event, trace, {
            outcome: "resolved",
            taskWriteEnabled: placement.taskWriteEnabled,
          });
          emitTurnLog("log", "mana_identity_context", event, trace, {
            outcome: event.userId ? "not_injected" : "missing_actor",
            reasonCode: event.userId ? "actor_context_not_injected" : "slack_user_id_missing",
          });
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(
            () => getWorkspace(handle),
            async (workspace) => {
              await persistEventOnce(workspace.fs, event);
              const hydrateThreadContext = (input: SlackQueueEvent) => (
                hydrateSlackQueueEventThreadContext(input, { botToken: env.SLACK_BOT_TOKEN })
              );
              try {
                const result = await routeRuntimeEvent(event, {
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
                      createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                      hydrateThreadContext,
                      trace,
                    });
                  }),
                });
                emitTurnLog("log", "mana_turn_completed", event, trace, {
                  outcome: result.outcome,
                });
                return result;
              } catch (error) {
                emitTurnLog("error", "mana_turn_failed", event, trace, {
                  outcome: "error",
                  reasonCode: runtimeErrorCode(error),
                });
                throw error;
              }
            },
          );
        },
        log: (entry) => console.log(entry),
        logError: (entry) => console.error(entry),
        errorCode: runtimeErrorCode,
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(env);
  },
} satisfies ExportedHandler<Env, SlackQueueEvent | MeetingMinutesSelection | TaskBoardRepairEvent>;
