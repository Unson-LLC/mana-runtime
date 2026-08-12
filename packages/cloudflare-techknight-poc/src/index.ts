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
import { resolveRuntimeBinding } from "./runtime-config.js";
import { routeRuntimeEvent } from "./runtime-event-router.js";
import { consumeTechKnightMessage } from "./queue-consumer.js";
import { persistEventOnce } from "./workspace-store.js";
import { withDisposableResource } from "./disposable-resource.js";

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
  TENANT_ID: string;
  TECHKNIGHT_EVENTS: Queue<SlackQueueEvent>;
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

  async queue(batch: MessageBatch<SlackQueueEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await consumeTechKnightMessage(message, {
        expectedTenantId: env.TENANT_ID,
        expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
        expectedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
        process: async (event) => {
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(
            () => getWorkspace(handle),
            async (workspace) => {
              await persistEventOnce(workspace.fs, event);
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
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                  });
                },
                processReply: () => processReplyEvent(workspace.fs, event, {
                  expectedTenantId: env.TENANT_ID,
                  expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                  allowedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
                  slackBotToken: env.SLACK_BOT_TOKEN,
                  oauthConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                  createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
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
} satisfies ExportedHandler<Env, SlackQueueEvent>;
