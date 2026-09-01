import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  executeCompanyAuthorityRuntimeBoundary,
  resolveCompanyAuthorityRuntimeEnvelope,
} from "../multitenancy/company-authority-runtime-adapter.js";
import { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";

describe("company authority runtime envelope", () => {
  it("revalidates the signed outer and nested contexts before a runtime effect", async () => {
    const contractRoot = new URL(
      "../../../../contracts/mana-brainbase-company-authority/v1/",
      import.meta.url,
    );
    const fixtures = JSON.parse(await readFile(new URL("fixtures/cases.json", contractRoot), "utf8")) as {
      positive: Array<Record<string, any>>;
    };
    const contract = JSON.parse(await readFile(new URL("producer.contract.json", contractRoot), "utf8")) as {
      signature: { audience: string };
    };
    const key = JSON.parse(await readFile(new URL("fixtures/test-key.json", contractRoot), "utf8")) as {
      key_id: string;
      public_jwk: JsonWebKey;
    };
    const fixture = fixtures.positive.find(({ context }) => context?.authority?.decision === "auto")!;
    const response = {
      schema_version: "1.0",
      contract_id: "mana-brainbase-company-authority/v1",
      correlation_id: fixture.request.correlation_id,
      context: fixture.context,
      error: null,
    };
    const acceptance = {
      expected_audience: contract.signature.audience,
      expected_deployment_id: fixture.context.tenant_context.placement.deployment_id,
      now: fixture.evaluation_time,
      public_jwk: key.public_jwk,
      tenant_context_public_jwk: key.public_jwk,
      tenant_context_key_id: key.key_id,
    };
    const resolved = await resolveCompanyAuthorityRuntimeEnvelope({
      observation: {
        provider: "slack",
        authentication: { status: "verified", scheme: "slack_signature_v0" },
        authenticated_subject_id: fixture.request.provider_identity.authenticated_subject_id,
        workspace_id: fixture.request.provider_identity.workspace_id,
        app_id: fixture.request.provider_identity.app_id,
        enterprise_id: fixture.request.provider_identity.enterprise_id,
        capability_id: fixture.request.requested_action.capability_id,
        resource_ref: fixture.request.requested_action.resource_ref,
        project_hint: fixture.request.requested_action.project_hint,
        channel_id: fixture.request.delivery.channel_id,
        thread_ts: fixture.request.delivery.thread_ts,
        event_id: fixture.request.delivery.event_id,
        correlation_id: fixture.request.correlation_id,
      },
      desired_effect_by_capability: {
        [fixture.request.requested_action.capability_id]: fixture.request.requested_action.desired_effect,
      },
      client: { resolve: async () => ({ state: "resolved", response }) },
      acceptance,
      payload: { event_id: fixture.request.delivery.event_id },
    });
    const tenantContext = fixture.context.tenant_context;
    const tenantPublicKey = await crypto.subtle.importKey(
      "jwk",
      key.public_jwk,
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    const tenantVerifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => ({
        ...tenantContext.workspace_connection,
        tenant_id: tenantContext.tenant.tenant_id,
        installer_id: "person-sato",
        granted_scopes: [],
        deployment_id: tenantContext.placement.deployment_id,
        profile: tenantContext.placement.profile,
        credential_mode: tenantContext.credential.mode,
        contract_revision: tenantContext.contract_revision,
      }),
      resolve_verification_key: async () => tenantPublicKey,
    });
    const expectedTenantScope = {
      audience: contract.signature.audience[0],
      workspace_id: tenantContext.workspace_connection.workspace_id,
      app_id: tenantContext.workspace_connection.app_id,
      channel_id: tenantContext.slack.channel_id,
      thread_ts: tenantContext.slack.thread_ts,
      actor_principal_id: tenantContext.actor.principal_id,
      project_id: tenantContext.authorization.project_ids[0],
      project_ids: tenantContext.authorization.project_ids,
      capability_id: "company_authority_v1",
      deployment_id: tenantContext.placement.deployment_id,
    };
    const effect = vi.fn(async () => "queued");

    await expect(executeCompanyAuthorityRuntimeBoundary({
      boundary: "queue_consumer",
      envelope: resolved.envelope,
      acceptance,
      tenant_verifier: tenantVerifier,
      expected_tenant_scope: expectedTenantScope,
      validate_payload_binding: (_context, request, payload) => {
        if (payload.event_id !== request.delivery?.event_id) throw new Error("PAYLOAD_SCOPE_MISMATCH");
      },
      execute_auto: effect,
    })).resolves.toMatchObject({
      decision: "auto",
      result: "queued",
      payload: { event_id: fixture.request.delivery.event_id },
    });
    expect(effect).toHaveBeenCalledTimes(1);

    const tampered = structuredClone(resolved.envelope) as any;
    tampered.company_authority_response.context.scope.project_ids = ["project-other"];
    const rejectedEffect = vi.fn();
    await expect(executeCompanyAuthorityRuntimeBoundary({
      boundary: "slack_delivery",
      envelope: tampered,
      acceptance,
      tenant_verifier: tenantVerifier,
      expected_tenant_scope: expectedTenantScope,
      validate_payload_binding: () => undefined,
      execute_auto: rejectedEffect,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "slack_delivery",
      code: "AUTHORITY_CONTEXT_INVALID_SIGNATURE",
    }));
    expect(rejectedEffect).not.toHaveBeenCalled();

    const misbound = { ...structuredClone(resolved.envelope), correlation_id: "cor_wrong" };
    const misboundEffect = vi.fn();
    await expect(executeCompanyAuthorityRuntimeBoundary({
      boundary: "brainbase_proxy",
      envelope: misbound,
      acceptance,
      tenant_verifier: tenantVerifier,
      expected_tenant_scope: expectedTenantScope,
      validate_payload_binding: () => undefined,
      execute_auto: misboundEffect,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "brainbase_proxy",
      code: "AUTHORITY_SCOPE_MISMATCH",
    }));
    expect(misboundEffect).not.toHaveBeenCalled();

    const requestTampered = structuredClone(resolved.envelope) as any;
    requestTampered.company_authority_request.requested_action.resource_ref = "company://other/write";
    const requestTamperedEffect = vi.fn();
    await expect(executeCompanyAuthorityRuntimeBoundary({
      boundary: "container_launch",
      envelope: requestTampered,
      acceptance,
      tenant_verifier: tenantVerifier,
      expected_tenant_scope: expectedTenantScope,
      validate_payload_binding: () => undefined,
      execute_auto: requestTamperedEffect,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "container_launch",
      code: "AUTHORITY_SCOPE_MISMATCH",
    }));
    expect(requestTamperedEffect).not.toHaveBeenCalled();

    const malformedEffect = vi.fn();
    await expect(executeCompanyAuthorityRuntimeBoundary({
      boundary: "mcp_gateway",
      envelope: null as any,
      acceptance,
      tenant_verifier: tenantVerifier,
      expected_tenant_scope: expectedTenantScope,
      validate_payload_binding: () => undefined,
      execute_auto: malformedEffect,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "mcp_gateway",
      code: "AUTHORITY_ENVELOPE_INVALID",
    }));
    expect(malformedEffect).not.toHaveBeenCalled();
  });
});
