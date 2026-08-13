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
  processMeetingMinutesSelection,
  processMeetingMinutesSlackEvent,
  type MeetingMinutesEnvironment,
} from "./meeting-minutes-entrypoints.js";
import type { MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { handleMeetingMinutesInteraction } from "./slack-interactions.js";
import { handleTaskWriteProxyRequest } from "./task-write-proxy.js";
import { peekTaskWriteApproval } from "./task-write-approval.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import { CloudflareMeetingMinutesGitHubClient } from "./meeting-minutes-github.js";
import { generateMeetingMinutesInSandbox } from "./meeting-minutes-generator.js";
import { processReplyEvent, ReplyPipelineError } from "./reply-pipeline.js";
import {
  processMeetingTaskEvent,
} from "./meeting-task-pipeline.js";
import {
  resolveRuntimeBinding,
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

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
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
  RUNTIME_TASK_BOARD_ENABLED?: string;
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
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
      download: (fileId: string) => slack.downloadTextFile(fileId),
      generate: (transcript: string) => {
        if (!env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("oauth_not_configured");
        return generateMeetingMinutesInSandbox(transcript, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`));
      },
      saveGitHub: (input: Parameters<typeof github.save>[0]) => github.save(input),
      postParent: (channelId: string, text: string, clientMsgId: string) =>
        destinationSlack(channelId).postParent(channelId, text, clientMsgId),
      postThreadChunk: (channelId: string, threadTs: string, text: string, clientMsgId: string) =>
        destinationSlack(channelId).postThreadChunk(channelId, threadTs, text, clientMsgId),
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      return handleMeetingMinutesInteraction(request, {
        signingSecret: env.SLACK_SIGNING_SECRET,
        expectedTeamId: env.SLACK_EXPECTED_TEAM_ID,
        expectedAppId: env.SLACK_EXPECTED_APP_ID,
        operatorUserIds: config.operatorUserIds,
        send: (selection) => env.TECHKNIGHT_EVENTS.send(selection),
        approveTaskWrite: async ({ approvalId, payloadHash, approverId, channelId }) => {
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
        },
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
            await processMeetingMinutesSelection(workspace.fs, selection, meetingMinutesConfig, clients.resume);
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
        expectedTenantId: env.TENANT_ID,
        expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
        expectedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
        process: async (event) => {
          const claudeRuntime = resolveClaudeRuntimeConfig(env);
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(
            () => getWorkspace(handle),
            async (workspace) => {
              await persistEventOnce(workspace.fs, event);
              const hydrateThreadContext = (input: SlackQueueEvent) => (
                hydrateSlackQueueEventThreadContext(input, { botToken: env.SLACK_BOT_TOKEN })
              );
              return routeRuntimeEvent(event, {
                meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
                processMeetingTask: () => {
                  const binding = resolveRuntimeBinding(event, {
                    tenantId: env.TENANT_ID,
                    workspaceId: env.SLACK_EXPECTED_TEAM_ID,
                    channelId: env.SLACK_ALLOWED_CHANNEL_ID,
                    projectCodes: env.RUNTIME_PROJECT_CODES,
                  });
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
                    channelId: env.SLACK_ALLOWED_CHANNEL_ID,
                    projectCodes: env.RUNTIME_PROJECT_CODES,
                    taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED,
                    brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
                    brainbaseTaskToken: env.BRAINBASE_TASK_API_TOKEN,
                  }, async (taskSearch) => {
                    const { taskWriteEnabled, taskWriteCapability } = await issueTaskWriteRequestContext(event, env);
                    return processReplyEvent(workspace.fs, event, {
                    expectedTenantId: env.TENANT_ID,
                    expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                    allowedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
                    slackBotToken: env.SLACK_BOT_TOKEN,
                    oauthConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                    claudeRuntime,
                    taskSearchEnabled: taskSearch.taskSearchEnabled,
                    taskWriteEnabled,
                    taskWriteCapability,
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
        errorCode: (error) => {
          if (error instanceof ReplyPipelineError) return error.code;
          if (
            typeof error === "object" && error !== null &&
            typeof (error as { code?: unknown }).code === "string"
          ) return (error as { code: string }).code;
          return "unexpected_error";
        },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(env);
  },
} satisfies ExportedHandler<Env, SlackQueueEvent | MeetingMinutesSelection | TaskBoardRepairEvent>;
