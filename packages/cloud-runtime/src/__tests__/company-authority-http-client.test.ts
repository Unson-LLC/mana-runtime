import { describe, expect, it, vi } from "vitest";

import { createTenantRuntimeHttpClients } from "../multitenancy/http-clients.js";
import type { TenantContextEnvelope, WorkspaceConnectionSnapshot } from "../multitenancy/contracts.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import type { TenantContextIssueRequest } from "../multitenancy/runtime-boundaries.js";

const tenantId = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const connectionId = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const deploymentId = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const correlationId = "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const operationId = "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const idempotencyKey = "ik1_company-authority-test";

const workspaceConnection: WorkspaceConnectionSnapshot = {
  tenant_id: tenantId,
  connection_id: connectionId,
  connection_revision: "11",
  installation_id: "installation-a",
  workspace_id: "workspace-a",
  app_id: "app-a",
  installer_id: "person-installer",
  granted_scopes: ["task.read", "task.update"],
  status: "active",
  deployment_id: deploymentId,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "13",
};

function request(capabilityId = "task.read"): TenantContextIssueRequest {
  return {
    workspace_connection: structuredClone(workspaceConnection),
    tenant_revision: "7",
    slack: {
      event_id: "Ev-company-authority-1",
      channel_id: "C-backoffice",
      thread_ts: "1.0",
      requester_id: "U-UMEDA",
    },
    actor: {
      principal_id: "runtime-self-asserted-person",
      principal_type: "person",
      authenticated_subject_id: "runtime-self-asserted-subject",
    },
    authorization: {
      organization_ids: ["runtime-self-asserted-org"],
      project_ids: ["runtime-self-asserted-project"],
      data_scopes: ["admin"],
      capability_ids: ["admin"],
    },
    correlation_id: correlationId,
    operation_id: operationId,
    billing_principal_id: "runtime-self-asserted-billing",
    required_connection_scopes: ["app_mentions:read", "chat:write"],
    required_authorization: {
      audience: "mana-runtime",
      project_id: "project-unson-backoffice",
      capability_id: capabilityId,
    },
  };
}

function canonicalContext(
  capabilityId = "task.read",
  desiredEffect: "read" | "write" | "external_side_effect" = "read",
): TenantContextEnvelope {
  return {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: tenantId, tenant_revision: "7" },
    workspace_connection: {
      connection_id: connectionId,
      connection_revision: "11",
      provider: "slack",
      installation_id: "installation-a",
      workspace_id: "workspace-a",
      app_id: "app-a",
      status: "active",
    },
    actor: {
      principal_id: "person-umeda",
      principal_type: "person",
      authenticated_subject_id: "U-UMEDA",
    },
    authorization: {
      organization_ids: ["organization-unson"],
      project_ids: ["project-unson-backoffice"],
      capability_ids: [capabilityId],
      data_scopes: [
        "company_authority:decision:auto",
        "company_authority:membership:membership-umeda@3",
        "company_authority:resource:project:project-unson-backoffice@12",
        "company_authority:raci:5",
        "company_authority:policy:8",
        `company_authority:effect:${desiredEffect}`,
        "company_authority:placement:placement-backoffice",
        "company_authority:identity_receipt:idres-umeda",
        "company_authority:authority_receipt:authres-task",
      ],
    },
    placement: { deployment_id: deploymentId, profile: "shared_cloud" },
    slack: {
      event_id: "Ev-company-authority-1",
      channel_id: "C-backoffice",
      thread_ts: "1.0",
      requester_id: "U-UMEDA",
    },
    correlation_id: correlationId,
    operation_id: operationId,
    idempotency_key: idempotencyKey,
    contract_revision: "13",
    credential: {
      mode: "customer_oauth",
      credential_ref: "credential-ref-a",
      billing_principal_id: "person-umeda",
    },
    issued_at: "2026-08-19T09:00:00Z",
    expires_at: "2026-08-19T09:05:00Z",
    integrity: {
      method: "jws_detached",
      algorithm: "EdDSA",
      key_id: "brainbase-key-1",
      value: "signed-company-authority-context",
    },
  };
}

function clientsWithResponse(responseContext: TenantContextEnvelope, captures: unknown[]) {
  const service = {
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captures.push(JSON.parse(String(init?.body)));
      return Response.json(responseContext);
    }),
  };
  return createTenantRuntimeHttpClients({
    deployment_profile: "shared_cloud",
    service,
    timeout_ms: 1_000,
    workspace_connections: [{ ...workspaceConnection, tenant_revision: "7" }],
  });
}

