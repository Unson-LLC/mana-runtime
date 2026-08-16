import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  REQUIRED_TENANT_CAPABILITIES,
  CredentialLeaseUseRegistry,
  IdempotencyMemoryStore,
  TenantBoundaryError,
  TenantRuntimeBoundaryVerifier,
  TenantQuotaCache,
  WorkspaceConnectionRegistry,
  acquireCredentialLease,
  acquireEnvelopeCredentialLease,
  applyCredentialLifecycleEvent,
  assertQuotaAllowsExecution,
  assertSecretArtifactFree,
  assertTenantPartition,
  authorizeSlackDelivery,
  claimIdempotency,
  consumeCredentialLease,
  consumeTenantQueueMessage,
  createDeletionReceipt,
  createIdempotencyKey,
  createOperationReceipt,
  createSecretValue,
  createUsageEvent,
  executeTenantBoundary,
  jcsCanonicalize,
  negotiateTenantProtocol,
  prepareContainerReuse,
  resolveSlackWorkerIngress,
  resolveTemporaryObjectExpiry,
  signTenantContextEnvelope,
  tenantPartitionKey,
  validateNonApplicableCapabilities,
  validateTenantBoundary,
  authorizeSlackDeliveryWithAuthority,
  type BoundaryName,
  type ContainerLease,
  type DeploymentProfile,
  type ExpectedTenantScope,
  type QuotaDecision,
  type TenantContextEnvelope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "../multitenancy/index.js";

const NOW = "2026-08-16T13:02:00.000Z";
const TENANT_A = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TENANT_B = "ten_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const CONNECTION_A = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEPLOYMENT_A = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OPERATION_A = "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ";

const snapshotA: WorkspaceConnectionSnapshot = {
  connection_id: CONNECTION_A,
  connection_revision: "7",
  tenant_id: TENANT_A,
  installation_id: "I-A",
  workspace_id: "T-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active",
  deployment_id: DEPLOYMENT_A,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "contract-7",
};

const unsignedEnvelopeA: UnsignedTenantContextEnvelope = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime", "brainbase-api"],
  tenant: { tenant_id: TENANT_A, tenant_revision: "3" },
  workspace_connection: {
    connection_id: CONNECTION_A,
    connection_revision: "7",
    provider: "slack",
    installation_id: "I-A",
    workspace_id: "T-A",
    app_id: "A-MANA",
    status: "active",
  },
  actor: {
    principal_id: "person-a",
    principal_type: "person",
    authenticated_subject_id: "U-A",
  },
  authorization: {
    organization_ids: ["organization-a"],
    project_ids: ["project-a"],
    data_scopes: ["tasks:tenant"],
    capability_ids: ["task.read", "task.write"],
  },
  placement: { deployment_id: DEPLOYMENT_A, profile: "shared_cloud" },
  slack: {
    event_id: "Ev-A-001",
    channel_id: "C-A",
    thread_ts: "1723800000.000001",
    requester_id: "U-A",
  },
  correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  operation_id: OPERATION_A,
  idempotency_key: "ik1_placeholder",
  contract_revision: "contract-7",
  credential: {
    mode: "customer_oauth",
    credential_ref: "credential-ref-a",
    billing_principal_id: "billing-principal-a",
  },
  issued_at: "2026-08-16T13:00:00.000Z",
  expires_at: "2026-08-16T13:05:00.000Z",
};

const expectedScope: ExpectedTenantScope = {
  audience: "mana-runtime",
  workspace_id: "T-A",
  app_id: "A-MANA",
  channel_id: "C-A",
  thread_ts: "1723800000.000001",
  actor_principal_id: "person-a",
  project_id: "project-a",
  capability_id: "task.write",
  deployment_id: DEPLOYMENT_A,
};

async function keyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

