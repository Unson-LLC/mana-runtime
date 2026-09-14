import { describe, expect, it, vi } from "vitest";
import type { CredentialLease, CredentialLeaseBinding, TenantContextEnvelope } from "../multitenancy/contracts.js";
import { createBrainbaseTrustedProviderForwarderFromEnv } from "../multitenancy/trusted-provider-forwarder.js";

const binding: CredentialLeaseBinding = {
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  contract_revision: "11",
  operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  audience: "mcp.freee.co.jp",
  credential_mode: "customer_oauth",
  credential_ref: "opaque-freee-credential-ref",
};

const lease: CredentialLease = {
  message_type: "credential_lease_response",
  protocol_version: "1.0",
  lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0",
  contract_revision: binding.contract_revision,
  binding,
  issued_at: "2026-09-14T00:00:00.000Z",
  expires_at: "2026-09-14T00:00:59.000Z",
  max_uses: 1,
  lease_token: "opaque-lease-token-not-provider-material",
};

const tenantContext = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime"],
  tenant: { tenant_id: binding.tenant_id, tenant_revision: "3" },
  workspace_connection: {
    connection_id: binding.connection_id,
    connection_revision: binding.connection_revision,
    provider: "slack",
    installation_id: "installation-a",
    workspace_id: "T-A",
    app_id: "A-MANA",
    status: "active",
  },
  actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "U-A" },
  authorization: { organization_ids: ["organization-a"], project_ids: ["project-a"], data_scopes: ["freee:read"], capability_ids: ["freee.read"] },
  placement: { deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX", profile: "shared_cloud" },
  slack: { event_id: "Ev-A-001", channel_id: "C-A", thread_ts: "1723800000.000001" },
  correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  operation_id: binding.operation_id,
  idempotency_key: "idem:v1:freee-read",
  contract_revision: binding.contract_revision,
  credential: { mode: binding.credential_mode, credential_ref: binding.credential_ref, billing_principal_id: "billing-a" },
  issued_at: "2026-09-13T23:59:00.000Z",
  expires_at: "2026-09-14T00:04:00.000Z",
  integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "key-a", value: "protected..signature" },
} satisfies TenantContextEnvelope;

describe("freee trusted provider forwarding", () => {
  it("maps Remote MCP requests to the explicit freee.mcp.post provider operation", async () => {
    const serviceFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.provider_operation).toBe("freee.mcp.post");
      expect(body.audience).toBe("mcp.freee.co.jp");
      expect(body.request).toEqual({
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      return Response.json({
        provider: "freee",
        operation_id: binding.operation_id,
        provider_operation: "freee.mcp.post",
        status: 200,
        response_encoding: "json",
        content_type: "application/json",
        body: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      });
    });

    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      tenant_context: tenantContext,
      env: {
        BRAINBASE_TENANT_RUNTIME_SERVICE: { fetch: serviceFetch },
        FREEE_MCP_BASE_URL: "https://mcp.freee.co.jp",
      },
    });

    const response = await forwarder.forward({
      lease,
      expected_binding: binding,
      request: new Request("https://mcp.freee.co.jp/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer must-be-stripped" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      now: "2026-09-14T00:00:01.000Z",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });
});