describe("Brainbase-owned company authority HTTP client", () => {
  it("sends the placement trusted project set and rejects a signed set with extra projects", async () => {
    const captures: unknown[] = [];
    const context = canonicalContext();
    context.authorization.project_ids = ["project-unson-backoffice", "project-mana", "project-other"];
    const clients = clientsWithResponse(context, captures);
    const trustedRequest = {
      ...request(),
      trusted_project_ids: ["project-unson-backoffice", "project-mana"],
    };

    await expect(clients.authority.issue_tenant_context(trustedRequest)).rejects.toSatisfy((error: unknown) => (
      error instanceof TenantBoundaryError && error.code === "PROJECT_SCOPE_MISMATCH"
    ));
    expect((captures[0] as { requested_action: Record<string, unknown> }).requested_action.project_ids)
      .toEqual(["project-unson-backoffice", "project-mana"]);
  });

  it("accepts a signed project set only when it exactly matches the placement trust set", async () => {
    const captures: unknown[] = [];
    const context = canonicalContext();
    context.authorization.project_ids = ["project-unson-backoffice", "project-mana"];
    const clients = clientsWithResponse(context, captures);
    const trustedRequest = {
      ...request(),
      trusted_project_ids: ["project-unson-backoffice", "project-mana"],
    };

    // This is the same request shape that the placement resolver will provide.
    // It is intentionally exercised before the implementation exists.
    await expect(clients.authority.issue_tenant_context(trustedRequest)).resolves.toEqual(context);
  });

  it("sends only observed identity and requested action, never runtime actor or authorization", async () => {
    const captures: unknown[] = [];
    const clients = clientsWithResponse(canonicalContext(), captures);

    const context = await clients.authority.issue_tenant_context(request());
    const body = captures[0] as Record<string, unknown>;

    expect(body).not.toHaveProperty("actor");
    expect(body).not.toHaveProperty("authorization");
    expect(body).not.toHaveProperty("billing_principal_id");
    expect(body.required_connection_scopes).toEqual(["app_mentions:read", "chat:write"]);
    expect(body.provider_identity).toEqual({
      provider: "slack",
      authenticated_subject_id: "U-UMEDA",
      workspace_id: "workspace-a",
      app_id: "app-a",
    });
    expect(body.requested_action).toEqual({
      capability_id: "task.read",
      resource_ref: "project:project-unson-backoffice",
      project_hint: "project-unson-backoffice",
      desired_effect: "read",
    });
    expect(context.actor.principal_id).toBe("person-umeda");
    expect(context.authorization.organization_ids).toEqual(["organization-unson"]);
  });

  it("infers write effect from a mutation capability and requires matching signed authority evidence", async () => {
    const captures: unknown[] = [];
    const clients = clientsWithResponse(canonicalContext("task.update", "write"), captures);

    await clients.authority.issue_tenant_context(request("task.update"));
    const body = captures[0] as { requested_action: { desired_effect: string } };
    expect(body.requested_action.desired_effect).toBe("write");
  });

  it("fails closed when Brainbase returns a signed tenant context without company authority receipts", async () => {
    const captures: unknown[] = [];
    const invalid = canonicalContext();
    invalid.authorization.data_scopes = invalid.authorization.data_scopes.filter(
      (scope) => !scope.startsWith("company_authority:authority_receipt:"),
    );
    const clients = clientsWithResponse(invalid, captures);

    await expect(clients.authority.issue_tenant_context(request())).rejects.toSatisfy((error: unknown) => (
      error instanceof TenantBoundaryError
      && error.code === "COMPANY_AUTHORITY_EVIDENCE_MISSING"
    ));
  });

  it("rejects canonical actor, project, capability and effect mismatches", async () => {
    const mutations: Array<(context: TenantContextEnvelope) => void> = [
      (context) => { context.actor.authenticated_subject_id = "U-OTHER"; },
      (context) => { context.authorization.project_ids = ["project-other"]; },
      (context) => { context.authorization.capability_ids = ["admin"]; },
      (context) => {
        context.authorization.data_scopes = context.authorization.data_scopes
          .filter((scope) => scope !== "company_authority:effect:read")
          .concat("company_authority:effect:write");
      },
    ];

    for (const mutate of mutations) {
      const captures: unknown[] = [];
      const context = canonicalContext();
      mutate(context);
      const clients = clientsWithResponse(context, captures);
      await expect(clients.authority.issue_tenant_context(request())).rejects.toBeInstanceOf(TenantBoundaryError);
    }
  });
});
