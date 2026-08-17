import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  tenantBoundaryCredentialMarker,
  tenantBoundaryHandleFromCredentialAuthorization,
  TenantBoundaryContextHandler,
  TENANT_BOUNDARY_HANDLE_HEADER,
} from "../multitenancy/durable-tenant-boundary.js";
import {
  TenantCredentialRelayHandler,
} from "../multitenancy/durable-credential-relay.js";
import {
  createIdempotencyKey,
  signTenantContextEnvelope,
  type BoundaryName,
  type CredentialLeaseRequest,
  type ExpectedTenantScope,
  type TenantContextEnvelope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "../multitenancy/index.js";
import {
  authorizeTenantProviderOutbound,
  type TenantProviderOutboundEnv,
} from "../multitenancy/tenant-provider-outbound.js";

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
  capability_id: "runtime.execute",
  deployment_id: SNAPSHOT.deployment_id,
};

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
  setAlarm(_scheduledTime: number | Date): Promise<void> { return Promise.resolve(); }
}

class TenantRuntimeNamespace {
  readonly handlers = new Map<string, { fetch(request: Request): Promise<Response> }>();
  readonly claimedLeaseIds = new Set<string>();
  readonly providerRequests: Array<{ url: string; authorization: string | null }> = [];

  idFromName(name: string): string { return name; }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return {
      fetch: (request) => {
        let handler = this.handlers.get(key);
        if (!handler) {
          if (key.startsWith("boundary:")) {
            handler = new TenantBoundaryContextHandler(
              new MemoryStorage(),
              async (_input: {
                boundary: BoundaryName;
                tenant_context: TenantContextEnvelope;
                expected_scope: ExpectedTenantScope;
                now: string;
              }) => undefined,
            );
          } else {
            handler = new TenantCredentialRelayHandler(async (providerRequest) => {
              const request = new Request(providerRequest);
              this.providerRequests.push({
                url: request.url,
                authorization: request.headers.get("authorization"),
              });
              return Response.json({ ok: true });
            }, {
              claim: async (leaseId) => {
                if (this.claimedLeaseIds.has(leaseId)) return false;
                this.claimedLeaseIds.add(leaseId);
                return true;
              },
            });
          }
          this.handlers.set(key, handler);
        }
        return handler.fetch(request);
      },
    };
  }
}

