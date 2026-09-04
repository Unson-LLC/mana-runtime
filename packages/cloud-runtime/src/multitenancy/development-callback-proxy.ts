import {
  developmentCallbackPayloadHash,
  parseDevelopmentCallbackPayload,
} from "../development-callback.js";
import { developmentJobIdForTenantOperation } from "../development-runner-client.js";
import {
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  type TenantBoundaryContextNamespace,
} from "./durable-tenant-boundary.js";
import {
  claimDevelopmentJobOwner,
  completeDevelopmentJobOwner,
  developmentOwnerFromContext,
  failDevelopmentJobOwner,
  releaseDevelopmentJobOwner,
} from "./development-job-owner.js";
import {
  createDevelopmentTerminalOutboxClient,
  type DevelopmentTerminalOutboxRecord,
} from "./development-terminal-outbox.js";
import { TenantBoundaryError } from "./errors.js";
import type { AccountingArtifact } from "./accounting.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "./contracts.js";
import { createDestroyedContainerSanitizationReceipt } from "./isolation.js";
import {
  createDurableTenantStateClient,
  createDurableTenantAccountingClient,
  type TenantRuntimeStateNamespace,
} from "./tenant-runtime-state.js";
import { persistTenantRuntimeTerminalOperation } from "./production-consumer.js";

export interface DevelopmentCallbackProxyEnv {
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace & TenantRuntimeStateNamespace;
}

export type DestroyDevelopmentContainer = (containerId: string) => Promise<void>;

export type WriteDevelopmentTerminalAccounting = (input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  artifact: AccountingArtifact;
  now: string;
}) => Promise<{ result_ref: string }>;

const DEVELOPMENT_CALLBACK_FORWARD_TIMEOUT_MS = 5_000;

