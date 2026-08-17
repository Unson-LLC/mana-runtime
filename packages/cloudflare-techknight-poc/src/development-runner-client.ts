import { tenantBoundaryCredentialMarker } from "./multitenancy/durable-tenant-boundary.js";
import { tenantPartitionKey } from "./multitenancy/isolation.js";
import { freshTenantContainerId } from "./multitenancy/container-lifecycle.js";
import type { DevelopmentJobOwner } from "./multitenancy/development-job-owner.js";
import type { QuotaDecision } from "./multitenancy/contracts.js";
import {
  developmentCallbackPayloadHash,
  type DevelopmentCallbackPayload,
} from "./development-callback.js";

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
  destroy(): Promise<void>;
}

function authenticatedHttpsBase(value: string | undefined): URL {
  if (!value) throw new Error("development_runner_not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("development_runner_not_configured");
  }
  return url;
}

export async function developmentJobIdForTenantOperation(input: {
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
  connectionRevision?: string;
  operationId: string;
  contextHash?: string;
  tenantBoundaryHandle: string;
  contextExpiresAt: string;
  quotaDecision: QuotaDecision["decision"];
  now(): string;
  callbackBaseUrl?: string;
  registerJobOwner(owner: DevelopmentJobOwner): Promise<{
    created: boolean;
    release(): Promise<void>;
    armTerminalWatchdog(input: {
      payload_hash: string;
      callback_body: string;
      activate_at: string;
      terminal_deadline_at: string;
      observed_at: string;
      container_id: string;
    }): Promise<void>;
    cancelTerminalWatchdog(): Promise<void>;
  }>;
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
  const jobId = await developmentJobIdForTenantOperation(input);
  const owner = await input.registerJobOwner({
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    connectionRevision: input.connectionRevision ?? "",
    operationId: input.operationId,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    requesterId: input.requesterId,
    placementId: input.placementId,
    jobId,
    quotaDecision: input.quotaDecision,
    contextHash: input.contextHash ?? "",
  });
  if (!owner.created) {
    return `開発依頼を受け付けました。job: ${jobId}\n完了または判断が必要になった時点で、このスレッドへ通知します。`;
  }
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
    quota_decision: input.quotaDecision,
  };
  const fallbackCallback: DevelopmentCallbackPayload = {
    job_id: jobId,
    event_id: input.eventId,
    placement_id: input.placementId,
    workspace_id: input.workspaceId,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    requester_id: input.requesterId,
    status: "timed_out",
    summary: "開発runnerから終端callbackを受信できませんでした。",
    quota_decision: input.quotaDecision,
  };
  const fallbackBody = JSON.stringify(fallbackCallback);

  let sandbox: DevelopmentSandbox | undefined;
  try {
    await owner.armTerminalWatchdog({
      payload_hash: await developmentCallbackPayloadHash(fallbackCallback),
      callback_body: fallbackBody,
      activate_at: new Date(observedAt + runnerTimeout + 1_000).toISOString(),
      terminal_deadline_at: input.contextExpiresAt,
      observed_at: new Date(observedAt).toISOString(),
      container_id: sandboxId,
    });
    sandbox = input.createSandbox(sandboxId);
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
    let sanitizationProven = true;
    if (sandbox) {
      try {
        await sandbox.destroy();
      } catch {
        sanitizationProven = false;
      }
    }
    await owner.cancelTerminalWatchdog().catch(() => undefined);
    await owner.release().catch(() => undefined);
    if (!sanitizationProven) {
      throw new Error("development_container_sanitization_unproven");
    }
    throw new Error("development_runner_failed");
  }

  return `開発依頼を受け付けました。job: ${jobId}\n完了または判断が必要になった時点で、このスレッドへ通知します。`;
}
