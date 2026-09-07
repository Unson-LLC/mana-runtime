import type { AuthorizedTenantBoundaryContext } from "./durable-tenant-boundary.js";
import { resolveCompanyAuthorityRuntimeEnvelope } from "./company-authority-runtime-adapter.js";
import { parseCompanyAuthorityRuntimeConfiguration, type CompanyAuthorityRuntimeConfigEnv } from "./company-authority-runtime-config.js";
import { tenantRuntimeHttpClientsForEnv, type TenantProviderOutboundEnv } from "./tenant-provider-outbound.js";
import type { TenantContextEnvelope } from "./contracts.js";
import { createDeterministicSharedId } from "./ids.js";

export interface PersonalKnowledgeAuthorityInput {
  capability: "personal_read" | "personal_write";
  effect: "read" | "write";
  requestId: string;
}

function sameResolvedTenantBoundary(
  initial: TenantContextEnvelope,
  resolved: TenantContextEnvelope,
): boolean {
  return resolved.tenant.tenant_id === initial.tenant.tenant_id
    && resolved.tenant.tenant_revision === initial.tenant.tenant_revision
    && resolved.workspace_connection.connection_id === initial.workspace_connection.connection_id
    && resolved.workspace_connection.connection_revision === initial.workspace_connection.connection_revision
    && resolved.workspace_connection.provider === initial.workspace_connection.provider
    && resolved.workspace_connection.installation_id === initial.workspace_connection.installation_id
    && resolved.workspace_connection.workspace_id === initial.workspace_connection.workspace_id
    && resolved.workspace_connection.enterprise_id === initial.workspace_connection.enterprise_id
    && resolved.workspace_connection.app_id === initial.workspace_connection.app_id
    && resolved.workspace_connection.status === initial.workspace_connection.status
    && resolved.actor.principal_id === initial.actor.principal_id
    && resolved.actor.principal_type === initial.actor.principal_type
    && resolved.actor.authenticated_subject_id === initial.actor.authenticated_subject_id
    && resolved.placement.deployment_id === initial.placement.deployment_id
    && resolved.placement.profile === initial.placement.profile
    && resolved.slack.event_id === initial.slack.event_id
    && resolved.slack.channel_id === initial.slack.channel_id
    && resolved.slack.enterprise_id === initial.slack.enterprise_id
    && resolved.slack.thread_ts === initial.slack.thread_ts
    && resolved.slack.requester_id === initial.slack.requester_id;
}

/** Re-resolve the operation using the already verified Slack observation. */
export async function resolvePersonalKnowledgeAuthority(
  env: TenantProviderOutboundEnv & CompanyAuthorityRuntimeConfigEnv,
  resolved: AuthorizedTenantBoundaryContext,
  input: PersonalKnowledgeAuthorityInput,
): Promise<unknown> {
  const tenant = resolved.tenant_context;
  const deny = () => { throw new Error("personal_knowledge_authority_denied"); };
  if (!resolved.company_authority_envelope
    || tenant.actor.principal_type !== "person"
    || !tenant.actor.principal_id
    || tenant.actor.authenticated_subject_id !== tenant.slack.requester_id
    || !/^D[A-Z0-9]+$/.test(tenant.slack.channel_id)
    || (input.capability !== "personal_read" && input.capability !== "personal_write")
    || (input.capability === "personal_read" ? input.effect !== "read" : input.effect !== "write")) deny();
  const config = parseCompanyAuthorityRuntimeConfiguration(env);
  if (config.state !== "enabled") return deny();
  if (config.desired_effect_by_capability[input.capability] !== input.effect) deny();
  if (config.slack_rollout && !config.slack_rollout.some(tuple =>
    tuple.workspace_id === tenant.workspace_connection.workspace_id
    && tuple.channel_id === tenant.slack.channel_id
    && tuple.authenticated_subject_id === tenant.actor.authenticated_subject_id)) deny();
  const project = resolved.expected_scope.project_id;
  const resource = `personal://${tenant.actor.principal_id}/notes`;
  const correlationId = await createDeterministicSharedId(
    "cor_",
    `${tenant.correlation_id}:${input.requestId}`,
  );
  const result = await resolveCompanyAuthorityRuntimeEnvelope({
    observation: {
      provider: "slack",
      authentication: { status: "verified", scheme: "slack_signature_v0" },
      authenticated_subject_id: tenant.actor.authenticated_subject_id,
      workspace_id: tenant.workspace_connection.workspace_id,
      app_id: tenant.workspace_connection.app_id,
      ...(tenant.workspace_connection.enterprise_id ? { enterprise_id: tenant.workspace_connection.enterprise_id } : {}),
      capability_id: input.capability,
      resource_ref: resource,
      project_hint: project,
      channel_id: tenant.slack.channel_id,
      thread_ts: tenant.slack.thread_ts,
      event_id: tenant.slack.event_id,
      correlation_id: correlationId,
    },
    desired_effect_by_capability: config.desired_effect_by_capability,
    client: tenantRuntimeHttpClientsForEnv(env).company_authority,
    acceptance: { ...config.acceptance, now: new Date().toISOString() },
    payload: {},
  });
  const { context } = result;
  const responseTenant = context.tenant_context as unknown as TenantContextEnvelope;
  const effects = context.authority.allowed_effects;
  if (!sameResolvedTenantBoundary(tenant, responseTenant)
    || result.decision !== "auto"
    || context.actor.canonical_person_id !== tenant.actor.principal_id
    || context.scope.owner_person_id !== tenant.actor.principal_id
    || !tenant.authorization.organization_ids.includes(String(context.scope.organization_id))
    || context.scope.project_id !== project
    || context.scope.resource_ref !== resource
    || context.authority.capability_id !== input.capability
    || !Array.isArray(effects) || effects.length !== 1 || effects[0] !== input.effect) deny();
  return result.envelope.company_authority_response;
}

export async function isPersonalKnowledgeGatewayRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/runtime/gateway") return false;
  try {
    const body = await request.clone().json() as { tool?: unknown };
    return body.tool === "search_personal_kg" || body.tool === "register_personal_kg";
  } catch { return false; }
}
