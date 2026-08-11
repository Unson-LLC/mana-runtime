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
import { consumeTechKnightMessage } from "./queue-consumer.js";
import { persistEventOnce } from "./workspace-store.js";
import { withDisposableResource } from "./disposable-resource.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";

interface Env extends SandboxRuntimeEnv {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  SLACK_BOT_TOKEN?: string;
  TENANT_ID: "techknight";
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
      return Response.json({ ok: true, tenant: "techknight" });
    }
    if (url.pathname.startsWith("/admin/sandbox/")) {
      return handleSandboxAdminRequest(request, env, {
        createSandbox: (id) => createTechKnightSandbox(env, id),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (env.TENANT_ID !== "techknight") {
      return Response.json({ error: "tenant_configuration_invalid" }, { status: 503 });
    }

    return handleSlackRequest(request, {
      signingSecret: env.SLACK_SIGNING_SECRET,
      expectedTeamId: env.SLACK_EXPECTED_TEAM_ID,
      send: (event) => env.TECHKNIGHT_EVENTS.send(event),
    });
  },

  async queue(batch: MessageBatch<SlackQueueEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await consumeTechKnightMessage(message, {
        expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
        process: async (event) => {
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          return withDisposableResource(
            () => getWorkspace(handle),
            async (workspace) => {
              await persistEventOnce(workspace.fs, event);
              return processReplyEvent(workspace.fs, event, {
                expectedWorkspaceId: env.SLACK_EXPECTED_TEAM_ID,
                allowedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
                slackBotToken: env.SLACK_BOT_TOKEN,
                oauthConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
              });
            },
          );
        },
        log: (entry) => console.log(JSON.stringify(entry)),
        logError: (entry) => console.error(JSON.stringify(entry)),
        errorCode: (error) => error instanceof ReplyPipelineError
          ? error.code
          : "unexpected_error",
      });
    }
  },
} satisfies ExportedHandler<Env, SlackQueueEvent>;
