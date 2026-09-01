import type { SlackQueueEvent } from "../types.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityDesiredEffect,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "./contracts.js";
import { deny } from "./errors.js";
import { matchesCompanyAuthoritySlackPayload } from "./company-authority-payload-binding.js";
import {
  processCompanyAuthorityExternalEffect,
  type ExternalEffectOutboxRecord,
  type ExternalEffectOutboxStore,
  type ExternalEffectProviderResult,
} from "./company-authority-external-effect-outbox.js";

export interface CompanyAuthorityExternalEffectProviderRoute<T> {
  create_outbox(context: AcceptedCompanyAuthorityContext): ExternalEffectOutboxStore;
  provider_send(input: {
    provider_key: string;
    payload: T;
  }): Promise<ExternalEffectProviderResult>;
}

export type CompanyAuthorityCapabilityProviderRegistry<T> = Readonly<Record<
  string,
  CompanyAuthorityExternalEffectProviderRoute<T> | undefined
>>;

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

/**
 * Dispatches only an already-accepted automatic external effect to an explicit
 * provider route. Registry absence is retryable and never falls back to a
 * guessed transport or to another capability.
 */
export async function processCompanyAuthorityAutoQueueRoute<T>(input: {
  context: AcceptedCompanyAuthorityContext;
  request: ObservedExecutionRequestV1;
  payload: T;
  registry: CompanyAuthorityCapabilityProviderRegistry<T>;
}): Promise<ExternalEffectOutboxRecord> {
  if (input.context.authority.decision !== "auto") {
    scopeMismatch("company_authority_non_auto_provider_route_forbidden");
  }
  if (input.request.requested_action.desired_effect !== "external_side_effect") {
    scopeMismatch("company_authority_provider_effect_mismatch");
  }
  const capabilityId = input.request.requested_action.capability_id;
  if (input.context.authority.capability_id !== capabilityId) {
    scopeMismatch("company_authority_provider_capability_mismatch");
  }
  const allowedEffects = input.context.authority.allowed_effects;
  if (!Array.isArray(allowedEffects) || !allowedEffects.includes("external_side_effect")) {
    scopeMismatch("company_authority_provider_effect_not_allowed");
  }
  const route = Object.prototype.hasOwnProperty.call(input.registry, capabilityId)
    ? input.registry[capabilityId]
    : undefined;
  if (!route) {
    return deny("queue_consumer", "UPSTREAM_UNAVAILABLE", {
      phase: "company_authority_auto_provider_route_not_connected",
      capability_id: capabilityId,
    });
  }
  return processCompanyAuthorityExternalEffect({
    context: input.context,
    payload: input.payload,
    outbox: route.create_outbox(input.context),
    provider_send: route.provider_send,
  });
}
