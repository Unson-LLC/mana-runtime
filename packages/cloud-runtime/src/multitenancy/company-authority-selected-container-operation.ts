import type { SlackQueueEvent } from "../types.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityDesiredEffect,
  CompanyAuthorityRuntimeEnvelope,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";
import type {
  ExternalEffectOutboxStore,
  ExternalEffectProviderResult,
} from "./company-authority-external-effect-outbox.js";
import {
  resolveCompanyAuthoritySlackQueueScope,
  type CompanyAuthorityExternalEffectProviderRoute,
} from "./company-authority-queue-runtime.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "./contracts.js";

export function createCompanyAuthoritySelectedContainerProviderRoute(input: {
  create_outbox(context: AcceptedCompanyAuthorityContext): ExternalEffectOutboxStore;
  expected_audience: string;
  desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
  execute_container(operation: {
    provider_key: string;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    company_authority_envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
    payload: SlackQueueEvent;
  }): Promise<ExternalEffectProviderResult>;
}): CompanyAuthorityExternalEffectProviderRoute<SlackQueueEvent> {
  return {
    create_outbox: input.create_outbox,
    provider_send: async ({ provider_key, context, request, envelope, payload }: {
      provider_key: string;
      context: AcceptedCompanyAuthorityContext;
      request: ObservedExecutionRequestV1;
      envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
      payload: SlackQueueEvent;
    }) => {
      const expectedScope = await resolveCompanyAuthoritySlackQueueScope({
        context,
        request,
        payload,
        expected_audience: input.expected_audience,
        desired_effect_by_capability: input.desired_effect_by_capability,
      });
      return input.execute_container({
        provider_key,
        tenant_context: structuredClone(context.tenant_context as unknown as TenantContextEnvelope),
        expected_scope: expectedScope,
        company_authority_envelope: structuredClone(envelope),
        payload: structuredClone(payload),
      });
    },
  };
}
