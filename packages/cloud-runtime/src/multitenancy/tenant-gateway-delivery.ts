import type { AuthorizedTenantBoundaryContext } from "./durable-tenant-boundary.js";
import {
  createDurableTenantAccountingClient,
  createDurableTenantStateClient,
  type TenantRuntimeStateNamespace,
} from "./tenant-runtime-state.js";
import {
  resolveTenantProviderVerificationKey,
  tenantRuntimeHttpClientsForEnv,
  type TenantProviderOutboundEnv,
} from "./tenant-provider-outbound.js";
import { TenantRuntimeBoundaryVerifier } from "./runtime-boundaries.js";
import { executeTenantRuntimeOperation, postTenantSlackReply } from "./production-consumer.js";

export interface TenantGatewayDeliveryEnv extends TenantProviderOutboundEnv {
  TENANT_RUNTIME_STATE: TenantProviderOutboundEnv["TENANT_RUNTIME_STATE"] & TenantRuntimeStateNamespace;
}

function retainedUntil(now: string): string {
  return new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

export async function deliverTenantGatewaySlackMessage(input: {
  requestId: string;
  callIndex: number;
  channel: string;
  threadTs?: string;
  text: string;
}, env: TenantGatewayDeliveryEnv, resolved: AuthorizedTenantBoundaryContext,
credentialFetch: typeof fetch): Promise<{ channel: string; ts?: string }> {
  const canonicalThread = resolved.expected_scope.thread_ts;
  if (input.channel !== resolved.expected_scope.channel_id
    || (input.threadTs !== undefined && input.threadTs !== canonicalThread)) {
    return Promise.reject(new Error("gateway_delivery_denied"));
  }
  const clients = tenantRuntimeHttpClientsForEnv(env, resolved.tenant_context);
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
      resolved.tenant_context.workspace_connection.connection_id,
    ),
    resolve_verification_key: (keyId) => resolveTenantProviderVerificationKey(env, keyId),
  });
  const effectId = `runtime_gateway:${input.requestId}:${input.callIndex}`;
  const result = await executeTenantRuntimeOperation({
    tenant_context: resolved.tenant_context,
    expected_scope: resolved.expected_scope,
    verifier,
    quota: clients.quota,
    accounting: clients.accounting,
    ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, resolved.tenant_context),
    quota_unit: "slack_message",
    accounting_effect_id: effectId,
    now: () => new Date().toISOString(),
    process: async () => {
      const deliveryNow = new Date().toISOString();
      const responseTs = await postTenantSlackReply({
        tenant_context: resolved.tenant_context,
        expected_scope: resolved.expected_scope,
        ownership: createDurableTenantStateClient(
          env.TENANT_RUNTIME_STATE,
          resolved.tenant_context.tenant.tenant_id,
        ),
        read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
          resolved.tenant_context.workspace_connection.connection_id,
        ),
        resolve_verification_key: (keyId) => resolveTenantProviderVerificationKey(env, keyId),
        now: deliveryNow,
        retention_until: retainedUntil(deliveryNow),
        event: { request_id: input.requestId, call_index: input.callIndex, channel: input.channel,
          thread_ts: canonicalThread ?? null },
        text: input.text,
        effect_id: effectId,
        post: async () => {
          const upstream = await credentialFetch(new Request("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ channel: input.channel, text: input.text,
              ...(canonicalThread ? { thread_ts: canonicalThread } : {}) }),
          }));
          const payload = await upstream.json().catch(() => null) as { ok?: boolean; ts?: string } | null;
          if (!upstream.ok || !payload?.ok || typeof payload.ts !== "string") {
            throw new Error("gateway_delivery_failed");
          }
          return payload.ts;
        },
      });
      return { outcome: "delivered", responseTs, channel: input.channel, ts: responseTs };
    },
  });
  return { channel: result.channel, ...(result.ts ? { ts: result.ts } : {}) };
}
