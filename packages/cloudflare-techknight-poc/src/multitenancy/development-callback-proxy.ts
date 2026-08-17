import { parseDevelopmentCallbackPayload } from "../development-callback.js";
import { developmentJobIdForTenantOperation } from "../development-runner-client.js";
import {
  resolveDurableTenantBoundaryContext,
  type TenantBoundaryContextNamespace,
} from "./durable-tenant-boundary.js";
import {
  claimDevelopmentJobOwner,
  completeDevelopmentJobOwner,
  developmentOwnerFromContext,
  releaseDevelopmentJobOwner,
} from "./development-job-owner.js";
import { TenantBoundaryError } from "./errors.js";
import {
  createDurableTenantStateClient,
  type TenantRuntimeStateNamespace,
} from "./tenant-runtime-state.js";

export interface DevelopmentCallbackProxyEnv {
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace & TenantRuntimeStateNamespace;
}

function retainedUntil(now: string): string {
  return new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1_000).toISOString();
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
  if (claimed.disposition === "succeeded") return Response.json({ ok: true, duplicate: true });
  if (claimed.disposition !== "in_progress") {
    return Response.json({ error: "development_callback_forbidden" }, { status: 403 });
  }
  const base = new URL(env.DEVELOPMENT_CALLBACK_BASE_URL);
  if (base.protocol !== "https:" || base.username || base.password) {
    return new Response("development_callback_not_configured", { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${env.DEVELOPMENT_CALLBACK_TOKEN}`);
  headers.set("content-type", "application/json");
  const response = await fetchImpl(`${base.origin}${base.pathname.replace(/\/$/, "")}/development/callback`, {
    method: "POST",
    headers,
    body: raw,
  });
  if (response.ok) {
    const completedAt = new Date().toISOString();
    await completeDevelopmentJobOwner(store, owner, claimed.claim, completedAt, retainedUntil(completedAt));
  }
  return response;
}
