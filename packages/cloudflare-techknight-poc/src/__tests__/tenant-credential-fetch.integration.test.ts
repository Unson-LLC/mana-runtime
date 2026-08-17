import { describe, expect, it, vi } from "vitest";

import { createTenantCredentialFetch } from "../multitenancy/tenant-credential-fetch.js";
import {
  createDurableTenantCredentialRegistry,
  TenantCredentialRelayHandler,
} from "../multitenancy/durable-credential-relay.js";
import {
  createIdempotencyKey,
  signTenantContextEnvelope,
  type CredentialBrokerClient,
  type CredentialLease,
  type CredentialLeaseRequest,
  type ExpectedTenantScope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "../multitenancy/index.js";

const NOW = "2026-08-17T01:00:00.000Z";
const SNAPSHOT: WorkspaceConnectionSnapshot = {
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  installation_id: "I-A",
  workspace_id: "T-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["files:read", "chat:write"],
  status: "active",
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "11",
};

const EXPECTED_SCOPE: ExpectedTenantScope = {
  audience: "mana-runtime",
  workspace_id: "T-A",
  app_id: "A-MANA",
  channel_id: "C-A",
  thread_ts: "1723800000.000001",
  actor_principal_id: "person-a",
  project_id: "project-a",
  capability_id: "task.write",
  deployment_id: SNAPSHOT.deployment_id,
};

class CredentialNamespace {
  readonly handlers = new Map<string, TenantCredentialRelayHandler>();
  readonly claimed = new Set<string>();
  readonly providerFetch = vi.fn(async (request: Request) => Response.json({
    authorization: request.headers.get("authorization"),
    apiKey: request.headers.get("x-api-key"),
    xcToken: request.headers.get("xc-token"),
    url: request.url,
  }));

  idFromName(name: string): string { return name; }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return { fetch: (request) => {
      let handler = this.handlers.get(key);
      if (!handler) {
        handler = new TenantCredentialRelayHandler(this.providerFetch as unknown as typeof fetch, {
          claim: async (leaseId) => {
            if (this.claimed.has(leaseId)) return false;
            this.claimed.add(leaseId);
            return true;
          },
        });
        this.handlers.set(key, handler);
      }
      return handler.fetch(request);
    } };
  }
}

async function signedEnvelope() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const unsigned: UnsignedTenantContextEnvelope = {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: SNAPSHOT.tenant_id, tenant_revision: "3" },
    workspace_connection: {
      connection_id: SNAPSHOT.connection_id,
      connection_revision: SNAPSHOT.connection_revision,
      provider: "slack",
      installation_id: SNAPSHOT.installation_id,
      workspace_id: SNAPSHOT.workspace_id,
      app_id: SNAPSHOT.app_id,
      status: "active",
    },
    actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "U-A" },
    authorization: {
      organization_ids: ["organization-a"],
      project_ids: ["project-a"],
      data_scopes: ["tasks:tenant"],
      capability_ids: ["task.write"],
    },
    placement: { deployment_id: SNAPSHOT.deployment_id, profile: "shared_cloud" },
    slack: { event_id: "Ev-A-001", channel_id: "C-A", thread_ts: "1723800000.000001", requester_id: "U-A" },
    correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    idempotency_key: "pending",
    contract_revision: SNAPSHOT.contract_revision,
    credential: { mode: "customer_oauth", credential_ref: "opaque-credential-ref-a", billing_principal_id: "billing-a" },
    issued_at: "2026-08-17T00:59:00.000Z",
    expires_at: "2026-08-17T01:04:00.000Z",
  };
  unsigned.idempotency_key = await createIdempotencyKey({
    protocol_id: unsigned.protocol_id,
    protocol_major: "1",
    tenant_id: unsigned.tenant.tenant_id,
    connection_id: unsigned.workspace_connection.connection_id,
    slack_event_id: unsigned.slack.event_id,
    operation_id: unsigned.operation_id,
  });
  return {
    envelope: await signTenantContextEnvelope(unsigned, keys.privateKey, "test-key-1"),
    publicKey: keys.publicKey,
  };
}

