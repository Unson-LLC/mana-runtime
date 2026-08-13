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
import { signTaskWriteCapability } from "@openryoko/write-broker";
import { parseRuntimeProjectCodes } from "./runtime-config.js";
import {
  isTaskBoardRepairEvent,
  refreshTaskBoard,
  type TaskBoardRepairEvent,
} from "./task-board.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";

interface Env extends SandboxRuntimeEnv {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  SLACK_BOT_TOKEN?: string;
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
  TECHKNIGHT_EVENTS: Queue<SlackQueueEvent>;
  TASK_BOARD_REPAIRS: Queue<TaskBoardRepairEvent>;
  TECHKNIGHT_WORKSPACE: DurableObjectNamespace<TechKnightWorkspace>;
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

function workspaceName(event: SlackQueueEvent): string {
  return [event.tenantId, event.workspaceId, event.channelId, event.threadTs].join(":");
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
      });
    }
    if (url.pathname.startsWith("/admin/sandbox/")) {
      return handleSandboxAdminRequest(request, env, {
        createSandbox: (id) => createTechKnightSandbox(env, id),
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

  async queue(batch: MessageBatch<SlackQueueEvent | TaskBoardRepairEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (isTaskBoardRepairEvent(message.body)) {
        try {
          const repair = message.body;
          if (
            repair.tenantId !== env.TENANT_ID ||
            repair.workspaceId !== env.SLACK_EXPECTED_TEAM_ID ||
            repair.channelId !== env.SLACK_ALLOWED_CHANNEL_ID
          ) {
            console.error(JSON.stringify({ event: "task_board_repair_rejected", reason: "scope_mismatch" }));
            message.ack();
            continue;
          }
          await refreshTaskBoard(env);
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "task_board_repair_failed", code: error instanceof Error ? error.message : "unknown" }));
          message.retry();
        }
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
                    const taskWriteEnabled = env.RUNTIME_TASK_WRITE_ENABLED === "true";
                    const taskWriteCapability = taskWriteEnabled && env.TASK_WRITE_CAPABILITY_SECRET
                      ? await signTaskWriteCapability({
                          version: 1,
                          audience: "mana-task-write",
                          requestId: event.eventId,
                          actor: { provider: "slack", id: event.userId!, workspace: event.workspaceId },
                          placementId: env.RUNTIME_PLACEMENT_ID ?? "",
                          projects: parseRuntimeProjectCodes(env.RUNTIME_PROJECT_CODES),
                          operations: ["task.create", "task.update", "task.transition"],
                          expiresAt: Date.now() + 180_000,
                          nonce: event.eventId,
                          budget: 3,
                        }, env.TASK_WRITE_CAPABILITY_SECRET)
                      : undefined;
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
    if (env.RUNTIME_TASK_BOARD_ENABLED !== "true") return;
    await env.TASK_BOARD_REPAIRS.send({
      eventType: "task_board_repair",
      tenantId: env.TENANT_ID,
      workspaceId: env.SLACK_EXPECTED_TEAM_ID,
      channelId: env.SLACK_ALLOWED_CHANNEL_ID,
      reason: "scheduled",
      requestedAt: new Date().toISOString(),
    });
  },
} satisfies ExportedHandler<Env, SlackQueueEvent | TaskBoardRepairEvent>;
