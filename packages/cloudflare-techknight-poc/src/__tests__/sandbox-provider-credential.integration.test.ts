import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  TenantBoundaryContextHandler,
  TENANT_BOUNDARY_HANDLE_HEADER,
} from "../multitenancy/durable-tenant-boundary.js";
import { TenantRuntimeStateHandler } from "../multitenancy/tenant-runtime-state.js";
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
  createBrainbaseTrustedProviderForwarderFromEnv,
  type TrustedProviderForwarder,
} from "../multitenancy/trusted-provider-forwarder.js";
import {
  authorizeTenantProviderOutbound,
  tenantCredentialFetchForResolvedContext,
  type TenantProviderOutboundEnv,
} from "../multitenancy/tenant-provider-outbound.js";
import {
  deliverTenantGatewaySlackMessage,
  type TenantGatewayDeliveryEnv,
} from "../multitenancy/tenant-gateway-delivery.js";
import {
  failDevelopmentTerminalOutboxRecord,
  proxyDevelopmentCallback,
  retryDevelopmentTerminalOutboxRecord,
} from "../multitenancy/development-callback-proxy.js";
import {
  claimDevelopmentJobOwner,
  developmentOwnerFromContext,
} from "../multitenancy/development-job-owner.js";
import { createDurableTenantStateClient } from "../multitenancy/tenant-runtime-state.js";
import {
  createDevelopmentTerminalOutboxClient,
  DevelopmentTerminalOutboxHandler,
} from "../multitenancy/development-terminal-outbox.js";
import { developmentJobIdForTenantOperation } from "../development-runner-client.js";
import { handleNocodbProxyRequest } from "../nocodb-proxy.js";

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
  alarmAt?: number;
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    return Promise.resolve();
  }
  transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> { return callback(this); }
}

class TenantRuntimeNamespace {
  readonly handlers = new Map<string, { fetch(request: Request): Promise<Response> }>();
  readonly storages = new Map<string, MemoryStorage>();
  readonly claimedLeaseIds = new Set<string>();
  readonly providerRequests: Array<{
    url: string;
    authorization: string | null;
    apiKey: string | null;
    xcToken: string | null;
  }> = [];

  idFromName(name: string): string { return name; }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return {
      fetch: (request) => {
        let handler = this.handlers.get(key);
        if (!handler) {
          let storage = this.storages.get(key);
          if (!storage) {
            storage = new MemoryStorage();
            this.storages.set(key, storage);
          }
          if (key.startsWith("boundary:")) {
            handler = new TenantBoundaryContextHandler(
              storage,
              async (_input: {
                boundary: BoundaryName;
                tenant_context: TenantContextEnvelope;
                expected_scope: ExpectedTenantScope;
                now: string;
              }) => undefined,
            );
          } else if (key.startsWith("state:") || key.startsWith("accounting:")) {
            handler = new TenantRuntimeStateHandler(storage);
          } else if (key.startsWith("development-terminal:")) {
            handler = new DevelopmentTerminalOutboxHandler(storage, storage);
          } else {
            throw new Error(`unexpected_tenant_runtime_namespace:${key}`);
          }
          this.handlers.set(key, handler);
        }
        return handler.fetch(request);
      },
    };
  }
}

