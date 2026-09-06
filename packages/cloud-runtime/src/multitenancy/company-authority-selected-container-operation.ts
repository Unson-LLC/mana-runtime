import type { SlackQueueEvent } from "../types.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityDesiredEffect,
  CompanyAuthorityRuntimeEnvelope,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";
import type {
  ExternalEffectOutboxStore,
  ExternalEffectRecoveryRecord,
  ExternalEffectProviderResult,
  ExternalEffectReconciliationQueue,
} from "./company-authority-external-effect-outbox.js";
import {
  resolveCompanyAuthoritySlackQueueScope,
  type CompanyAuthorityExternalEffectProviderRoute,
} from "./company-authority-queue-runtime.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";

export function createCompanyAuthoritySelectedContainerProviderRoute(input: {
  create_outbox(context: AcceptedCompanyAuthorityContext): ExternalEffectOutboxStore;
  create_reconciliation_queue?(context: AcceptedCompanyAuthorityContext): ExternalEffectReconciliationQueue;
  expected_audience: string;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  execute_container(operation: {
    provider_key: string;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    company_authority_envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
    payload: SlackQueueEvent;
    canonical_person_id: unknown;
    capture_recovery?: (recovery: ExternalEffectRecoveryRecord) => Promise<void>;
  }): Promise<ExternalEffectProviderResult>;
}): CompanyAuthorityExternalEffectProviderRoute<SlackQueueEvent> {
  return {
    create_outbox: input.create_outbox,
    ...(input.create_reconciliation_queue === undefined ? {} : {
      create_reconciliation_queue: input.create_reconciliation_queue,
    }),
    provider_send: async ({ provider_key, context, request, envelope, payload, capture_recovery }: {
      provider_key: string;
      context: AcceptedCompanyAuthorityContext;
      request: ObservedExecutionRequestV1;
      envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
      payload: SlackQueueEvent;
      capture_recovery?: (recovery: ExternalEffectRecoveryRecord) => Promise<void>;
    }) => {
      try {
        const expectedScope = await resolveCompanyAuthoritySlackQueueScope({
          context,
          request,
          payload,
          expected_audience: input.expected_audience,
          desired_effect_by_capability: input.desired_effect_by_capability,
        });
        return await input.execute_container({
          provider_key,
          tenant_context: structuredClone(context.tenant_context as unknown as TenantContextEnvelope),
          expected_scope: expectedScope,
          company_authority_envelope: structuredClone(envelope),
          payload: structuredClone(payload),
          canonical_person_id: context.actor?.canonical_person_id,
          ...(capture_recovery === undefined ? {} : { capture_recovery }),
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "company_authority_provider_failed",
          correlation_id: envelope.correlation_id,
          code: error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE",
          ...(error instanceof TenantBoundaryError ? {
            boundary: error.boundary,
            ...(typeof error.details?.phase === "string" ? { phase: error.details.phase } : {}),
            ...(typeof error.details?.scope_reason === "string"
              ? { scope_reason: error.details.scope_reason }
              : {}),
          } : {}),
        }));
        throw error;
      }
    },
  };
}