function retainedUntil(now: string): string {
  return new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

async function forwardDevelopmentCallback(
  raw: string,
  boundaryHandle: string,
  env: DevelopmentCallbackProxyEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!env.DEVELOPMENT_CALLBACK_BASE_URL || !env.DEVELOPMENT_CALLBACK_TOKEN) {
    return new Response("development_callback_not_configured", { status: 503 });
  }
  const base = new URL(env.DEVELOPMENT_CALLBACK_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password) {
    return new Response("development_callback_not_configured", { status: 503 });
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Response>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new TenantBoundaryError("brainbase_proxy", "UPSTREAM_UNAVAILABLE"));
    }, DEVELOPMENT_CALLBACK_FORWARD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      fetchImpl(`${base.origin}${base.pathname.replace(/\/$/, "")}/development/callback`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.DEVELOPMENT_CALLBACK_TOKEN}`,
          "content-type": "application/json",
          "x-mana-tenant-boundary-handle": boundaryHandle,
        },
        body: raw,
        signal: controller.signal,
      }),
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function responseCompleted(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const body = await response.clone().json().catch(() => null) as { ok?: unknown; state?: unknown } | null;
  return body?.ok === true && body.state === "completed";
}

async function destroyRecordedContainer(
  record: DevelopmentTerminalOutboxRecord,
  env: DevelopmentCallbackProxyEnv,
  destroyContainer: DestroyDevelopmentContainer | undefined,
  now: string,
): Promise<void> {
  if (record.container_destroyed_at) return;
  if (!record.container_id || !destroyContainer) {
    throw new TenantBoundaryError("container_launch", "CONTAINER_SANITIZATION_UNPROVEN");
  }
  await destroyContainer(record.container_id);
  const receipt = await createDestroyedContainerSanitizationReceipt({
    tenant_id: record.owner.tenantId,
    operation_id: record.owner.operationId,
    container_id: record.container_id,
    completed_at: now,
  });
  await createDevelopmentTerminalOutboxClient(env.TENANT_RUNTIME_STATE, record.owner_claim.partition_key)
    .recordContainerDestroyed(now, receipt);
}

export async function retryDevelopmentTerminalOutboxRecord(
  record: DevelopmentTerminalOutboxRecord,
  env: DevelopmentCallbackProxyEnv,
  fetchImpl: typeof fetch = fetch,
  destroyContainer?: DestroyDevelopmentContainer,
): Promise<{ state: "completed" } | { state: "retry"; error: string }> {
  if (!record.terminal_accounting) return { state: "retry", error: "SCHEMA_INVALID" };
  const registry = createDurableTenantBoundaryRegistry(env.TENANT_RUNTIME_STATE);
  let transientBoundaryHandle: string | undefined;
  let response: Response | undefined;
  try {
    transientBoundaryHandle = await registry.register({
      tenant_context: record.terminal_accounting.tenant_context,
      expected_scope: record.terminal_accounting.expected_scope,
      now: new Date().toISOString(),
    });
    response = await forwardDevelopmentCallback(
      record.callback_body,
      transientBoundaryHandle,
      env,
      fetchImpl,
    ).catch(() => undefined);
  } catch {
    response = undefined;
  } finally {
    if (transientBoundaryHandle) await registry.dispose(transientBoundaryHandle).catch(() => undefined);
  }
  if (!response || !await responseCompleted(response)) {
    return { state: "retry", error: response ? `HTTP_${response.status}` : "UPSTREAM_UNAVAILABLE" };
  }
  const store = createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, record.owner.tenantId);
  const completedAt = new Date().toISOString();
  try {
    await destroyRecordedContainer(record, env, destroyContainer, completedAt);
  } catch {
    return { state: "retry", error: "CONTAINER_SANITIZATION_UNPROVEN" };
  }
  await completeDevelopmentJobOwner(
    store,
    record.owner,
    record.owner_claim,
    completedAt,
    retainedUntil(completedAt),
  );
  return { state: "completed" };
}

export async function failDevelopmentTerminalOutboxRecord(
  record: DevelopmentTerminalOutboxRecord,
  env: DevelopmentCallbackProxyEnv,
  now: string,
  destroyContainer?: DestroyDevelopmentContainer,
  writeAccounting?: WriteDevelopmentTerminalAccounting,
): Promise<void> {
  if (!record.terminal_accounting || !writeAccounting) {
    throw new TenantBoundaryError("brainbase_proxy", "SCHEMA_INVALID");
  }
  const ledger = createDurableTenantAccountingClient(
    env.TENANT_RUNTIME_STATE,
    record.terminal_accounting.tenant_context,
  );
  const persisted = await persistTenantRuntimeTerminalOperation({
    tenant_context: record.terminal_accounting.tenant_context,
    expected_scope: record.terminal_accounting.expected_scope,
    ledger,
    quota_decision: record.terminal_accounting.quota_decision,
    unit: record.terminal_accounting.unit,
    outcome: record.terminal_accounting.outcome,
    failure_code: record.terminal_accounting.failure_code,
    reply_state: record.terminal_accounting.reply_state,
    now: record.terminal_accounting.recorded_at,
    accounting_effect_id: record.terminal_accounting.accounting_effect_id,
  });
  await destroyRecordedContainer(record, env, destroyContainer, now);
  if (persisted.disposition === "claimed") {
    await writeAccounting({
      tenant_context: record.terminal_accounting.tenant_context,
      expected_scope: record.terminal_accounting.expected_scope,
      artifact: persisted.artifact,
      now,
    });
    await ledger.complete(persisted.claim);
  }
  const store = createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, record.owner.tenantId);
  await failDevelopmentJobOwner(
    store,
    record.owner,
    record.owner_claim,
    now,
    retainedUntil(now),
  );
}

export async function proxyDevelopmentCallback(
  request: Request,
  env: DevelopmentCallbackProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/callback"
    || !env.DEVELOPMENT_CALLBACK_BASE_URL || !env.DEVELOPMENT_CALLBACK_TOKEN) {
    return new Response("development_callback_not_configured", { status: 503 });
  }
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    new Date().toISOString(),
  );
  if (resolved instanceof Response) return resolved;
  // A Company Authority callback must use the selected operation route. This
  // sandbox callback proxy is not an approved A0 effect boundary, so reject
  // before parsing, claiming ownership, or forwarding downstream.
  if (resolved.company_authority_envelope !== undefined) {
    return Response.json({ error: "COMPANY_AUTHORITY_OPERATION_FORBIDDEN" }, { status: 403 });
  }
  const raw = await request.text();
  const payload = parseDevelopmentCallbackPayload(
    await Promise.resolve().then(() => JSON.parse(raw)).catch(() => undefined),
  );
  if (!payload) return Response.json({ error: "development_callback_invalid" }, { status: 400 });
  const expectedJobId = await developmentJobIdForTenantOperation({
    eventId: payload.event_id,
    tenantId: resolved.tenant_context.tenant.tenant_id,
    connectionId: resolved.tenant_context.workspace_connection.connection_id,
    operationId: resolved.tenant_context.operation_id,
    workspaceId: resolved.tenant_context.workspace_connection.workspace_id,
    channelId: resolved.tenant_context.slack.channel_id,
    threadTs: resolved.tenant_context.slack.thread_ts ?? "",
  });
  if (payload.job_id !== expectedJobId
    || payload.workspace_id !== resolved.tenant_context.workspace_connection.workspace_id
    || payload.channel_id !== resolved.tenant_context.slack.channel_id
    || payload.thread_ts !== (resolved.tenant_context.slack.thread_ts ?? "")
    || payload.requester_id !== resolved.tenant_context.actor.authenticated_subject_id) {
    return Response.json({ error: "development_callback_forbidden" }, { status: 403 });
  }
  const owner = await developmentOwnerFromContext({
    tenant_context: resolved.tenant_context,
    jobId: payload.job_id,
    eventId: payload.event_id,
    requesterId: payload.requester_id,
    placementId: payload.placement_id,
    quotaDecision: payload.quota_decision,
  });
  const store = createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, owner.tenantId);
  let claimed: Awaited<ReturnType<typeof claimDevelopmentJobOwner>>;
  try {
    claimed = await claimDevelopmentJobOwner(store, owner, new Date().toISOString());
  } catch (error) {
    const forbidden = error instanceof TenantBoundaryError
      && ["IDEMPOTENCY_CONFLICT", "WORKSPACE_CONNECTION_STALE_REVISION", "CROSS_TENANT_CANDIDATE"]
        .includes(error.code);
    return Response.json({ error: forbidden ? "development_callback_forbidden" : "development_callback_owner_unavailable" },
      { status: forbidden ? 403 : 503 });
  }
  if (claimed.disposition === "claimed") {
    await releaseDevelopmentJobOwner(store, owner, claimed.claim);
    return Response.json({ error: "development_callback_owner_missing" }, { status: 403 });
  }
  if (claimed.disposition === "succeeded") {
    return Response.json({ ok: true, state: "completed", duplicate: true });
  }
  if (claimed.disposition !== "in_progress") {
    return Response.json({ error: "development_callback_forbidden" }, { status: 403 });
  }
  const boundaryHandle = request.headers.get("x-mana-tenant-boundary-handle") ?? "";
  const outbox = createDevelopmentTerminalOutboxClient(env.TENANT_RUNTIME_STATE, claimed.claim.partition_key);
  const observedAt = new Date().toISOString();
  const terminal = payload.status === "failed"
    ? { outcome: "failed" as const, failureCode: "DEVELOPMENT_RUNNER_FAILED" }
    : payload.status === "timed_out"
      ? { outcome: "timed_out" as const, failureCode: "DEVELOPMENT_RUNNER_TIMED_OUT" }
      : { outcome: "succeeded" as const, failureCode: null };
  const outboxRecord = await outbox.submit({
    job_id: payload.job_id,
    payload_hash: await developmentCallbackPayloadHash(payload),
    callback_body: raw,
    owner,
    owner_claim: { key: claimed.claim.key, partition_key: claimed.claim.partition_key },
    terminal_deadline_at: resolved.tenant_context.expires_at,
    observed_at: observedAt,
    terminal_accounting: {
      tenant_context: resolved.tenant_context,
      expected_scope: resolved.expected_scope,
      quota_decision: payload.quota_decision,
      unit: "container_seconds",
      outcome: terminal.outcome,
      failure_code: terminal.failureCode,
      reply_state: "unknown",
      recorded_at: observedAt,
      accounting_effect_id: `development_terminal:${payload.job_id}`,
    },
  });
  if (outboxRecord.state === "completed") {
    return Response.json({ ok: true, state: "completed", duplicate: true });
  }
  const response = await forwardDevelopmentCallback(raw, boundaryHandle, env, fetchImpl);
  // The terminal outbox remains the only completion owner. Even a synchronous
  // callback success is replayed by its Durable Object alarm, which destroys
  // the Container from a different Durable Object before completing the job.
  // This avoids destroying the sandbox from inside its own outbound handler.
  return response;
}
