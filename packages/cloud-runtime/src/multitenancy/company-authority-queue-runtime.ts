import type { SlackQueueEvent } from "../types.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityDesiredEffect,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "./contracts.js";
import { deny } from "./errors.js";
import { matchesCompanyAuthoritySlackPayload } from "./company-authority-payload-binding.js";

function scopeMismatch(phase: string): never {
  return deny("queue_consumer", "AUTHORITY_SCOPE_MISMATCH", { phase });
}

function exactSingleProject(
  tenantContext: TenantContextEnvelope,
  request: ObservedExecutionRequestV1,
): string {
  const projectIds = tenantContext.authorization.project_ids;
  const projectHint = request.requested_action.project_hint;
  if (projectIds.length !== 1 || !projectHint || projectIds[0] !== projectHint) {
    scopeMismatch("company_authority_project_binding");
  }
  return projectHint;
}

/**
 * Derives the expected nested TenantContext scope only after the signed Company
 * Authority response has been accepted. Every duplicated Slack identity and
 * delivery field must agree before a tenant verifier or ownership store is
 * selected.
 */
export async function resolveCompanyAuthoritySlackQueueScope(input: {
  context: AcceptedCompanyAuthorityContext;
  request: ObservedExecutionRequestV1;
  payload: SlackQueueEvent;
  expected_audience: string;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
}): Promise<ExpectedTenantScope> {
  const tenantContext = input.context.tenant_context as unknown as TenantContextEnvelope;
  const provider = input.request.provider_identity;
  const delivery = input.request.delivery;
  const configuredEffect = input.desired_effect_by_capability[
    input.request.requested_action.capability_id
  ];
  if (!configuredEffect || configuredEffect !== input.request.requested_action.desired_effect) {
    scopeMismatch("company_authority_operation_binding");
  }
  if (provider.provider !== "slack"
    || !provider.workspace_id
    || !provider.app_id
    || provider.workspace_id !== tenantContext.workspace_connection.workspace_id
    || provider.app_id !== tenantContext.workspace_connection.app_id
    || provider.authenticated_subject_id !== tenantContext.actor.authenticated_subject_id
    || provider.authenticated_subject_id !== tenantContext.slack.requester_id) {
    scopeMismatch("company_authority_provider_binding");
  }
  if (!delivery
    || delivery.event_id !== tenantContext.slack.event_id
    || delivery.channel_id !== tenantContext.slack.channel_id
    || delivery.thread_ts !== tenantContext.slack.thread_ts
    || input.payload.eventId !== tenantContext.slack.event_id
    || input.payload.workspaceId !== tenantContext.workspace_connection.workspace_id
    || input.payload.channelId !== tenantContext.slack.channel_id
    || input.payload.threadTs !== tenantContext.slack.thread_ts
    || input.payload.userId !== tenantContext.actor.authenticated_subject_id
    || input.payload.tenantId !== tenantContext.tenant.tenant_id) {
    scopeMismatch("company_authority_delivery_binding");
  }
  if (!tenantContext.authorization.capability_ids.includes("company_authority_v1")) {
    scopeMismatch("company_authority_protocol_binding");
  }
  const projectId = exactSingleProject(tenantContext, input.request);
  if (!await matchesCompanyAuthoritySlackPayload(
    input.request.requested_action.resource_ref,
    projectId,
    input.payload,
  )) {
    scopeMismatch("company_authority_payload_binding");
  }
  return {
    audience: input.expected_audience,
    workspace_id: tenantContext.workspace_connection.workspace_id,
    app_id: tenantContext.workspace_connection.app_id,
    channel_id: tenantContext.slack.channel_id,
    thread_ts: tenantContext.slack.thread_ts ?? scopeMismatch("company_authority_delivery_binding"),
    actor_principal_id: tenantContext.actor.principal_id,
    project_id: projectId,
    project_ids: [projectId],
    capability_id: "company_authority_v1",
    deployment_id: tenantContext.placement.deployment_id,
  };
}

export async function unavailableCompanyAuthorityQueueRoute(
  decision: "auto" | "approval" | "human_action",
): Promise<never> {
  return deny(
    "queue_consumer",
    "UPSTREAM_UNAVAILABLE",
    { phase: `company_authority_${decision}_route_not_connected` },
  );
}
