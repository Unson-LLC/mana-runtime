import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CredentialLease,
  CredentialLeaseBinding,
  TenantContextEnvelope,
} from "../multitenancy/contracts.js";
import {
  createBrainbaseTrustedProviderForwarderFromEnv,
} from "../multitenancy/trusted-provider-forwarder.js";

const SERVICE_TOKEN = "brainbase-internal-service-token-placeholder";
const BINDING: CredentialLeaseBinding = {
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  contract_revision: "11",
  operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  audience: "api.anthropic.com",
  credential_mode: "customer_oauth",
  credential_ref: "opaque-credential-ref-a",
};
const LEASE: CredentialLease = {
  message_type: "credential_lease_response",
  protocol_version: "1.0",
  lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0",
  contract_revision: BINDING.contract_revision,
  binding: BINDING,
  issued_at: "2026-08-17T01:00:00.000Z",
  expires_at: "2026-08-17T01:00:59.000Z",
  max_uses: 1,
  lease_token: "opaque-lease-token-not-provider-material",
};
const TENANT_CONTEXT = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime"],
  tenant: { tenant_id: BINDING.tenant_id, tenant_revision: "3" },
  workspace_connection: {
    connection_id: BINDING.connection_id,
    connection_revision: BINDING.connection_revision,
    provider: "slack",
    installation_id: "installation-a",
    workspace_id: "T-A",
    app_id: "A-MANA",
    status: "active",
  },
  actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "U-A" },
  authorization: {
    organization_ids: ["organization-a"],
    project_ids: ["project-a"],
    data_scopes: ["tasks:tenant"],
    capability_ids: ["task.write"],
  },
  placement: { deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX", profile: "shared_cloud" },
  slack: { event_id: "Ev-A-001", channel_id: "C-A", thread_ts: "1723800000.000001" },
  correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  operation_id: BINDING.operation_id,
  idempotency_key: "idem:v1:test",
  contract_revision: BINDING.contract_revision,
  credential: {
    mode: BINDING.credential_mode,
    credential_ref: BINDING.credential_ref,
    billing_principal_id: "billing-a",
  },
  issued_at: "2026-08-17T00:59:00.000Z",
  expires_at: "2026-08-17T01:04:00.000Z",
  integrity: {
    method: "jws_detached",
    algorithm: "EdDSA",
    key_id: "key-a",
    value: "protected..signature",
  },
} satisfies TenantContextEnvelope;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return { server, port: address.port };
}

describe("Brainbase trusted provider forwarder HTTP integration", () => {
  it("forwards an allowlisted provider operation through the dedicated internal mana route", async () => {
    let observed: { headers: Record<string, string | string[] | undefined>; body: unknown; url?: string } | undefined;
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed = {
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          url: request.url,
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          provider: "anthropic",
          operation_id: BINDING.operation_id,
          status: 200,
          body: { id: "msg_provider_a", type: "message" },
        }));
      });
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: {
        BRAINBASE_TENANT_RUNTIME_PORT: String(port),
        BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      tenant_context: TENANT_CONTEXT,
    });

    const result = await forwarder.forward({
      lease: LEASE,
      expected_binding: BINDING,
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${LEASE.lease_token}`,
          "x-api-key": LEASE.lease_token,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
      }),
      now: "2026-08-17T01:00:01.000Z",
    });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ id: "msg_provider_a", type: "message" });
    expect(observed?.url).toBe("/api/v1/runtime/provider-requests:forward");
    expect(observed?.headers).toMatchObject({
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "brainbase-protocol-version": "1.0",
      "brainbase-deployment-id": TENANT_CONTEXT.placement.deployment_id,
      "content-type": "application/json",
    });
    expect(observed?.headers["x-api-key"]).toBeUndefined();
    expect(observed?.headers["anthropic-version"]).toBeUndefined();
    expect(observed?.body).toEqual({
      tenant_context: TENANT_CONTEXT,
      lease_id: LEASE.lease_id,
      lease_token: LEASE.lease_token,
      audience: BINDING.audience,
      provider_operation: "anthropic.messages.create",
      body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] },
    });
  });

  it.each([
    ["missing port", { BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
    ["missing token", { BRAINBASE_TENANT_RUNTIME_PORT: "31016" }],
    ["wildcard host", {
      BRAINBASE_TENANT_RUNTIME_HOST: "0.0.0.0",
      BRAINBASE_TENANT_RUNTIME_PORT: "31016",
      BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
    }],
  ])("rejects unsafe internal service configuration: %s", (_label, env) => {
    expect(() => createBrainbaseTrustedProviderForwarderFromEnv({
      env,
      tenant_context: TENANT_CONTEXT,
    })).toThrow("runtime_configuration_invalid");
  });

  it("maps Brainbase reflection rejection to a fail-closed tenant boundary error", async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(502, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "UPSTREAM_INVALID_RESPONSE", status: 502 }));
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: {
        BRAINBASE_TENANT_RUNTIME_PORT: String(port),
        BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      tenant_context: TENANT_CONTEXT,
    });

    await expect(forwarder.forward({
      lease: LEASE,
      expected_binding: BINDING,
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      now: "2026-08-17T01:00:01.000Z",
    })).rejects.toMatchObject({
      boundary: "credential_lease",
      code: "UPSTREAM_INVALID_RESPONSE",
    });
  });
});
