import { describe, expect, it, vi } from "vitest";

import { resolveAutonomyTenantContext } from "../autonomy-tenant-context.js";
import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";

const NOW = "2026-08-26T01:00:00Z";
const RUN_ID = "mana-autonomy-24h-v0:2026-08-26T01:00:00.000Z";

const workspaceConnection: WorkspaceConnectionSnapshot = {
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "11",
  installation_id: "installation-unson",
  workspace_id: "T_UNSON",
  app_id: "A_MANA",
  installer_id: "brainbase-control-plane",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active",
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "13",
};

function context(): TenantContextEnvelope {
  return {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: workspaceConnection.tenant_id, tenant_revision: "7" },
    workspace_connection: {
      connection_id: workspaceConnection.connection_id,
      connection_revision: workspaceConnection.connection_revision,
      provider: "slack",
      installation_id: workspaceConnection.installation_id,
      workspace_id: workspaceConnection.workspace_id,
      app_id: workspaceConnection.app_id,
      status: "active",
    },
    actor: {
      principal_id: "mana_autonomy_v0",
      principal_type: "service",
      authenticated_subject_id: "mana_autonomy_v0",
    },
    authorization: {
      organization_ids: ["unson-business"],
      project_ids: ["proj_brainbase"],
      capability_ids: ["task.create"],
      data_scopes: [
        "company_authority:decision:auto",
        "company_authority:membership:svc-membership@1",
        "company_authority:resource:project:brainbase@1",
        "company_authority:raci:1",
        "company_authority:policy:1",
        "company_authority:effect:write",
        "company_authority:placement:mana-autonomy",
        "company_authority:identity_receipt:svc-identity-receipt",
        "company_authority:authority_receipt:svc-authority-receipt",
      ],
    },
    placement: { deployment_id: workspaceConnection.deployment_id, profile: "shared_cloud" },
    slack: {
      event_id: RUN_ID,
      channel_id: "C_MANA_AUTONOMY",
      thread_ts: RUN_ID,
    },
    correlation_id: "cor_service_autonomy",
    operation_id: "op_service_autonomy",
    idempotency_key: "ik1_service_autonomy",
    contract_revision: workspaceConnection.contract_revision,
    credential: {
      mode: workspaceConnection.credential_mode,
      credential_ref: "credential-ref-unson",
      billing_principal_id: "mana_autonomy_v0",
    },
    issued_at: NOW,
    expires_at: "2026-08-26T01:05:00Z",
    integrity: {
      method: "jws_detached",
      algorithm: "EdDSA",
      key_id: "brainbase-key-1",
      value: "signed-service-context",
    },
  };
}

function input(service: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }) {
  return {
    service,
    workspaceConnection,
    tenantRevision: "7",
    actorId: "mana_autonomy_v0",
    project: "brainbase",
    capabilityId: "task.create",
    audience: "mana-runtime",
    runId: RUN_ID,
    channelId: "C_MANA_AUTONOMY",
    now: NOW,
    resolveVerificationKey: vi.fn(async () => undefined),
  };
}

function serviceFor(value: TenantContextEnvelope, captures: Array<{ url: string; body: unknown }>) {
  return {
    fetch: vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const body = JSON.parse(String(init?.body));
      captures.push({ url, body });
      if (url.endsWith("/tenant-context:resolve")) return Response.json(value);
      if (url.endsWith("/workspace-connections:validate-revision")) {
        return Response.json({
          valid: true,
          authoritative: true,
          connection_revision: workspaceConnection.connection_revision,
        });
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    }),
  };
}