describe("tenant credential fetch integration", () => {
  it("acquires and consumes a fresh 60-second single-use lease for every outbound request", async () => {
    const { envelope, publicKey } = await signedEnvelope();
    const namespace = new CredentialNamespace();
    const requests: CredentialLeaseRequest[] = [];
    const broker: CredentialBrokerClient = {
      acquire_lease: vi.fn(async (request: CredentialLeaseRequest): Promise<CredentialLease> => {
        requests.push(structuredClone(request));
        const suffix = requests.length === 1 ? "B0" : "B1";
        return {
          message_type: "credential_lease_response",
          protocol_version: "1.0",
          lease_id: `lease_01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`,
          contract_revision: request.binding.contract_revision,
          binding: request.binding,
          issued_at: "2026-08-17T00:59:50.000Z",
          expires_at: "2026-08-17T01:00:50.000Z",
          max_uses: 1,
          lease_token: `test-provider-token-${requests.length}`,
        };
      }),
    };
    const tenantFetch = createTenantCredentialFetch({
      envelope,
      expected_scope: EXPECTED_SCOPE,
      broker,
      credential_registry: createDurableTenantCredentialRegistry(namespace),
      credential_relay: namespace,
      read_authoritative_snapshot: async () => SNAPSHOT,
      resolve_verification_key: async (keyId) => keyId === "test-key-1" ? publicKey : undefined,
      now: () => NOW,
    });

    const first = await tenantFetch("https://slack.com/api/files.info?file=F1", {
      headers: { authorization: "Bearer placeholder-must-be-replaced" },
    });
    const second = await tenantFetch("https://slack.com/files-pri/T-A-F1/download", {
      headers: { authorization: "Bearer placeholder-must-be-replaced" },
    });

    await expect(first.json()).resolves.toMatchObject({ authorization: "Bearer test-provider-token-1" });
    await expect(second.json()).resolves.toMatchObject({ authorization: "Bearer test-provider-token-2" });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.requested_ttl_seconds === 60)).toBe(true);
    expect(requests.every((request) => request.binding.audience === "slack.com")).toBe(true);
    expect(namespace.providerFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed for non-HTTPS targets before asking the broker", async () => {
    const { envelope, publicKey } = await signedEnvelope();
    const namespace = new CredentialNamespace();
    const broker = { acquire_lease: vi.fn() } as unknown as CredentialBrokerClient;
    const tenantFetch = createTenantCredentialFetch({
      envelope,
      expected_scope: EXPECTED_SCOPE,
      broker,
      credential_registry: createDurableTenantCredentialRegistry(namespace),
      credential_relay: namespace,
      read_authoritative_snapshot: async () => SNAPSHOT,
      resolve_verification_key: async (keyId) => keyId === "test-key-1" ? publicKey : undefined,
      now: () => NOW,
    });

    await expect(tenantFetch("http://slack.com/api/files.info")).rejects.toMatchObject({
      code: "CREDENTIAL_LEASE_BINDING_MISMATCH",
    });
    expect(broker.acquire_lease).not.toHaveBeenCalled();
  });

  it("routes an opaque lease into the provider-specific NocoDB header without forwarding placeholders", async () => {
    const { envelope, publicKey } = await signedEnvelope();
    const namespace = new CredentialNamespace();
    const broker: CredentialBrokerClient = {
      acquire_lease: vi.fn(async (request: CredentialLeaseRequest): Promise<CredentialLease> => ({
        message_type: "credential_lease_response",
        protocol_version: "1.0",
        lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB2",
        contract_revision: request.binding.contract_revision,
        binding: request.binding,
        issued_at: "2026-08-17T00:59:50.000Z",
        expires_at: "2026-08-17T01:00:50.000Z",
        max_uses: 1,
        lease_token: "test-nocodb-token",
      })),
    };
    const tenantFetch = createTenantCredentialFetch({
      envelope,
      expected_scope: EXPECTED_SCOPE,
      broker,
      credential_registry: createDurableTenantCredentialRegistry(namespace),
      credential_relay: namespace,
      read_authoritative_snapshot: async () => SNAPSHOT,
      resolve_verification_key: async (keyId) => keyId === "test-key-1" ? publicKey : undefined,
      now: () => NOW,
      credential_header: "xc-token",
    });

    const response = await tenantFetch("https://nocodb.example.test/api/v1/db/data/noco/project/table", {
      headers: {
        authorization: "Bearer must-not-leak",
        "x-api-key": "must-not-leak",
        "xc-token": "tenant-credential-injected",
      },
    });

    await expect(response.json()).resolves.toMatchObject({
      authorization: null,
      apiKey: null,
      xcToken: "test-nocodb-token",
    });
  });
});
