import { tenantBoundaryCredentialMarker } from "./multitenancy/durable-tenant-boundary.js";
import { tenantPartitionKey } from "./multitenancy/isolation.js";
import { freshTenantContainerId } from "./multitenancy/container-lifecycle.js";

const DEVELOPMENT_PROCESS_MAX_TIMEOUT_MS = 4_800_000;
const TENANT_CONTEXT_SHUTDOWN_RESERVE_MS = 5_000;
const DEVELOPMENT_CALLBACK_RESERVE_MS = 10_000;

export interface DevelopmentSandbox {
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(command: string, options: {
    processId: string;
    autoCleanup: boolean;
    timeout: number;
    env?: Record<string, string | undefined>;
  }): Promise<{ id: string }>;
}

function authenticatedHttpsBase(value: string | undefined): URL {
  if (!value) throw new Error("development_runner_not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("development_runner_not_configured");
  }
  return url;
}

async function jobIdForTenantOperation(input: {
  eventId: string;
  tenantId: string;
  connectionId: string;
  operationId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
}): Promise<string> {
  const { eventId } = input;
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(eventId)) {
    throw new Error("development_runner_invalid_event_id");
  }
  const partition = tenantPartitionKey({
    tenant_id: input.tenantId,
    resource_type: "session",
    connection_id: input.connectionId,
    workspace_id: input.workspaceId,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    resource_id: `${input.operationId}:${eventId}`,
  });
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(partition),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `development-${encoded}`;
}

export async function runCloudflareDevelopmentRequest(input: {
  request: string;
  placementId: string;
  requesterId: string;
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  tenantId: string;
  connectionId: string;
  operationId: string;
  tenantBoundaryHandle: string;
  contextExpiresAt: string;
  now(): string;
  callbackBaseUrl?: string;
  createSandbox: (id: string) => DevelopmentSandbox;
}): Promise<string> {
  const callback = authenticatedHttpsBase(input.callbackBaseUrl);
  const contextExpiresAt = Date.parse(input.contextExpiresAt);
  const observedAt = Date.parse(input.now());
  const processTimeout = Math.min(
    DEVELOPMENT_PROCESS_MAX_TIMEOUT_MS,
    contextExpiresAt - observedAt - TENANT_CONTEXT_SHUTDOWN_RESERVE_MS,
  );
  const runnerTimeout = processTimeout - DEVELOPMENT_CALLBACK_RESERVE_MS;
  if (!Number.isFinite(contextExpiresAt) || !Number.isFinite(observedAt) || runnerTimeout <= 0) {
    throw new Error("development_tenant_context_expiring");
  }
  const jobId = await jobIdForTenantOperation(input);
  // A development operation has a deterministic job id for idempotent user
  // feedback, but every launch receives a fresh Container identity. This makes
  // cross-operation and cross-tenant Container reuse structurally impossible.
  const sandboxId = freshTenantContainerId("development-sandbox");
  const jobPath = `/tmp/${jobId}.json`;
  const callbackPath = callback.pathname.replace(/\/$/, "");
  const payload = {
    job_id: jobId,
    request: input.request,
    placement_id: input.placementId,
    requester_id: input.requesterId,
    event_id: input.eventId,
    workspace_id: input.workspaceId,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    callback_url: `${callback.origin}${callbackPath}/development/callback`,
    runner_timeout_ms: runnerTimeout,
  };

  try {
    const sandbox = input.createSandbox(sandboxId);
    await sandbox.writeFile(jobPath, JSON.stringify(payload));
    await sandbox.startProcess(
      `node /opt/mana/cloudflare-development-runner.mjs ${jobPath}`,
      {
        processId: jobId,
        autoCleanup: true,
        timeout: processTimeout,
        env: {
          IS_SANDBOX: "1",
          CLAUDE_CODE_OAUTH_TOKEN: tenantBoundaryCredentialMarker(input.tenantBoundaryHandle),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${tenantBoundaryCredentialMarker(input.tenantBoundaryHandle)}`,
          MANA_TENANT_BOUNDARY_HANDLE: input.tenantBoundaryHandle,
        },
      },
    );
  } catch {
    throw new Error("development_runner_failed");
  }

  return `開発依頼を受け付けました。job: ${jobId}\n完了または判断が必要になった時点で、このスレッドへ通知します。`;
}