describe("autonomy service tenant context", () => {
  it("issues provider=service authority without impersonating a Slack requester", async () => {
    const captures: Array<{ url: string; body: unknown }> = [];
    const validate = vi.spyOn(TenantRuntimeBoundaryVerifier.prototype, "validate")
      .mockImplementation(async ({ expected_scope }) => expected_scope as never);
    const result = await resolveAutonomyTenantContext(input(serviceFor(context(), captures)));

    const issue = captures[0]?.body as Record<string, unknown>;
    expect(issue.provider_identity).toEqual({
      provider: "service",
      authenticated_subject_id: "mana_autonomy_v0",
      workspace_id: "T_UNSON",
      app_id: "A_MANA",
    });
    expect(issue.slack).toEqual({
      event_id: RUN_ID,
      channel_id: "C_MANA_AUTONOMY",
      thread_ts: RUN_ID,
    });
    expect(JSON.stringify(issue)).not.toContain("requester_id");
    expect(issue.requested_action).toEqual({
      capability_id: "task.create",
      resource_ref: "project:brainbase",
      project_hint: "brainbase",
      project_ids: ["brainbase"],
      desired_effect: "write",
    });
    expect(result.tenant_context.actor).toMatchObject({
      principal_type: "service",
      authenticated_subject_id: "mana_autonomy_v0",
    });
    expect(result.expected_scope).toMatchObject({
      audience: "mana-runtime",
      project_id: "proj_brainbase",
      project_ids: ["proj_brainbase"],
      capability_id: "task.create",
      actor_principal_id: "mana_autonomy_v0",
      channel_id: "C_MANA_AUTONOMY",
      thread_ts: RUN_ID,
    } satisfies Partial<ExpectedTenantScope>);
    expect(validate).toHaveBeenCalledOnce();
    validate.mockRestore();
  });

  it("fails closed when Brainbase resolves a person or adds requester identity", async () => {
    for (const mutate of [
      (value: TenantContextEnvelope) => { value.actor.principal_type = "person"; },
      (value: TenantContextEnvelope) => { value.slack.requester_id = "U_HUMAN"; },
    ]) {
      const value = context();
      mutate(value);
      const captures: Array<{ url: string; body: unknown }> = [];
      await expect(resolveAutonomyTenantContext(input(serviceFor(value, captures))))
        .rejects.toSatisfy((error: unknown) => (
          error instanceof TenantBoundaryError && error.code === "ACTOR_SCOPE_MISMATCH"
        ));
      expect(captures).toHaveLength(1);
    }
  });

  it("rejects an opaque project id when the signed resource maps another project code", async () => {
    const value = context();
    value.authorization.data_scopes = value.authorization.data_scopes.map((scope) => (
      scope.startsWith("company_authority:resource:")
        ? "company_authority:resource:project:other@1"
        : scope
    ));
    const captures: Array<{ url: string; body: unknown }> = [];
    await expect(resolveAutonomyTenantContext(input(serviceFor(value, captures))))
      .rejects.toSatisfy((error: unknown) => (
        error instanceof TenantBoundaryError && error.code === "PROJECT_SCOPE_MISMATCH"
      ));
    expect(captures).toHaveLength(1);
  });

  it("rejects missing authority evidence before signature validation", async () => {
    const value = context();
    value.authorization.data_scopes = value.authorization.data_scopes.filter(
      (scope) => !scope.startsWith("company_authority:authority_receipt:"),
    );
    const captures: Array<{ url: string; body: unknown }> = [];
    await expect(resolveAutonomyTenantContext(input(serviceFor(value, captures))))
      .rejects.toSatisfy((error: unknown) => (
        error instanceof TenantBoundaryError && error.code === "COMPANY_AUTHORITY_EVIDENCE_MISSING"
      ));
    expect(captures).toHaveLength(1);
  });

  it("rejects non-authoritative workspace revision readback", async () => {
    const validate = vi.spyOn(TenantRuntimeBoundaryVerifier.prototype, "validate")
      .mockImplementation(async () => undefined as never);
    const service = {
      fetch: vi.fn(async (request: RequestInfo | URL) => String(request).endsWith("/tenant-context:resolve")
        ? Response.json(context())
        : Response.json({ valid: true, authoritative: false,
          connection_revision: workspaceConnection.connection_revision })),
    };
    await expect(resolveAutonomyTenantContext(input(service))).rejects.toSatisfy((error: unknown) => (
      error instanceof TenantBoundaryError && error.code === "WORKSPACE_CONNECTION_STALE_REVISION"
    ));
    expect(validate).not.toHaveBeenCalled();
    validate.mockRestore();
  });
});