async function envelope(
  overrides: Partial<UnsignedTenantContextEnvelope> = {},
): Promise<{ value: TenantContextEnvelope; publicKey: CryptoKey }> {
  const keys = await keyPair();
  const idempotency_key = await createIdempotencyKey({
    protocol_id: unsignedEnvelopeA.protocol_id,
    protocol_major: "1",
    tenant_id: unsignedEnvelopeA.tenant.tenant_id,
    connection_id: unsignedEnvelopeA.workspace_connection.connection_id,
    slack_event_id: unsignedEnvelopeA.slack.event_id,
    operation_id: unsignedEnvelopeA.operation_id,
  });
  const value = await signTenantContextEnvelope(
    { ...unsignedEnvelopeA, idempotency_key, ...overrides },
    keys.privateKey,
    "test-key-1",
  );
  return { value, publicKey: keys.publicKey };
}

async function validate(
  value: TenantContextEnvelope,
  publicKey: CryptoKey,
  boundary: BoundaryName = "worker_ingress",
  authoritativeSnapshot: WorkspaceConnectionSnapshot = snapshotA,
): Promise<TenantContextEnvelope> {
  return validateTenantBoundary({
    boundary,
    envelope: value,
    authoritative_snapshot: authoritativeSnapshot,
    expected_scope: expectedScope,
    now: NOW,
    resolve_verification_key: async (keyId) => keyId === "test-key-1" ? publicKey : undefined,
  });
}