async function signedEnvelope() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const issuedAt = new Date(Date.now() - 10_000).toISOString();
  const expiresAt = new Date(Date.now() + 280_000).toISOString();
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
      data_scopes: ["runtime:tenant"],
      capability_ids: ["runtime.execute"],
    },
    placement: { deployment_id: SNAPSHOT.deployment_id, profile: "shared_cloud" },
    slack: {
      event_id: "Ev-A-001",
      channel_id: "C-A",
      thread_ts: "1723800000.000001",
      requester_id: "U-A",
    },
    correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    idempotency_key: "pending",
    contract_revision: SNAPSHOT.contract_revision,
    credential: {
      mode: "customer_oauth",
      credential_ref: "opaque-credential-ref-a",
      billing_principal_id: "billing-a",
    },
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  unsigned.idempotency_key = await createIdempotencyKey({
    protocol_id: unsigned.protocol_id,
    protocol_major: "1",
    tenant_id: unsigned.tenant.tenant_id,
    connection_id: unsigned.workspace_connection.connection_id,
    slack_event_id: unsigned.slack.event_id,
    operation_id: unsigned.operation_id,
  });
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    envelope: await signTenantContextEnvelope(unsigned, keys.privateKey, "test-key-1"),
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key-1", use: "sig", alg: "EdDSA" }] }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sandbox provider credential integration", () => {
  it("acquires a different single-use lease for every Anthropic and GitHub HTTP request", async () => {
    const { envelope, jwks } = await signedEnvelope();
    const namespace = new TenantRuntimeNamespace();
    const leaseRequests: CredentialLeaseRequest[] = [];
    const leaseSuffixes = ["B0", "B1", "B2", "B3"];
    const upstreamFetch = vi.fn(async (requestInfo: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(requestInfo, init);
      const url = new URL(request.url);
      if (url.hostname === "authority.example.test") {
        return Response.json({ result: SNAPSHOT });
      }
      if (url.hostname === "broker.example.test") {
        const leaseRequest = await request.json() as CredentialLeaseRequest;
        leaseRequests.push(structuredClone(leaseRequest));
        const leaseNumber = leaseRequests.length;
        const leaseNow = Date.now();
        return Response.json({
          result: {
            message_type: "credential_lease_response",
            protocol_version: "1.0",
            lease_id: `lease_01ARZ3NDEKTSV4RRFFQ69G5F${leaseSuffixes[leaseNumber - 1]}`,
            contract_revision: leaseRequest.binding.contract_revision,
            binding: leaseRequest.binding,
            issued_at: new Date(leaseNow).toISOString(),
            expires_at: new Date(leaseNow + 59_000).toISOString(),
            max_uses: 1,
            lease_token: `test-provider-token-${leaseNumber}`,
          },
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    });
    vi.stubGlobal("fetch", upstreamFetch);

    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({
      tenant_context: envelope,
      expected_scope: EXPECTED_SCOPE,
      now: new Date().toISOString(),
    });
    const marker = tenantBoundaryCredentialMarker(handle);
    expect(tenantBoundaryHandleFromCredentialAuthorization(`Bearer ${marker}`)).toBe(handle);
    const resolved = await resolveDurableTenantBoundaryContext(
      namespace,
      new Request("https://api.anthropic.com/v1/messages", {
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
      }),
      ["mcp_gateway", "brainbase_proxy"],
      new Date().toISOString(),
    );
    expect(resolved).not.toBeInstanceOf(Response);
    const env = {
      TENANT_RUNTIME_STATE: namespace,
      MANA_DEPLOYMENT_PROFILE: "shared_cloud",
      BRAINBASE_TENANT_AUTHORITY_URL: "https://authority.example.test/runtime",
      BRAINBASE_CREDENTIAL_BROKER_URL: "https://broker.example.test/runtime",
      BRAINBASE_QUOTA_URL: "https://quota.example.test/runtime",
      BRAINBASE_ACCOUNTING_URL: "https://accounting.example.test/runtime",
      BRAINBASE_RUNTIME_API_TOKEN: "test-runtime-auth-placeholder",
      BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS: "5000",
      BRAINBASE_TENANT_CONTEXT_JWKS_JSON: jwks,
    } as TenantProviderOutboundEnv;

    const responses = await Promise.all([
      authorizeTenantProviderOutbound(new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${marker}` },
        body: "{}",
      }), env),
      authorizeTenantProviderOutbound(new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${marker}` },
        body: "{}",
      }), env),
      authorizeTenantProviderOutbound(new Request("https://github.com/example/repo.git/info/refs", {
        headers: { authorization: `Bearer ${marker}` },
      }), env, "github-basic"),
      authorizeTenantProviderOutbound(new Request("https://github.com/example/repo.git/git-upload-pack", {
        method: "POST",
        headers: { authorization: `Bearer ${marker}` },
        body: "request-body",
      }), env, "github-basic"),
    ]);

    const responseBodies = await Promise.all(responses.map((response) => response.clone().text()));
    expect({
      statuses: responses.map((response) => response.status),
      responseBodies,
      leaseRequestCount: leaseRequests.length,
      providerRequestCount: namespace.providerRequests.length,
    }).toEqual({
      statuses: [200, 200, 200, 200],
      responseBodies: ["{\"ok\":true}", "{\"ok\":true}", "{\"ok\":true}", "{\"ok\":true}"],
      leaseRequestCount: 4,
      providerRequestCount: 4,
    });
    expect(leaseRequests).toHaveLength(4);
    expect(new Set(leaseRequests.map((request) => request.binding.audience)))
      .toEqual(new Set(["api.anthropic.com", "github.com"]));
    expect(leaseRequests.every((request) => request.requested_ttl_seconds === 60)).toBe(true);
    expect(namespace.claimedLeaseIds.size).toBe(4);
    expect(namespace.providerRequests).toHaveLength(4);
    expect(namespace.providerRequests.slice(0, 2).map((request) => request.authorization))
      .toEqual(["Bearer test-provider-token-1", "Bearer test-provider-token-2"]);
    expect(namespace.providerRequests.slice(2).map((request) => request.authorization))
      .toEqual([
        `Basic ${btoa("x-access-token:test-provider-token-3")}`,
        `Basic ${btoa("x-access-token:test-provider-token-4")}`,
      ]);
    expect(namespace.providerRequests.every((request) => !request.authorization?.includes(handle))).toBe(true);
  });
});