function trustedForwarderForTest(
  namespace: TenantRuntimeNamespace,
  materialByOpaqueHandle: ReadonlyMap<string, string>,
  tenantContext: TenantContextEnvelope,
): TrustedProviderForwarder {
  return createBrainbaseTrustedProviderForwarderFromEnv({
    env: {
      BRAINBASE_TENANT_RUNTIME_ENABLED: "1",
      BRAINBASE_TENANT_RUNTIME_PORT: "31016",
      BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: "brainbase-service-token-placeholder",
      BRAINBASE_TASK_API_BASE_URL: "https://tasks.example.test",
      BRAINBASE_GRAPH_API_BASE_URL: "https://graph.example.test",
      BRAINBASE_MCP_BASE_URL: "https://mcp.example.test",
      GOOGLE_DRIVE_MCP_BASE_URL: "https://drive.example.test",
      NOCODB_URL: "https://nocodb.example.test",
    },
    tenant_context: tenantContext,
    fetch_impl: async (requestInfo, init) => {
      const request = new Request(requestInfo, init);
      const input = await request.json() as {
        tenant_context: TenantContextEnvelope;
        lease_id: string;
        lease_token: string;
        audience: string;
        provider_operation: string;
        request: unknown;
      };
      expect(request.url).toBe("http://127.0.0.1:31016/api/v1/runtime/provider-requests:forward");
      expect(request.headers.get("authorization")).toBe("Bearer brainbase-service-token-placeholder");
      expect(request.headers.get("brainbase-protocol-version")).toBe("1.0");
      expect(input.tenant_context).toEqual(tenantContext);
      const material = materialByOpaqueHandle.get(input.lease_token);
      if (!material) throw new Error("trusted_materialization_unavailable");
      if (namespace.claimedLeaseIds.has(input.lease_id)) throw new Error("trusted_materialization_replayed");
      namespace.claimedLeaseIds.add(input.lease_id);
      let authorization: string | null = null;
      let apiKey: string | null = null;
      let xcToken: string | null = null;
      if (input.audience === "github.com") {
        authorization = `Basic ${btoa(`x-access-token:${material}`)}`;
      } else if (input.audience === "api.anthropic.com") {
        apiKey = material;
      } else if (input.audience === "nocodb.example.test") {
        xcToken = material;
      } else {
        authorization = `Bearer ${material}`;
      }
      namespace.providerRequests.push({
        url: input.provider_operation,
        authorization,
        apiKey,
        xcToken,
      });
      const body = input.audience === "slack.com"
        ? { ok: true, ts: "1723800000.000009" }
        : { ok: true };
      return Response.json({
        provider: input.provider_operation.split(".", 1)[0],
        operation_id: tenantContext.operation_id,
        provider_operation: input.provider_operation,
        status: 200,
        response_encoding: "json",
        content_type: "application/json",
        body,
      });
    },
  });
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
  it("reconciles a Container callback that never reached the proxy as durable failed_terminal", async () => {
    const { envelope } = await signedEnvelope();
    const namespace = new TenantRuntimeNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const boundaryHandle = await registry.register({
      tenant_context: envelope,
      expected_scope: EXPECTED_SCOPE,
      now: new Date().toISOString(),
    });
    const jobId = await developmentJobIdForTenantOperation({
      eventId: envelope.slack.event_id,
      tenantId: envelope.tenant.tenant_id,
      connectionId: envelope.workspace_connection.connection_id,
      operationId: envelope.operation_id,
      workspaceId: envelope.workspace_connection.workspace_id,
      channelId: envelope.slack.channel_id,
      threadTs: envelope.slack.thread_ts ?? "",
    });
    const owner = await developmentOwnerFromContext({
      tenant_context: envelope,
      jobId,
      eventId: envelope.slack.event_id,
      requesterId: envelope.actor.authenticated_subject_id,
      placementId: "placement-a",
      quotaDecision: "allowed",
    });
    const ownerStore = createDurableTenantStateClient(namespace, owner.tenantId);
    const claimed = await claimDevelopmentJobOwner(ownerStore, owner, new Date().toISOString());
    expect(claimed.disposition).toBe("claimed");
    const observedAt = new Date().toISOString();
    const deadline = new Date(Date.now() + 1_000).toISOString();
    const outbox = createDevelopmentTerminalOutboxClient(namespace, claimed.claim.partition_key);
    await outbox.arm({
      job_id: jobId,
      payload_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      callback_body: JSON.stringify({ job_id: jobId, status: "timed_out" }),
      owner,
      owner_claim: { key: claimed.claim.key, partition_key: claimed.claim.partition_key },
      observed_at: observedAt,
      activate_at: new Date(Date.now() + 500).toISOString(),
      terminal_deadline_at: deadline,
      container_id: "development-sandbox-timeout-a",
      terminal_accounting: {
        tenant_context: envelope,
        expected_scope: EXPECTED_SCOPE,
        quota_decision: "allowed",
        unit: "container_seconds",
        outcome: "timed_out",
        failure_code: "DEVELOPMENT_RUNNER_TIMED_OUT",
        reply_state: "unknown",
        recorded_at: deadline,
        accounting_effect_id: `development_terminal:${jobId}`,
      },
    });

    namespace.handlers.clear();
    const terminalKey = [...namespace.storages.keys()].find((key) => key.startsWith("development-terminal:"));
    const terminalStorage = namespace.storages.get(terminalKey ?? "");
    const restarted = new DevelopmentTerminalOutboxHandler(terminalStorage!, terminalStorage!);
    const destroyContainer = vi.fn(async (_containerId: string) => undefined);
    const writeAccounting = vi.fn()
      .mockRejectedValueOnce(new Error("accounting unavailable"))
      .mockResolvedValue({ result_ref: "accounting-test-result" });
    const finalize = (finalizeAt: string) => (record: Parameters<typeof failDevelopmentTerminalOutboxRecord>[0]) =>
      failDevelopmentTerminalOutboxRecord(record, {
        TENANT_RUNTIME_STATE: namespace,
      }, finalizeAt, destroyContainer, writeAccounting);
    await expect(restarted.alarm(
      deadline,
      async () => ({ state: "retry", error: "UPSTREAM_UNAVAILABLE" }),
      finalize(deadline),
    )).rejects.toThrow("accounting unavailable");

    await expect(outbox.read()).resolves.toMatchObject({
      state: "failed_terminal",
      owner_finalized: false,
    });
    const pendingAccountingOutboxes = [...namespace.storages.entries()]
      .filter(([key]) => key.startsWith("accounting:"))
      .flatMap(([, storage]) => [...storage.values.entries()])
      .filter(([key]) => key.startsWith("accounting-outbox:"));
    expect(pendingAccountingOutboxes).toHaveLength(1);
    expect(terminalStorage?.alarmAt).toBe(Date.parse(deadline) + 2_000);

    const retryAt = new Date(Date.parse(deadline) + 2_000).toISOString();
    await restarted.alarm(
      retryAt,
      async () => ({ state: "retry", error: "UPSTREAM_UNAVAILABLE" }),
      finalize(retryAt),
    );

    await expect(outbox.read()).resolves.toMatchObject({
      state: "failed_terminal",
      collection_state: "not_collected",
      terminal_outcome: "timed_out",
      owner_finalized: true,
      container_sanitization_receipt: {
        operation_id: envelope.operation_id,
        purpose: "final_destruction",
        reuse_eligible: false,
        result: "passed",
        checks: {
          container_destroyed: true,
          fresh_container_per_attempt: true,
          no_reuse: true,
          cross_tenant_reuse_forbidden: true,
        },
      },
    });
    expect(destroyContainer).toHaveBeenCalledWith("development-sandbox-timeout-a");
    expect(writeAccounting).toHaveBeenCalledTimes(2);
    await expect(claimDevelopmentJobOwner(ownerStore, owner, deadline))
      .resolves.toMatchObject({ disposition: "failed_terminal" });

    const accountingOutboxes = [...namespace.storages.entries()]
      .filter(([key]) => key.startsWith("accounting:"))
      .flatMap(([, storage]) => [...storage.values.entries()])
      .filter(([key]) => key.startsWith("accounting-outbox:"));
    expect(accountingOutboxes).toHaveLength(0);
    expect(writeAccounting.mock.calls[1]?.[0]).toMatchObject({
      artifact: {
        usage_events: [{
          message_type: "usage_event",
          quantity: null,
          collection_state: "not_collected",
          outcome: "timed_out",
          failure_code: "DEVELOPMENT_RUNNER_TIMED_OUT",
        }],
        receipt: {
          message_type: "operation_receipt",
          collection_state: "not_collected",
          outcome: "timed_out",
          failure_code: "DEVELOPMENT_RUNNER_TIMED_OUT",
          reply: { state: "unknown", reply_count: 0, legacy_reply_count: 0 },
        },
      },
    });
    expect(writeAccounting.mock.calls[1]?.[0].artifact)
      .toEqual(writeAccounting.mock.calls[0]?.[0].artifact);
    expect(writeAccounting.mock.calls[1]?.[0].artifact.receipt.completed_at).toBe(deadline);
    const sanitationReceipts = [...terminalStorage!.values.entries()]
      .filter(([key]) => key.startsWith("container-sanitization-receipt:"));
    expect(sanitationReceipts).toHaveLength(1);
    expect(sanitationReceipts[0]?.[1]).toEqual(expect.objectContaining({
      operation_id: envelope.operation_id,
      purpose: "final_destruction",
      reuse_eligible: false,
      result: "passed",
      completed_at: deadline,
    }));
    expect(JSON.stringify(sanitationReceipts[0]?.[1])).not.toMatch(/token|secret|authorization/i);

    await restarted.alarm(retryAt, async () => ({ state: "retry", error: "UPSTREAM_UNAVAILABLE" }),
      finalize(retryAt));
    const accountingOutboxesAfterReplay = [...namespace.storages.entries()]
      .filter(([key]) => key.startsWith("accounting:"))
      .flatMap(([, storage]) => [...storage.values.entries()])
      .filter(([key]) => key.startsWith("accounting-outbox:"));
    expect(accountingOutboxesAfterReplay).toHaveLength(0);
    expect(writeAccounting).toHaveBeenCalledTimes(2);
  });

  it("acquires a different single-use lease for every Anthropic and GitHub HTTP request", async () => {
    const { envelope, jwks } = await signedEnvelope();
    const namespace = new TenantRuntimeNamespace();
    const leaseRequests: CredentialLeaseRequest[] = [];
    const materialByOpaqueHandle = new Map<string, string>();
    const leaseSuffixes = ["B0", "B1", "B2", "B3", "B4"];
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
        const opaqueHandle = `opaque-lease-handle-${leaseNumber}`;
        materialByOpaqueHandle.set(opaqueHandle, `materialized-provider-secret-${leaseNumber}`);
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
            lease_token: opaqueHandle,
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
    const resolved = await resolveDurableTenantBoundaryContext(
      namespace,
      new Request("https://api.anthropic.com/v1/messages", {
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
      }),
      ["mcp_gateway", "brainbase_proxy"],
      new Date().toISOString(),
    );
    expect(resolved).not.toBeInstanceOf(Response);
    if (resolved instanceof Response) throw new Error("test_tenant_boundary_unavailable");
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
    const trustedForwarder = trustedForwarderForTest(namespace, materialByOpaqueHandle, envelope);

    const responses = await Promise.all([
      authorizeTenantProviderOutbound(new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
        body: "{}",
      }), env, trustedForwarder),
      authorizeTenantProviderOutbound(new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
        body: "{}",
      }), env, trustedForwarder),
      authorizeTenantProviderOutbound(new Request("https://github.com/example/repo.git/info/refs", {
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
      }), env, trustedForwarder),
      authorizeTenantProviderOutbound(new Request("https://github.com/example/repo.git/git-upload-pack", {
        method: "POST",
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
        body: "request-body",
      }), env, trustedForwarder),
    ]);

    const responseBodies = await Promise.all(responses.map((response) => response.clone().text()));
    const nocodbResponse = await handleNocodbProxyRequest(
      new Request("https://nocodb.internal/api/runtime/nocodb", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "nocodb_list_records",
          arguments: { baseId: "base-a", tableName: "tasks" },
        }),
      }),
      {
        NOCODB_URL: "https://nocodb.example.test",
        NOCODB_TOKEN: "tenant-credential-injected",
        NOCODB_PROJECT_MAPPING_JSON: JSON.stringify({ "base-a": "project-a" }),
      },
      tenantCredentialFetchForResolvedContext(env, resolved, trustedForwarder),
    );
    expect({
      statuses: responses.map((response) => response.status),
      responseBodies,
      leaseRequestCount: leaseRequests.length,
      providerRequestCount: namespace.providerRequests.length,
      nocodbStatus: nocodbResponse.status,
    }).toEqual({
      statuses: [200, 200, 200, 200],
      responseBodies: ["{\"ok\":true}", "{\"ok\":true}", "{\"ok\":true}", "{\"ok\":true}"],
      leaseRequestCount: 5,
      providerRequestCount: 5,
      nocodbStatus: 200,
    });
    expect(leaseRequests).toHaveLength(5);
    expect(new Set(leaseRequests.map((request) => request.binding.audience)))
      .toEqual(new Set(["api.anthropic.com", "github.com", "nocodb.example.test"]));
    expect(leaseRequests.every((request) => request.requested_ttl_seconds === 60)).toBe(true);
    expect(namespace.claimedLeaseIds.size).toBe(5);
    expect(namespace.providerRequests).toHaveLength(5);
    const anthropicRequests = namespace.providerRequests.filter((request) => request.url === "anthropic.messages.create");
    const githubRequests = namespace.providerRequests.filter((request) => request.url.startsWith("github.git."));
    const nocodbRequest = namespace.providerRequests.find((request) => request.url.startsWith("nocodb."));
    expect(anthropicRequests).toHaveLength(2);
    expect(anthropicRequests.every((request) => request.authorization === null
      && request.apiKey?.startsWith("materialized-provider-secret-") === true)).toBe(true);
    expect(githubRequests).toHaveLength(2);
    expect(githubRequests.every((request) => request.apiKey === null
      && request.authorization?.startsWith("Basic ") === true)).toBe(true);
    expect(nocodbRequest).toMatchObject({
      authorization: null,
      apiKey: null,
      xcToken: expect.stringMatching(/^materialized-provider-secret-/),
    });
    expect(namespace.providerRequests.every((request) => (
      !request.authorization?.includes(handle)
      && !request.apiKey?.includes(handle)
      && !request.xcToken?.includes(handle)
    ))).toBe(true);
    expect(JSON.stringify(namespace.providerRequests)).not.toContain("opaque-lease-handle");

    const legacyMarker = `mana-tenant-boundary-v1:${handle}`;
    const leaseCountBeforeLegacyAttempt = leaseRequests.length;
    const rejectedLegacy = await authorizeTenantProviderOutbound(new Request(
      "https://api.anthropic.com/v1/messages",
      { method: "POST", headers: { authorization: `Bearer ${legacyMarker}` }, body: "{}" },
    ), env, trustedForwarder);
    expect(rejectedLegacy.status).toBe(503);
    expect(await rejectedLegacy.text()).toBe("credential_lease_rejected");
    expect(leaseRequests).toHaveLength(leaseCountBeforeLegacyAttempt);
  });

  it("replays the exact Gateway accounting outbox without posting Slack twice and rejects stale revision", async () => {
    const { envelope, jwks } = await signedEnvelope();
    const namespace = new TenantRuntimeNamespace();
    const accountingPayloads: unknown[] = [];
    const quotaRequests: unknown[] = [];
    const leaseRequests: CredentialLeaseRequest[] = [];
    const materialByOpaqueHandle = new Map<string, string>();
    let activeSnapshot = structuredClone(SNAPSHOT);
    let failAccounting = true;
    const upstreamFetch = vi.fn(async (requestInfo: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(requestInfo, init);
      const url = new URL(request.url);
      if (url.hostname === "authority.example.test") {
        return Response.json({ result: activeSnapshot });
      }
      if (url.hostname === "quota.example.test") {
        const quota = await request.json() as { unit: string };
        quotaRequests.push(structuredClone(quota));
        const now = new Date().toISOString();
        materialByOpaqueHandle.set("opaque-gateway-lease-handle", "materialized-slack-secret");
        return Response.json({ result: {
          message_type: "quota_decision",
          tenant_id: SNAPSHOT.tenant_id,
          contract_revision: SNAPSHOT.contract_revision,
          quota_revision: "19",
          decision: "allowed",
          limit: 100,
          used: 1,
          remaining: 99,
          unit: quota.unit,
          window_started_at: new Date(Date.now() - 60_000).toISOString(),
          window_ends_at: new Date(Date.now() + 60_000).toISOString(),
          decided_at: now,
          failure_code: null,
        } });
      }
      if (url.hostname === "broker.example.test") {
        const leaseRequest = await request.json() as CredentialLeaseRequest;
        leaseRequests.push(structuredClone(leaseRequest));
        const leaseNow = Date.now();
        return Response.json({ result: {
          message_type: "credential_lease_response",
          protocol_version: "1.0",
          lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0",
          contract_revision: leaseRequest.binding.contract_revision,
          binding: leaseRequest.binding,
          issued_at: new Date(leaseNow).toISOString(),
          expires_at: new Date(leaseNow + 59_000).toISOString(),
          max_uses: 1,
          lease_token: "opaque-gateway-lease-handle",
        } });
      }
      if (url.hostname === "accounting.example.test") {
        accountingPayloads.push(await request.json());
        if (failAccounting) {
          failAccounting = false;
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        }
        return Response.json({ result: { result_ref: "accounting-result-1" } });
      }
      return new Response("unexpected upstream", { status: 500 });
    });
    vi.stubGlobal("fetch", upstreamFetch);

    const boundaryHandle = await createDurableTenantBoundaryRegistry(namespace).register({
      tenant_context: envelope,
      expected_scope: EXPECTED_SCOPE,
      now: new Date().toISOString(),
    });
    const resolved = await resolveDurableTenantBoundaryContext(
      namespace,
      new Request("https://gateway.internal/api/runtime/gateway", {
        headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: boundaryHandle },
      }),
      ["mcp_gateway", "brainbase_proxy"],
      new Date().toISOString(),
    );
    if (resolved instanceof Response) throw new Error("test_tenant_boundary_unavailable");
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
    } as unknown as TenantGatewayDeliveryEnv;
    const trustedForwarder = trustedForwarderForTest(namespace, materialByOpaqueHandle, envelope);
    const input = {
      requestId: "gateway-request-1",
      callIndex: 0,
      channel: "C-A",
      threadTs: "1723800000.000001",
      text: "canonical gateway delivery",
    };
    const deliver = () => deliverTenantGatewaySlackMessage(
      input,
      env,
      resolved,
      tenantCredentialFetchForResolvedContext(env, resolved, trustedForwarder),
    );

    await expect(deliver()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(deliver()).resolves.toEqual({ channel: "C-A", ts: "1723800000.000009" });

    expect(namespace.providerRequests.filter((entry) => entry.url.includes("chat.postMessage"))).toHaveLength(1);
    expect(leaseRequests).toHaveLength(1);
    expect(quotaRequests).toHaveLength(1);
    expect(accountingPayloads).toHaveLength(2);
    expect(accountingPayloads[1]).toEqual(accountingPayloads[0]);
    expect(JSON.stringify(accountingPayloads)).not.toContain("opaque-gateway-lease-handle");

    activeSnapshot = { ...activeSnapshot, connection_revision: "8" };
    await expect(deliverTenantGatewaySlackMessage(
      { ...input, requestId: "gateway-request-stale", callIndex: 1 },
      env,
      resolved,
      tenantCredentialFetchForResolvedContext(env, resolved, trustedForwarder),
    )).rejects.toMatchObject({ code: "WORKSPACE_CONNECTION_STALE_REVISION" });
    expect(namespace.providerRequests.filter((entry) => entry.url.includes("chat.postMessage"))).toHaveLength(1);
    expect(accountingPayloads).toHaveLength(2);
  });

  it("binds development callbacks to a durable tenant job owner across isolate restarts", async () => {
    const { envelope } = await signedEnvelope();
    const namespace = new TenantRuntimeNamespace();
    const handle = await createDurableTenantBoundaryRegistry(namespace).register({
      tenant_context: envelope,
      expected_scope: EXPECTED_SCOPE,
      now: new Date().toISOString(),
    });
    const jobId = await developmentJobIdForTenantOperation({
      eventId: envelope.slack.event_id,
      tenantId: envelope.tenant.tenant_id,
      connectionId: envelope.workspace_connection.connection_id,
      operationId: envelope.operation_id,
      workspaceId: envelope.workspace_connection.workspace_id,
      channelId: envelope.slack.channel_id,
      threadTs: envelope.slack.thread_ts ?? "",
    });
    const owner = await developmentOwnerFromContext({
      tenant_context: envelope,
      jobId,
      eventId: envelope.slack.event_id,
      requesterId: envelope.actor.authenticated_subject_id,
      placementId: "placement-a",
      quotaDecision: "allowed",
    });
    const ownerStore = createDurableTenantStateClient(namespace, owner.tenantId);
    const claimed = await claimDevelopmentJobOwner(ownerStore, owner, new Date().toISOString());
    expect(claimed).toMatchObject({ disposition: "claimed" });
    const terminalOutbox = createDevelopmentTerminalOutboxClient(namespace, claimed.claim.partition_key);
    const watchdogObservedAt = new Date().toISOString();
    await terminalOutbox.arm({
      job_id: jobId,
      payload_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      callback_body: JSON.stringify({ job_id: jobId, status: "timed_out" }),
      owner,
      owner_claim: { key: claimed.claim.key, partition_key: claimed.claim.partition_key },
      observed_at: watchdogObservedAt,
      activate_at: new Date(Date.parse(watchdogObservedAt) + 1_000).toISOString(),
      terminal_deadline_at: envelope.expires_at,
      container_id: "development-sandbox-integration-a",
      terminal_accounting: {
        tenant_context: envelope,
        expected_scope: EXPECTED_SCOPE,
        quota_decision: "allowed",
        unit: "container_seconds",
        outcome: "timed_out",
        failure_code: "DEVELOPMENT_RUNNER_TIMED_OUT",
        reply_state: "unknown",
        recorded_at: envelope.expires_at,
        accounting_effect_id: `development_terminal:${jobId}`,
      },
    });

    // Drop all handler instances to model a new Worker/DO isolate while retaining
    // the Durable Object storage that owns the callback claim.
    namespace.handlers.clear();
    const downstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "accounting_unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, state: "completed" }));
    const destroyContainer = vi.fn(async (_containerId: string) => undefined);
    const callbackBody = {
      job_id: jobId,
      event_id: envelope.slack.event_id,
      placement_id: "placement-a",
      workspace_id: envelope.workspace_connection.workspace_id,
      channel_id: envelope.slack.channel_id,
      thread_ts: envelope.slack.thread_ts,
      requester_id: envelope.actor.authenticated_subject_id,
      status: "completed",
      summary: "done",
      quota_decision: "allowed",
    } as const;
    const invoke = (body: object, boundaryHandle = handle) => proxyDevelopmentCallback(
      new Request("https://development-callback.internal/callback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TENANT_BOUNDARY_HANDLE_HEADER]: boundaryHandle,
        },
        body: JSON.stringify(body),
      }),
      {
        DEVELOPMENT_CALLBACK_BASE_URL: "https://runtime.example.test",
        DEVELOPMENT_CALLBACK_TOKEN: "test-callback-token-placeholder",
        TENANT_RUNTIME_STATE: namespace,
      },
      downstream,
    );

    const first = await invoke(callbackBody);
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ error: "accounting_unavailable" });

    const terminalKey = [...namespace.storages.keys()].find((key) => key.startsWith("development-terminal:"));
    expect(terminalKey).toBeDefined();
    const terminalStorage = namespace.storages.get(terminalKey ?? "");
    expect(terminalStorage).toBeDefined();
    const restartedOutbox = new DevelopmentTerminalOutboxHandler(terminalStorage!, terminalStorage!);
    await restartedOutbox.alarm(new Date().toISOString(), (record) => retryDevelopmentTerminalOutboxRecord(record, {
      DEVELOPMENT_CALLBACK_BASE_URL: "https://runtime.example.test",
      DEVELOPMENT_CALLBACK_TOKEN: "test-callback-token-placeholder",
      TENANT_RUNTIME_STATE: namespace,
    }, downstream, destroyContainer));

    namespace.handlers.clear();
    await expect(invoke(callbackBody).then((response) => response.json()))
      .resolves.toEqual({ ok: true, state: "completed", duplicate: true });
    expect(downstream).toHaveBeenCalledTimes(2);
    expect(destroyContainer).toHaveBeenCalledOnce();
    expect(destroyContainer).toHaveBeenCalledWith("development-sandbox-integration-a");
    expect(downstream.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(callbackBody));
    const forwarded = downstream.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(forwarded.headers).get("authorization"))
      .toBe("Bearer test-callback-token-placeholder");

    const unknownJob = await developmentJobIdForTenantOperation({
      eventId: "Ev-A-unknown",
      tenantId: envelope.tenant.tenant_id,
      connectionId: envelope.workspace_connection.connection_id,
      operationId: envelope.operation_id,
      workspaceId: envelope.workspace_connection.workspace_id,
      channelId: envelope.slack.channel_id,
      threadTs: envelope.slack.thread_ts ?? "",
    });
    const unknown = await invoke({ ...callbackBody, event_id: "Ev-A-unknown", job_id: unknownJob });
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: "development_callback_owner_missing" });
    expect(downstream).toHaveBeenCalledTimes(2);

    const crossTenant = await invoke({ ...callbackBody, workspace_id: "T-B" });
    expect(crossTenant.status).toBe(403);
    expect(await crossTenant.json()).toEqual({ error: "development_callback_forbidden" });
    expect(downstream).toHaveBeenCalledTimes(2);
  });
});
