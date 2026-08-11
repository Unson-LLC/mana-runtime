import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { handleSlackRequest } from "./slack.js";
import type { SlackQueueEvent } from "./types.js";
import { persistEventOnce } from "./workspace-store.js";

interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_EXPECTED_TEAM_ID: string;
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

function isTechKnightEvent(event: SlackQueueEvent, env: Env): boolean {
  return (
    env.TENANT_ID === "techknight" &&
    event.tenantId === "techknight" &&
    event.workspaceId === env.SLACK_EXPECTED_TEAM_ID
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, tenant: "techknight" });
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
      const event = message.body;
      if (!isTechKnightEvent(event, env)) {
        message.ack();
        continue;
      }

      try {
        const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
        const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
        using workspace = await getWorkspace(handle);
        await persistEventOnce(workspace.fs, event);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SlackQueueEvent>;