describe("story-mana-multitenant-runtime contract", () => {
  it("WorkspaceConnectionSnapshotV1 lifecycle planned Red", () => {
    const registry = new WorkspaceConnectionRegistry();
    registry.register(snapshotA);
    expect(registry.resolve({ provider: "slack", app_id: "A-MANA", workspace_id: "T-A" }))
      .toEqual(snapshotA);

    const revised = registry.revise(CONNECTION_A, "7", {
      connection_revision: "8",
      status: "reauth_required",
      granted_scopes: ["app_mentions:read"],
    });
    expect(revised).toMatchObject({ tenant_id: TENANT_A, connection_revision: "8", status: "reauth_required" });
    expect(() => registry.revise(CONNECTION_A, "7", { status: "revoked" }))
      .toThrow(expect.objectContaining({ code: "WORKSPACE_CONNECTION_STALE_REVISION" }));
  });

  it("fail closed before enqueue and LLM planned Red", () => {
    const registry = new WorkspaceConnectionRegistry();
    registry.register({ ...snapshotA, status: "revoked" });
    expect(() => registry.resolveActive(
      { provider: "slack", app_id: "A-MANA", workspace_id: "T-A" },
      { required_scopes: ["chat:write"], expected_revision: "7" },
    )).toThrow(expect.objectContaining({ code: "WORKSPACE_CONNECTION_REVOKED" }));
    expect(() => registry.resolveActive(
      { provider: "slack", app_id: "A-OTHER", workspace_id: "T-A" },
      { required_scopes: [], expected_revision: "7" },
    )).toThrow(expect.objectContaining({ code: "TENANT_UNKNOWN" }));
  });

  it("no credential body crosses a persisted or observable boundary planned Red", () => {
    expect(() => assertSecretArtifactFree({ credential_ref: "opaque-ref", access_token: "sensitive-value" }))
      .toThrow(expect.objectContaining({ code: "SECRET_ARTIFACT_FORBIDDEN" }));
    expect(() => assertSecretArtifactFree({ credential_ref: "opaque-ref", authorization: "Bearer sensitive-value" }))
      .toThrow(expect.objectContaining({ code: "SECRET_ARTIFACT_FORBIDDEN" }));
    expect(assertSecretArtifactFree({ credential_ref: "opaque-ref", outcome: "failed" }))
      .toEqual({ credential_ref: "opaque-ref", outcome: "failed" });
  });

  it("TenantContextEnvelopeV1 schema and integrity planned Red", async () => {
    const { value, publicKey } = await envelope();
    expect(jcsCanonicalize({ b: 1, a: [3, { z: true, y: "x" }] }))
      .toBe('{"a":[3,{"y":"x","z":true}],"b":1}');
    await expect(validate(value, publicKey)).resolves.toEqual(value);

    const mutated = structuredClone(value);
    mutated.authorization.project_ids = ["project-b"];
    await expect(validate(mutated, publicKey)).rejects
      .toEqual(expect.objectContaining({ code: "TENANT_CONTEXT_SIGNATURE_INVALID", boundary: "worker_ingress" }));
  });

  it("Worker Queue DO Container MCP Brainbase proxy delivery validators planned Red", async () => {
    const { value, publicKey } = await envelope();
    const boundaries: BoundaryName[] = [
      "worker_ingress",
      "queue_consumer",
      "durable_object",
      "container_launch",
      "mcp_gateway",
      "brainbase_proxy",
      "slack_delivery",
    ];
    await Promise.all(boundaries.map((boundary) => validate(value, publicKey, boundary)));

    await expect(validate(value, publicKey, "brainbase_proxy", { ...snapshotA, connection_revision: "8" }))
      .rejects.toEqual(expect.objectContaining({ code: "WORKSPACE_CONNECTION_STALE_REVISION", boundary: "brainbase_proxy" }));
  });

  it("tenant event operation atomic idempotency planned Red", async () => {
    const key = await createIdempotencyKey({
      protocol_id: "mana-brainbase-tenant-context",
      protocol_major: "1",
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      slack_event_id: "event|same",
      operation_id: OPERATION_A,
    });
    const changed = await createIdempotencyKey({
      protocol_id: "mana-brainbase-tenant-context",
      protocol_major: "1",
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      slack_event_id: "event",
      operation_id: "op_|same",
    });
    expect(key).not.toBe(changed);

    const store = new IdempotencyMemoryStore();
    const claim = { key, tenant_id: TENANT_A, connection_id: CONNECTION_A, slack_event_id: "event|same",
      operation_id: OPERATION_A, context_hash: "ctx-a", payload_hash: "payload-a",
      connection_revision: "7", updated_at: NOW };
    await expect(claimIdempotency(store, claim)).resolves.toMatchObject({ disposition: "claimed" });
    await expect(claimIdempotency(store, claim)).resolves.toMatchObject({ disposition: "in_progress" });
    await expect(claimIdempotency(store, { ...claim, payload_hash: "payload-b" }))
      .rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("TenantPartitionKeyV1 matrix planned Red", () => {
    const key = tenantPartitionKey({ tenant_id: TENANT_A, resource_type: "session", connection_id: CONNECTION_A,
      workspace_id: "T-A", channel_id: "C-A", thread_ts: "1723800000.000001", resource_id: "session-1" });
    expect(key).toMatch(/^tp1\//);
    expect(assertTenantPartition(key, TENANT_A)).toBe(key);
    expect(() => assertTenantPartition(key, TENANT_B))
      .toThrow(expect.objectContaining({ code: "CROSS_TENANT_CANDIDATE" }));
  });

  it("ContainerSanitizationReceiptV1 planned Red", async () => {
    const lease: ContainerLease = {
      container_id: "ctr_01ARZ3NDEKTSV4RRFFQ69G5FB2",
      tenant_id: TENANT_A,
      lease_id: "lease-a",
      operation_id: OPERATION_A,
      state: "dirty",
      leased_at: "2026-08-16T13:00:00.000Z",
      expires_at: "2026-08-16T13:04:00.000Z",
    };
    const destroy = vi.fn(async () => undefined);
    await expect(prepareContainerReuse(lease, TENANT_B, OPERATION_A, {
      image_digest: "sha256:image",
      completed_at: NOW,
      checks: {},
      destroy,
    })).rejects.toEqual(expect.objectContaining({ code: "CONTAINER_SANITIZATION_UNPROVEN" }));
    expect(destroy).toHaveBeenCalledOnce();

    const checks = Object.fromEntries([
      "child_processes_stopped", "workspace_removed", "tmp_removed", "home_removed",
      "environment_rebuilt", "credential_mount_scrubbed", "transcript_removed",
      "session_removed", "cache_removed", "open_handles_closed", "same_tenant", "fresh_signed_context",
    ].map((name) => [name, true]));
    await expect(prepareContainerReuse(lease, TENANT_A, OPERATION_A, {
      image_digest: "sha256:image", completed_at: NOW, checks, destroy,
    })).resolves.toMatchObject({ result: "passed", operation_id: OPERATION_A });
  });

  it("common external contract across deployment profiles planned Red", () => {
    const profile = (profileName: DeploymentProfile["profile"]): DeploymentProfile => ({
      profile: profileName,
      physical_isolation: profileName === "shared_cloud" ? "tenant_partition" : "deployment",
      supported_credential_modes: profileName === "customer_managed_oss" ? ["customer_oauth", "customer_api"] : ["cloud_standard", "customer_oauth", "customer_api"],
      capabilities: [...REQUIRED_TENANT_CAPABILITIES],
      runtime_version: "2026.8.0",
    });
    for (const name of ["shared_cloud", "dedicated_cloud", "customer_managed_oss"] as const) {
      expect(negotiateTenantProtocol(profile(name), { protocol_id: "mana-brainbase-tenant-context",
        supported_versions: ["1.0", "1.1"], capabilities: [...REQUIRED_TENANT_CAPABILITIES] }))
        .toMatchObject({ protocol_version: "1.1" });
    }
    expect(() => negotiateTenantProtocol(profile("shared_cloud"), { protocol_id: "mana-brainbase-tenant-context",
      supported_versions: ["2.0"], capabilities: [...REQUIRED_TENANT_CAPABILITIES] }))
      .toThrow(expect.objectContaining({ code: "PROTOCOL_VERSION_UNSUPPORTED" }));
  });

  it("concurrent A B negative matrix planned Red", async () => {
    const store = new IdempotencyMemoryStore();
    const base = { protocol_id: "mana-brainbase-tenant-context", protocol_major: "1", connection_id: CONNECTION_A,
      slack_event_id: "Ev-same", operation_id: OPERATION_A };
    const [keyA, keyB] = await Promise.all([
      createIdempotencyKey({ ...base, tenant_id: TENANT_A }),
      createIdempotencyKey({ ...base, tenant_id: TENANT_B }),
    ]);
    expect(keyA).not.toBe(keyB);
    const claims = await Promise.all([
      claimIdempotency(store, { key: keyA, tenant_id: TENANT_A, connection_id: CONNECTION_A,
        slack_event_id: "Ev-same", operation_id: OPERATION_A, context_hash: "ctx-a", payload_hash: "same", connection_revision: "7", updated_at: NOW }),
      claimIdempotency(store, { key: keyB, tenant_id: TENANT_B, connection_id: CONNECTION_A,
        slack_event_id: "Ev-same", operation_id: OPERATION_A, context_hash: "ctx-b", payload_hash: "same", connection_revision: "7", updated_at: NOW }),
    ]);
    expect(claims.map((entry) => entry.disposition)).toEqual(["claimed", "claimed"]);
  });

  it("temporary object lifecycle and deletion receipt planned Red", () => {
    expect(resolveTemporaryObjectExpiry({ created_at: "2026-08-16T13:00:00.000Z", contract_ttl_seconds: 300,
      profile_ttl_seconds: 120 })).toBe("2026-08-16T13:02:00.000Z");
    expect(() => resolveTemporaryObjectExpiry({ created_at: NOW, contract_ttl_seconds: undefined,
      profile_ttl_seconds: 120 })).toThrow(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
    expect(createDeletionReceipt({ object_key: "tp1/key", tenant_id: TENANT_A, reason: "expired",
      deleted_at: NOW, outcome: "not_found" })).toMatchObject({ tenant_id: TENANT_A, outcome: "not_found" });
  });

  it("CredentialDecisionV1 selection and injection planned Red", async () => {
    const request = { tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7",
      contract_revision: "contract-7", operation_id: OPERATION_A, audience: "anthropic",
      credential_mode: "customer_oauth" as const, credential_ref: "credential-ref-a" };
    const broker = { acquire_lease: vi.fn(async () => ({ ...request, lease_id: "lease-a", issued_at: NOW,
      expires_at: "2026-08-16T13:03:00.000Z", max_uses: 1 as const })) };
    const lease = await acquireCredentialLease({ broker, request, read_authoritative_snapshot: async () => snapshotA, now: NOW });
    const registry = new CredentialLeaseUseRegistry();
    const headers = await consumeCredentialLease(registry, lease, createSecretValue("fixture-runtime-value"),
      (secret) => new Headers({ authorization: `Bearer ${secret}` }), NOW);
    expect(headers.get("authorization")).toBe("Bearer fixture-runtime-value");
    await expect(consumeCredentialLease(registry, lease, createSecretValue("fixture-runtime-value"),
      () => new Headers(), NOW)).rejects.toEqual(expect.objectContaining({ code: "FALLBACK_FORBIDDEN" }));
  });

  it("tenant OAuth lifecycle and concurrent refresh planned Red", () => {
    const cache = new Map([[CONNECTION_A, snapshotA]]);
    applyCredentialLifecycleEvent(cache, { tenant_id: TENANT_A, connection_id: CONNECTION_A,
      credential_ref_hash: "sha256:opaque", from_revision: "7", to_revision: "8", outcome: "refreshed",
      correlation_id: unsignedEnvelopeA.correlation_id, occurred_at: NOW });
    expect(cache.has(CONNECTION_A)).toBe(false);
  });

  it("no credential fallback planned Red", async () => {
    const request = { tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7",
      contract_revision: "contract-7", operation_id: OPERATION_A, audience: "anthropic",
      credential_mode: "customer_oauth" as const, credential_ref: "credential-ref-a" };
    const broker = { acquire_lease: vi.fn(async () => { throw new TenantBoundaryError("credential_lease", "WORKSPACE_CONNECTION_REVOKED"); }) };
    await expect(acquireCredentialLease({ broker, request, read_authoritative_snapshot: async () => snapshotA, now: NOW }))
      .rejects.toEqual(expect.objectContaining({ code: "WORKSPACE_CONNECTION_REVOKED" }));
    expect(broker.acquire_lease).toHaveBeenCalledOnce();
  });

  it("no singleton credential source on shared path planned Red", () => {
    const serialized = JSON.stringify({ credential_mode: "customer_oauth", credential_ref: "credential-ref-a" });
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(() => assertSecretArtifactFree({ api_key: "fixture-runtime-value" }))
      .toThrow(expect.objectContaining({ code: "SECRET_ARTIFACT_FORBIDDEN" }));
  });

  it("UsageEventV1 success failure and not measured planned Red", () => {
    const usage = createUsageEvent({ usage_event_id: "use_01ARZ3NDEKTSV4RRFFQ69G5FB4", protocol_version: "1.0", tenant_id: TENANT_A,
      connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "contract-7",
      deployment_id: DEPLOYMENT_A, correlation_id: unsignedEnvelopeA.correlation_id, operation_id: OPERATION_A,
      idempotency_key: "ik1_value", kind: "model_tokens", quantity: null, unit: "tokens", outcome: "failed",
      collection_state: "not_collected", failure_code: "UPSTREAM_UNAVAILABLE", observed_at: NOW });
    expect(usage).toMatchObject({ quantity: null, outcome: "failed", collection_state: "not_collected" });
    expect(() => createUsageEvent({ ...usage, quantity: 0, collection_state: "not_collected" }))
      .toThrow(expect.objectContaining({ code: "USAGE_COLLECTION_INVALID" }));
    expect(createOperationReceipt({ receipt_id: "rcp_01ARZ3NDEKTSV4RRFFQ69G5FB5", protocol_version: "1.0", tenant_id: TENANT_A,
      connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "contract-7",
      deployment_id: DEPLOYMENT_A, correlation_id: unsignedEnvelopeA.correlation_id,
      operation_ids: [OPERATION_A], idempotency_keys: ["ik1_value"], actor_principal_id: "person-a",
      project_id: "project-a", capability_id: "task.write", quota_decision: "allowed",
      credential_mode: "customer_oauth", outcome: "succeeded", failure_code: "NO_DATA",
      usage: { collection_state: "collected", observed_units: 0, unknown_fields: [] }, reply: { state: "not_requested" } }))
      .toMatchObject({ outcome: "succeeded", failure_code: "NO_DATA", usage: { observed_units: 0 } });
  });

  it("per tenant quota decisions and isolation planned Red", () => {
    const cache = new TenantQuotaCache();
    const stopped: QuotaDecision = { tenant_id: TENANT_A, contract_revision: "contract-7", metric: "model_tokens",
      consumed: 100, limit: 100, ratio_basis_points: 10_000, decision: "hard_stopped", overage_policy: "deny",
      warning_thresholds_basis_points: [8_000], decision_id: "quota-a" };
    const allowed: QuotaDecision = { ...stopped, tenant_id: TENANT_B, consumed: 1, decision: "allowed", decision_id: "quota-b" };
    cache.set(stopped); cache.set(allowed);
    expect(() => assertQuotaAllowsExecution(cache.get(TENANT_A, "contract-7", "model_tokens")))
      .toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(assertQuotaAllowsExecution(cache.get(TENANT_B, "contract-7", "model_tokens"))).toEqual(allowed);
  });

  it("safe actionable failure and scoped delivery planned Red", async () => {
    const { value, publicKey } = await envelope();
    const ownership = new IdempotencyMemoryStore();
    const result = await authorizeSlackDelivery({ envelope: value, authoritative_snapshot: snapshotA,
      expected_scope: expectedScope, now: NOW, resolve_verification_key: async () => publicKey,
      ownership, payload_hash: "reply-a" });
    expect(result.disposition).toBe("claimed");
    await expect(authorizeSlackDelivery({ envelope: value, authoritative_snapshot: { ...snapshotA, deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FB3" },
      expected_scope: expectedScope, now: NOW, resolve_verification_key: async () => publicKey,
      ownership, payload_hash: "reply-a" })).rejects
      .toEqual(expect.objectContaining({ code: "REPLY_OWNERSHIP_CONFLICT" }));
  });

  it("authoritative worker ingress resolution planned Red", async () => {
    const { value, publicKey } = await envelope();
    const resolveWorkspaceConnection = vi.fn(async () => snapshotA);
    const readWorkspaceConnection = vi.fn(async () => snapshotA);
    const issueTenantContext = vi.fn(async () => value);
    const result = await resolveSlackWorkerIngress({
      identity: {
        provider: "slack",
        app_id: "A-MANA",
        workspace_id: "T-A",
        installation_id: "I-A",
        event_id: "Ev-A-001",
        channel_id: "C-A",
        thread_ts: "1723800000.000001",
        requester_id: "U-A",
      },
      required_scopes: ["chat:write"],
      required_authorization: {
        audience: "mana-runtime",
        project_id: "project-a",
        capability_id: "task.write",
      },
      authority: {
        resolve_workspace_connection: resolveWorkspaceConnection,
        read_workspace_connection: readWorkspaceConnection,
        issue_tenant_context: issueTenantContext,
      },
      now: NOW,
      resolve_verification_key: async () => publicKey,
    });
    expect(result).toEqual({ tenant_context: value, authoritative_snapshot: snapshotA });
    expect(resolveWorkspaceConnection).toHaveBeenCalledWith({
      provider: "slack", app_id: "A-MANA", workspace_id: "T-A",
    });
    expect(readWorkspaceConnection).toHaveBeenCalledWith(CONNECTION_A);
    expect(issueTenantContext).toHaveBeenCalledWith(expect.objectContaining({
      workspace_connection: snapshotA,
      slack: expect.objectContaining({ event_id: "Ev-A-001", requester_id: "U-A" }),
    }));
  });

  it("queue validation happens before tenant work planned Red", async () => {
    const { value, publicKey } = await envelope();
    const readSnapshot = vi.fn(async () => ({ ...snapshotA, connection_revision: "8" }));
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: readSnapshot,
      resolve_verification_key: async () => publicKey,
    });
    const message = { body: { schema_version: "1.0" as const, tenant_context: value, payload: { command: "run" } },
      ack: vi.fn(), retry: vi.fn() };
    const process = vi.fn(async () => ({ outcome: "succeeded" }));
    await consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => expectedScope,
      now: () => NOW,
      process,
    });
    expect(process).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("DO Container MCP and Brainbase write recheck revision planned Red", async () => {
    const { value, publicKey } = await envelope();
    const readSnapshot = vi.fn(async () => snapshotA);
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: readSnapshot,
      resolve_verification_key: async () => publicKey,
    });
    const execute = vi.fn(async () => "done");
    for (const boundary of ["durable_object", "container_launch", "mcp_gateway", "brainbase_proxy"] as const) {
      await expect(executeTenantBoundary({ boundary, tenant_context: value, expected_scope: expectedScope,
        now: NOW, verifier, execute })).resolves.toBe("done");
    }
    expect(readSnapshot).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("credential lease and Slack delivery recheck authoritative revision planned Red", async () => {
    const { value, publicKey } = await envelope();
    const readSnapshot = vi.fn(async () => snapshotA);
    const broker = { acquire_lease: vi.fn(async (request) => ({ ...request, lease_id: "lease-a", issued_at: NOW,
      expires_at: "2026-08-16T13:03:00.000Z", max_uses: 1 as const })) };
    await expect(acquireEnvelopeCredentialLease({ envelope: value, expected_scope: expectedScope,
      audience: "anthropic", broker, read_authoritative_snapshot: readSnapshot, now: NOW,
      resolve_verification_key: async () => publicKey })).resolves.toMatchObject({ lease_id: "lease-a" });
    expect(broker.acquire_lease).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT_A, connection_revision: "7", credential_ref: "credential-ref-a",
    }));

    const ownership = new IdempotencyMemoryStore();
    await expect(authorizeSlackDeliveryWithAuthority({ envelope: value, expected_scope: expectedScope,
      now: NOW, resolve_verification_key: async () => publicKey, read_authoritative_snapshot: readSnapshot,
      ownership, payload_hash: "reply-a" })).resolves.toMatchObject({ disposition: "claimed" });
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  });

  it("positive negative and non applicable fixture suites planned Red", () => {
    const fixture = (name: string) => JSON.parse(readFileSync(new URL(
      `../../../../.vibepro/spec/story-mana-multitenant-runtime/fixtures/${name}.json`, import.meta.url,
    ), "utf8")) as Record<string, any>;
    const positive = fixture("positive");
    const negative = fixture("negative");
    const nonApplicable = fixture("non-applicable");
    expect(positive.expected.raw_secret_recorded).toBe(false);
    const negativeCodes = new Set(negative.cases.map((entry: { expected_code: string }) => entry.expected_code));
    expect(negativeCodes.has("TENANT_CONTEXT_SIGNATURE_INVALID")).toBe(true);
    expect(negativeCodes.has("IDEMPOTENCY_CONFLICT")).toBe(true);
    expect(negativeCodes.has("FALLBACK_FORBIDDEN")).toBe(true);
    expect(validateNonApplicableCapabilities(nonApplicable.deployment.advertised_optional_capabilities,
      nonApplicable.expected.still_required)).toEqual(nonApplicable.expected.non_applicable_capabilities);
  });
});
