import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleTenantSlackRequest } from "../slack.js";

import {
  REQUIRED_TENANT_CAPABILITIES,
  CredentialLeaseUseRegistry,
  IdempotencyMemoryStore,
  TenantBoundaryError,
  TenantRuntimeBoundaryVerifier,
  SlackInstallationAdapter,
  TenantQuotaCache,
  TenantAccountingLedger,
  TenantCredentialInjector,
  WorkspaceConnectionRegistry,
  acquireCredentialLease,
  acquireEnvelopeCredentialLease,
  applyCredentialLifecycleEvent,
  assertQuotaAllowsExecution,
  assertSecretArtifactFree,
  assertTenantPartition,
  authorizeTenantQuota,
  authorizeSlackDelivery,
  claimIdempotency,
  completeIdempotency,
  consumeCredentialLease,
  consumeTenantQueueMessage,
  createDeletionReceipt,
  createIdempotencyKey,
  createOperationReceipt,
  createTenantTemporaryObject,
  createSecretValue,
  createUsageEvent,
  createUserFailure,
  executeTenantBoundary,
  jcsCanonicalize,
  negotiateTenantProtocol,
  prepareContainerReuse,
  hashTenantObjectKey,
  resolveSlackWorkerIngress,
  resolveTemporaryObjectExpiry,
  signTenantContextEnvelope,
  tenantPartitionKey,
  validateNonApplicableCapabilities,
  validateTenantBoundary,
  withTenantCredentialLease,
  writeTenantAccounting,
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
const OPERATION_DELIVERY = "op_01ARZ3NDEKTSV4RRFFQ69G5FB7";
const PAYLOAD_HASH = `sha256:${"c".repeat(64)}`;
const RETENTION_UNTIL = "2026-09-16T13:02:00.000Z";

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
  contract_revision: "11",
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
  contract_revision: "11",
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

async function signedSlackRequest(payload: unknown, nowMs: number): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(nowMs / 1_000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("fixture-signing-key"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const signature = `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return new Request("https://runtime.example.test/slack/events", { method: "POST", body,
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature } });
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

  it("Slack installation lifecycle uses authenticated revision port planned Red", async () => {
    const register = vi.fn(async () => snapshotA);
    const revise = vi.fn(async () => ({ ...snapshotA, connection_revision: "8", status: "reauth_required" as const,
      granted_scopes: ["app_mentions:read"] }));
    const adapter = new SlackInstallationAdapter({
      register_slack_installation: register,
      revise_workspace_connection: revise,
      resolve_workspace_connection: vi.fn(async () => snapshotA),
    });
    await expect(adapter.apply({ kind: "oauth_callback", expected_revision: "0", app_id: "A-MANA",
      workspace_id: "T-A", installation_id: "I-A", installer_id: "U-INSTALLER",
      granted_scopes: ["app_mentions:read", "chat:write"], authorization_code_ref: "opaque-exchange-a" }))
      .resolves.toEqual(snapshotA);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "T-A",
      authorization_code_ref: "opaque-exchange-a" }), "0");
    await expect(adapter.apply({ kind: "scope_changed", connection_id: CONNECTION_A,
      expected_revision: "7", granted_scopes: ["app_mentions:read"] }))
      .resolves.toMatchObject({ connection_revision: "8", status: "reauth_required" });
    expect(revise).toHaveBeenCalledWith(CONNECTION_A, "7", {
      granted_scopes: ["app_mentions:read"], status: "reauth_required",
    });
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
    const lp = (value: string) => {
      const body = new TextEncoder().encode(value);
      const framed = new Uint8Array(4 + body.length);
      new DataView(framed.buffer).setUint32(0, body.length, false);
      framed.set(body, 4);
      return framed;
    };
    const digestInput = ["mana-brainbase-tenant-context", "1", TENANT_A, CONNECTION_A, "event|same", OPERATION_A]
      .map(lp).reduce((left, right) => Uint8Array.from([...left, ...right]), new Uint8Array());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
    const expected = `ik1_${btoa(String.fromCharCode(...digest)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    expect(key).toBe(expected);

    const store = new IdempotencyMemoryStore();
    const claim = { key, tenant_id: TENANT_A, connection_id: CONNECTION_A, slack_event_id: "event|same",
      operation_id: OPERATION_A, context_hash: "ctx-a", payload_hash: "payload-a",
      connection_revision: "7", updated_at: NOW };
    await expect(claimIdempotency(store, claim)).resolves.toMatchObject({ disposition: "claimed" });
    await expect(claimIdempotency(store, claim)).resolves.toMatchObject({ disposition: "in_progress" });
    await expect(claimIdempotency(store, { ...claim, payload_hash: "payload-b" }))
      .rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => completeIdempotency(store, { key, tenant_id: TENANT_A, state: "succeeded",
      result_ref: "opaque-result-a", updated_at: NOW, retained_until: "2026-09-14T13:02:00.000Z" }))
      .toThrow(expect.objectContaining({ code: "IDEMPOTENCY_RETENTION_INVALID" }));
    completeIdempotency(store, { key, tenant_id: TENANT_A, state: "succeeded",
      result_ref: "opaque-result-a", updated_at: NOW, retained_until: "2026-09-15T13:02:00.000Z" });
    await expect(claimIdempotency(store, claim)).resolves.toMatchObject({ disposition: "succeeded" });
  });

  it("TenantPartitionKeyV1 matrix planned Red", () => {
    const key = tenantPartitionKey({ tenant_id: TENANT_A, resource_type: "session", connection_id: CONNECTION_A,
      workspace_id: "T-A", channel_id: "C-A", thread_ts: "1723800000.000001", resource_id: "session-1" });
    const b64 = (value: string) => btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(key).toBe(["tp1", b64(TENANT_A), "session", b64(CONNECTION_A), b64("T-A"), b64("C-A"),
      b64("1723800000.000001"), b64("session-1")].join("/"));
    expect(assertTenantPartition(key, TENANT_A)).toBe(key);
    expect(() => assertTenantPartition(key, TENANT_B))
      .toThrow(expect.objectContaining({ code: "CROSS_TENANT_CANDIDATE" }));
    expect(tenantPartitionKey({ tenant_id: TENANT_A, resource_type: "idempotency", connection_id: CONNECTION_A,
      workspace_id: "", channel_id: "", thread_ts: "", resource_id: "ik1_value" }))
      .toContain("/idempotency/");
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
      sanitation_receipt_id: "sanitation-a",
      checks: {},
      destroy,
    })).rejects.toEqual(expect.objectContaining({ code: "CONTAINER_SANITIZATION_UNPROVEN",
      details: expect.objectContaining({ receipt: expect.objectContaining({
        sanitation_receipt_id: "sanitation-a", lease_id: "lease-a", result: "failed",
      }) }) }));
    expect(destroy).toHaveBeenCalledOnce();

    const checks = Object.fromEntries([
      "child_processes_stopped", "workspace_removed", "tmp_removed", "home_removed",
      "environment_rebuilt", "credential_mount_scrubbed", "transcript_removed",
      "session_removed", "cache_removed", "open_handles_closed", "same_tenant", "fresh_signed_context",
    ].map((name) => [name, true]));
    await expect(prepareContainerReuse(lease, TENANT_A, OPERATION_A, {
      image_digest: "sha256:image", completed_at: NOW, sanitation_receipt_id: "sanitation-b", checks, destroy,
    })).resolves.toMatchObject({ result: "passed", sanitation_receipt_id: "sanitation-b",
      lease_id: "lease-a", operation_id: OPERATION_A, tenant_hash: expect.stringMatching(/^sha256:/) });
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
  });

  it("tenant temporary object validation and deletion receipt planned Red", async () => {
    const objectKey = tenantPartitionKey({ tenant_id: TENANT_A, resource_type: "file", connection_id: CONNECTION_A,
      workspace_id: "T-A", channel_id: "C-A", thread_ts: "1723800000.000001", resource_id: "file-a" });
    expect(createTenantTemporaryObject({ object_key: objectKey, tenant_id: TENANT_A, connection_id: CONNECTION_A,
      correlation_id: unsignedEnvelopeA.correlation_id, source: "slack_attachment", mime_type: "text/plain",
      size_bytes: 10, sha256: "sha256:fixture", created_at: "2026-08-16T13:00:00.000Z", status: "available",
      contract: { max_size_bytes: 20, mime_allowlist: ["text/plain"], ttl_seconds: 300 },
      deployment_profile_ttl_seconds: 120 })).toMatchObject({ expires_at: "2026-08-16T13:02:00.000Z" });
    expect(() => createTenantTemporaryObject({ object_key: objectKey, tenant_id: TENANT_A, connection_id: CONNECTION_A,
      correlation_id: unsignedEnvelopeA.correlation_id, source: "slack_attachment", mime_type: "text/plain",
      size_bytes: 10, sha256: "sha256:fixture", created_at: NOW, status: "available",
      contract: { max_size_bytes: 20, mime_allowlist: ["text/plain"], ttl_seconds: undefined },
      deployment_profile_ttl_seconds: 120 })).toThrow(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
    expect(createDeletionReceipt({ object_key_hash: await hashTenantObjectKey(objectKey), tenant_id: TENANT_A,
      reason: "expired", deleted_at: NOW, outcome: "not_found" }))
      .toMatchObject({ object_key_hash: expect.stringMatching(/^sha256:/), tenant_id: TENANT_A });
  });

  it("CredentialDecisionV1 selection and injection planned Red", async () => {
    const request = { message_type: "credential_lease_request" as const, protocol_version: "1.0" as const,
      binding: { tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7",
        contract_revision: "11", operation_id: OPERATION_A, audience: "anthropic",
        credential_mode: "customer_oauth" as const, credential_ref: "credential-ref-a" },
      requested_ttl_seconds: 60 };
    const broker = { acquire_lease: vi.fn(async () => ({ message_type: "credential_lease_response" as const,
      protocol_version: "1.0" as const, lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      contract_revision: "11", binding: structuredClone(request.binding), issued_at: NOW,
      expires_at: "2026-08-16T13:03:00.000Z", max_uses: 1 as const,
      lease_token: "opaque-test-lease-handle" })) };
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
    const request = { message_type: "credential_lease_request" as const, protocol_version: "1.0" as const,
      binding: { tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7",
        contract_revision: "11", operation_id: OPERATION_A, audience: "anthropic",
        credential_mode: "customer_oauth" as const, credential_ref: "credential-ref-a" },
      requested_ttl_seconds: 60 };
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

  it("UsageEventV1 success failure and not measured planned Red", async () => {
    const { value } = await envelope();
    const usage = createUsageEvent({ usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FB4", protocol_version: "1.0", tenant_id: TENANT_A,
      connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: unsignedEnvelopeA.correlation_id, operation_id: OPERATION_A,
      idempotency_key: value.idempotency_key, kind: "model_tokens", quantity: null, unit: "tokens", outcome: "failed",
      collection_state: "not_collected", failure_code: "UPSTREAM_UNAVAILABLE", observed_at: NOW });
    expect(usage).toMatchObject({ quantity: null, outcome: "failed", collection_state: "not_collected" });
    expect(() => createUsageEvent({ ...usage, quantity: 0, collection_state: "not_collected" }))
      .toThrow(expect.objectContaining({ code: "USAGE_COLLECTION_INVALID" }));
    expect(createOperationReceipt({ receipt_id: "receipt_01ARZ3NDEKTSV4RRFFQ69G5FB5", protocol_version: "1.0", tenant_id: TENANT_A,
      connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: unsignedEnvelopeA.correlation_id,
      operation_ids: [OPERATION_A], idempotency_keys: [value.idempotency_key], actor_principal_id: "person-a",
      project_id: "project-a", capability_id: "task.write", quota_decision: "allowed",
      credential_mode: "customer_oauth", collection_state: "collected", outcome: "succeeded", failure_code: "NO_DATA",
      usage_event_ids: [usage.usage_event_id],
      reply: { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 }, completed_at: NOW }))
      .toMatchObject({ message_type: "operation_receipt", outcome: "succeeded", failure_code: "NO_DATA" });
  });

  it("tenant accounting ledger deduplicates before Brainbase write planned Red", async () => {
    const { value, publicKey } = await envelope();
    const usage = createUsageEvent({ usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FB6", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_id: OPERATION_A,
      idempotency_key: value.idempotency_key, kind: "model_tokens", quantity: 12, unit: "tokens",
      outcome: "succeeded", collection_state: "collected", observed_at: NOW });
    const receipt = createOperationReceipt({ receipt_id: "receipt_01ARZ3NDEKTSV4RRFFQ69G5FB7", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_ids: [OPERATION_A],
      idempotency_keys: [value.idempotency_key], actor_principal_id: "person-a", project_id: "project-a",
      capability_id: "task.write", quota_decision: "allowed", credential_mode: "customer_oauth",
      collection_state: "collected", outcome: "succeeded", usage_event_ids: [usage.usage_event_id],
      reply: { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 }, completed_at: NOW });
    const ledger = new TenantAccountingLedger();
    const write = vi.fn(async () => ({ result_ref: "brainbase-write-a" }));
    const verifier = new TenantRuntimeBoundaryVerifier({ read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey });
    await expect(writeTenantAccounting({ tenant_context: value, expected_scope: expectedScope, now: NOW,
      verifier, ledger, usage_events: [usage], receipt, write })).resolves.toMatchObject({ disposition: "written" });
    await expect(writeTenantAccounting({ tenant_context: value, expected_scope: expectedScope, now: NOW,
      verifier, ledger, usage_events: [usage], receipt, write })).resolves.toMatchObject({ disposition: "duplicate" });
    expect(write).toHaveBeenCalledOnce();
  });

  it("keeps an exact pending accounting claim after an upstream failure", async () => {
    const { value, publicKey } = await envelope();
    const usage = createUsageEvent({ usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FB8", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_id: OPERATION_A,
      idempotency_key: value.idempotency_key, kind: "runtime_operation", quantity: null, unit: "model_tokens",
      outcome: "succeeded", collection_state: "not_collected", unknown_fields: ["observed_units"], observed_at: NOW });
    const receipt = createOperationReceipt({ receipt_id: "receipt_01ARZ3NDEKTSV4RRFFQ69G5FB9", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_ids: [OPERATION_A],
      idempotency_keys: [value.idempotency_key], actor_principal_id: "person-a", project_id: "project-a",
      capability_id: "task.write", quota_decision: "allowed", credential_mode: "customer_oauth",
      collection_state: "not_collected", outcome: "succeeded", usage_event_ids: [usage.usage_event_id],
      reply: { state: "delivered", reply_count: 1, legacy_reply_count: 0, slack_reply_ts: "4.0" }, completed_at: NOW });
    const ledger = new TenantAccountingLedger();
    const verifier = new TenantRuntimeBoundaryVerifier({ read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey });
    const unavailable = vi.fn(async () => { throw new Error("accounting unavailable"); });
    await expect(writeTenantAccounting({ tenant_context: value, expected_scope: expectedScope, now: NOW,
      verifier, ledger, usage_events: [usage], receipt, write: unavailable }))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const changedReceipt = createOperationReceipt({ ...receipt, outcome: "failed", failure_code: "UPSTREAM_UNAVAILABLE",
      reply: { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 } });
    await expect(writeTenantAccounting({ tenant_context: value, expected_scope: expectedScope, now: NOW,
      verifier, ledger, usage_events: [usage], receipt: changedReceipt,
      write: async () => ({ result_ref: "must-not-write-changed-payload" }) }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(writeTenantAccounting({ tenant_context: value, expected_scope: expectedScope, now: NOW,
      verifier, ledger, usage_events: [usage], receipt,
      write: async () => ({ result_ref: "brainbase-write-retried" }) }))
      .resolves.toEqual({ disposition: "written", result_ref: "brainbase-write-retried" });
  });

  it("retries the same successful Receipt without repeating the Slack effect", async () => {
    const { executeTenantRuntimeOperation } = await import("../multitenancy/production-consumer.js");
    const { value, publicKey } = await envelope();
    const verifier = new TenantRuntimeBoundaryVerifier({ read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey });
    const ledger = new TenantAccountingLedger();
    const payloads: unknown[] = [];
    const accounting = { write: vi.fn(async (payload: unknown) => {
      payloads.push(structuredClone(payload));
      if (payloads.length === 1) throw new Error("accounting unavailable after Slack");
      return { result_ref: "brainbase-write-retried" };
    }) };
    const allowedQuota: QuotaDecision = {
      message_type: "quota_decision", tenant_id: TENANT_A, contract_revision: "11", quota_revision: "19",
      decision: "allowed", limit: 100, used: 1, remaining: 99, unit: "model_tokens",
      window_started_at: "2026-08-01T00:00:00Z", window_ends_at: "2026-09-01T00:00:00Z", decided_at: NOW,
    };
    const quota = { read_authoritative_decision: vi.fn()
      .mockResolvedValueOnce(allowedQuota)
      .mockResolvedValue({ ...allowedQuota, decision: "hard_stopped", used: 100, remaining: 0 }) };
    let persistedResponseTs: string | undefined;
    const postSlackOnce = vi.fn(async () => {
      persistedResponseTs = "4.0";
      return { outcome: "replied", responseTs: persistedResponseTs };
    });
    const accountingTimes = [NOW, "2026-08-16T13:02:30.000Z"];
    const run = () => executeTenantRuntimeOperation({
      tenant_context: value,
      expected_scope: expectedScope,
      verifier,
      quota,
      accounting,
      ledger,
      quota_unit: "model_tokens",
      now: () => accountingTimes.shift() ?? "2026-08-16T13:02:30.000Z",
      process: () => persistedResponseTs
        ? Promise.resolve({ outcome: "already_completed", responseTs: persistedResponseTs })
        : postSlackOnce(),
    });
    await expect(run()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(run()).resolves.toEqual({ outcome: "already_completed", responseTs: "4.0" });
    expect(postSlackOnce).toHaveBeenCalledOnce();
    expect(quota.read_authoritative_decision).toHaveBeenCalledOnce();
    expect(accounting.write).toHaveBeenCalledTimes(2);
    expect(payloads[1]).toEqual(payloads[0]);
  });

  it("replays pending accounting across isolates without consuming a one-shot effect twice", async () => {
    const { executeTenantRuntimeOperation } = await import("../multitenancy/production-consumer.js");
    const { createDurableTenantAccountingStore } = await import("../multitenancy/tenant-runtime-state.js");
    const { value, publicKey } = await envelope();
    const verifier = new TenantRuntimeBoundaryVerifier({ read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey });
    const values = new Map<string, unknown>();
    interface FixtureStorage {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      transaction<T>(callback: (txn: FixtureStorage) => Promise<T>): Promise<T>;
    }
    const storage: FixtureStorage = {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, stored: unknown) => { values.set(key, structuredClone(stored)); },
      delete: async (key: string) => values.delete(key),
      transaction: async <T>(callback: (txn: FixtureStorage) => Promise<T>) => callback(storage),
    };
    const payloads: unknown[] = [];
    const accounting = { write: vi.fn(async (payload: unknown) => {
      payloads.push(structuredClone(payload));
      if (payloads.length === 1) throw new Error("accounting unavailable after approved task write");
      return { result_ref: "brainbase-accounting-replayed" };
    }) };
    const allowedQuota: QuotaDecision = {
      message_type: "quota_decision", tenant_id: TENANT_A, contract_revision: "11", quota_revision: "19",
      decision: "allowed", limit: 100, used: 1, remaining: 99, unit: "interaction_effect",
      window_started_at: "2026-08-01T00:00:00Z", window_ends_at: "2026-09-01T00:00:00Z", decided_at: NOW,
    };
    const quota = { read_authoritative_decision: vi.fn(async () => allowedQuota) };
    const approvedTaskResult = { outcome: "completed", value: { status: 200, task_id: "task-approved-once" } };
    const oneShotApprovedWrite = vi.fn(async () => {
      if (oneShotApprovedWrite.mock.calls.length > 1) throw new Error("task_write_approval_consumed");
      return structuredClone(approvedTaskResult);
    });
    const run = (ledger: ReturnType<typeof createDurableTenantAccountingStore>) => executeTenantRuntimeOperation({
      tenant_context: value,
      expected_scope: expectedScope,
      verifier,
      quota,
      accounting,
      ledger,
      quota_unit: "interaction_effect",
      now: () => NOW,
      process: oneShotApprovedWrite,
      replay_after_accounting: oneShotApprovedWrite,
    });

    await expect(run(createDurableTenantAccountingStore(storage)))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(run(createDurableTenantAccountingStore(storage))).resolves.toEqual(approvedTaskResult);
    expect(oneShotApprovedWrite).toHaveBeenCalledOnce();
    expect(quota.read_authoritative_decision).toHaveBeenCalledOnce();
    expect(accounting.write).toHaveBeenCalledTimes(2);
    expect(payloads[1]).toEqual(payloads[0]);
  });

  it("per tenant quota decisions and isolation planned Red", () => {
    const cache = new TenantQuotaCache();
    const stopped: QuotaDecision = { message_type: "quota_decision", tenant_id: TENANT_A, contract_revision: "11",
      quota_revision: "19", decision: "hard_stopped", limit: 100, used: 100, remaining: 0, unit: "model_tokens",
      window_started_at: "2026-08-01T00:00:00Z", window_ends_at: "2026-09-01T00:00:00Z", decided_at: NOW };
    const allowed: QuotaDecision = { ...stopped, tenant_id: TENANT_B, used: 1, remaining: 99, decision: "allowed" };
    cache.set(stopped); cache.set(allowed);
    expect(() => assertQuotaAllowsExecution(cache.get(TENANT_A, "11", "model_tokens")))
      .toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(assertQuotaAllowsExecution(cache.get(TENANT_B, "11", "model_tokens"))).toEqual(allowed);
  });

  it("quota authority cannot default or cross tenants planned Red", async () => {
    const read = vi.fn(async (): Promise<QuotaDecision> => ({ message_type: "quota_decision", tenant_id: TENANT_A,
      contract_revision: "11", quota_revision: "19", decision: "allowed", limit: 100, used: 1,
      remaining: 99, unit: "model_tokens", window_started_at: "2026-08-01T00:00:00Z",
      window_ends_at: "2026-09-01T00:00:00Z", decided_at: NOW }));
    await expect(authorizeTenantQuota({ tenant_id: TENANT_A, contract_revision: "11",
      unit: "model_tokens", read_authoritative_decision: read })).resolves.toMatchObject({ decision: "allowed" });
    await expect(authorizeTenantQuota({ tenant_id: TENANT_B, contract_revision: "11",
      unit: "model_tokens", read_authoritative_decision: read }))
      .rejects.toEqual(expect.objectContaining({ code: "CROSS_TENANT_CANDIDATE" }));
  });

  it("UserFailure exposes only actionable public fields planned Red", () => {
    const failure = createUserFailure({ error: new TenantBoundaryError("quota", "QUOTA_EXCEEDED"),
      correlation_id: unsignedEnvelopeA.correlation_id });
    expect(failure).toEqual({ code: "usage_limit_reached", message_key: "tenant.usage_limit_reached",
      next_actions: ["contact_administrator"], correlation_id: unsignedEnvelopeA.correlation_id });
    expect(JSON.stringify(failure)).not.toContain(TENANT_A);
    expect(JSON.stringify(failure)).not.toContain("credential");
    expect(JSON.stringify(failure)).not.toContain("consumed");
  });

  it("safe actionable failure and scoped delivery planned Red", async () => {
    const { value, publicKey } = await envelope();
    const ownership = new IdempotencyMemoryStore();
    const result = await authorizeSlackDelivery({ envelope: value, authoritative_snapshot: snapshotA,
      expected_scope: expectedScope, now: NOW, resolve_verification_key: async () => publicKey,
      ownership, payload_hash: PAYLOAD_HASH, delivery_operation_id: OPERATION_DELIVERY,
      retention_until: RETENTION_UNTIL });
    expect(result.disposition).toBe("claimed");
    await expect(authorizeSlackDelivery({ envelope: value, authoritative_snapshot: { ...snapshotA, deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FB3" },
      expected_scope: expectedScope, now: NOW, resolve_verification_key: async () => publicKey,
      ownership, payload_hash: PAYLOAD_HASH, delivery_operation_id: OPERATION_DELIVERY,
      retention_until: RETENTION_UNTIL })).rejects
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

  it("Slack signed ingress resolves tenant before queue planned Red", async () => {
    const nowMs = Date.parse(NOW);
    const { value, publicKey } = await envelope();
    const payload = {
      type: "event_callback", api_app_id: "A-MANA", team_id: "T-A", event_id: "Ev-A-001",
      event: { type: "app_mention", channel: "C-A", user: "U-A", ts: "1723800000.000001",
        thread_ts: "1723800000.000001", text: "run" },
    };
    const send = vi.fn(async () => undefined);
    const response = await handleTenantSlackRequest(await signedSlackRequest(payload, nowMs), {
      signing_secret: "fixture-signing-key",
      expected_app_id: "A-MANA",
      required_scopes: ["chat:write"],
      required_authorization: { audience: "mana-runtime", project_id: "project-a", capability_id: "task.write" },
      authority: {
        resolve_workspace_connection: vi.fn(async () => snapshotA),
        read_workspace_connection: vi.fn(async () => snapshotA),
        issue_tenant_context: vi.fn(async () => value),
      },
      now_ms: nowMs,
      resolve_verification_key: async () => publicKey,
      send,
    });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ schema_version: "1.0",
      tenant_context: value, payload: expect.objectContaining({ tenantId: TENANT_A, eventId: "Ev-A-001" }) }));
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
      ownership: new IdempotencyMemoryStore(),
      payload_hash: () => PAYLOAD_HASH,
      retention_until: () => RETENTION_UNTIL,
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
    const broker = { acquire_lease: vi.fn(async (request) => ({ message_type: "credential_lease_response" as const,
      protocol_version: request.protocol_version, lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      contract_revision: request.binding.contract_revision, binding: structuredClone(request.binding), issued_at: NOW,
      expires_at: "2026-08-16T13:03:00.000Z", max_uses: 1 as const,
      lease_token: "opaque-test-lease-handle" })) };
    await expect(acquireEnvelopeCredentialLease({ envelope: value, expected_scope: expectedScope,
      audience: "anthropic", broker, read_authoritative_snapshot: readSnapshot, now: NOW,
      resolve_verification_key: async () => publicKey }))
      .resolves.toMatchObject({ lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB1" });
    expect(broker.acquire_lease).toHaveBeenCalledWith(expect.objectContaining({
      message_type: "credential_lease_request", requested_ttl_seconds: 60,
      binding: expect.objectContaining({ tenant_id: TENANT_A, connection_revision: "7", credential_ref: "credential-ref-a" }),
    }));

    const ownership = new IdempotencyMemoryStore();
    await expect(authorizeSlackDeliveryWithAuthority({ envelope: value, expected_scope: expectedScope,
      now: NOW, resolve_verification_key: async () => publicKey, read_authoritative_snapshot: readSnapshot,
      ownership, payload_hash: PAYLOAD_HASH, delivery_operation_id: OPERATION_DELIVERY,
      retention_until: RETENTION_UNTIL })).resolves.toMatchObject({ disposition: "claimed" });
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

  it("production Slack ingress and queue fail closed without tenant fallback planned Red", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const ingressStart = source.indexOf('url.pathname !== "/slack/events"');
    const ingressEnd = source.indexOf("async queue(", ingressStart);
    const ingress = source.slice(ingressStart, ingressEnd);
    expect(ingress).toContain("handleTenantSlackRequest");
    expect(ingress).not.toContain("handleSlackRequest(");
    expect(ingress).not.toContain("TENANT_ID");
    const commandStart = source.indexOf('url.pathname === "/slack/commands"');
    const commandEnd = source.indexOf('url.pathname !== "/slack/events"', commandStart);
    const commandIngress = source.slice(commandStart, commandEnd);
    expect(commandIngress).toContain("resolveSlackWorkerIngress");
    expect(commandIngress).toContain("tenant_context");
    expect(commandIngress).not.toContain("tenantId: env.TENANT_ID");
    expect(source.slice(ingressEnd)).toContain("consumeTenantQueueMessage");
    expect(source.slice(ingressEnd)).toContain("TENANT_RUNTIME_STATE");
    expect(source.slice(ingressEnd)).toContain("executeTenantRuntimeOperation");
    expect(source.slice(ingressEnd)).toContain("createDurableTenantAccountingClient");
    expect(source.slice(ingressEnd)).toContain("postTenantSlackReply");
    expect(source.slice(ingressEnd)).toContain("readReplyCompletion");
    expect(source.slice(ingressEnd)).toContain("executeTenantBoundary({");
    expect(source.slice(ingressEnd)).toContain('boundary: "container_launch"');
    expect(source.slice(ingressEnd)).not.toContain("claudeSession: {");
    expect(source.slice(ingressEnd)).not.toContain("if (replyPersisted)");
  });

  it("Meeting Minutes and interaction HTTP clients use only tenant credential fetch", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const clientsStart = source.indexOf("function meetingMinutesClients(");
    const clientsEnd = source.indexOf("function requiredRuntimeBinding", clientsStart);
    const clients = source.slice(clientsStart, clientsEnd);
    expect(clients).toContain("createTenantCredentialFetch");
    expect(clients).not.toContain("env.SLACK_BOT_TOKEN");
    expect(clients).not.toContain("env.GITHUB_TOKEN");
    expect(clients).not.toContain("env.BRAINBASE_TASK_API_TOKEN");
    expect(clients).not.toContain("env.BRAINBASE_GRAPH_API_TOKEN");
    expect(clients).not.toContain("resolveMeetingMinutesDestinationSlackToken");

    const interactionsStart = source.indexOf('url.pathname === "/slack/interactions"');
    const interactionsEnd = source.indexOf('url.pathname === "/slack/commands"', interactionsStart);
    const interactions = source.slice(interactionsStart, interactionsEnd);
    expect(interactions).toContain("createTaskWriteProxyHandler(tenantFetch)");
    expect(interactions).not.toContain("env.BRAINBASE_TASK_API_TOKEN");
    expect(interactions).not.toContain("env.BRAINBASE_GRAPH_API_TOKEN");
    expect(interactions).not.toContain("resolveMeetingMinutesDestinationSlackToken");
  });

  it("does not expose a raw TaskBoard queue consumer with static tenant fallback", () => {
    const source = readFileSync(new URL("../task-runtime-entrypoints.ts", import.meta.url), "utf8");
    expect(source).not.toContain("consumeTaskBoardRepair");
    expect(source).not.toContain("env.TENANT_ID");
  });

  it("publishes recovery only as a canonical tenant queue body and rejects legacy recovery", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const selectionStart = source.indexOf("async function processTenantMeetingMinutesSelection");
    const selectionEnd = source.indexOf("async function processTenantMeetingMinutesRecovery", selectionStart);
    const selection = source.slice(selectionStart, selectionEnd);
    expect(selection).toContain('schema_version: "1.0"');
    expect(selection).toContain("const recoveryTenantContext = await resolveDerivedSlackTenantContext");
    expect(selection).toContain("event_id: meetingMinutesRecoveryEventId(armed.event)");
    expect(selection).toContain("tenant_context: recoveryTenantContext");
    const recoverySend = selection.slice(selection.indexOf("await env.TECHKNIGHT_EVENTS.send"));
    expect(recoverySend).not.toContain("tenant_context: tenantContext");
    expect(selection).toContain("payload: armed.event");
    expect(selection).not.toContain("send(armed.event");

    const legacyStart = source.indexOf("if (isMeetingMinutesRecovery(message.body))");
    const legacyEnd = source.indexOf("if (isTenantMeetingMinutesSelectionBody(message.body))", legacyStart);
    const legacy = source.slice(legacyStart, legacyEnd);
    expect(legacy).toContain("FALLBACK_FORBIDDEN");
    expect(legacy).not.toContain("resolveSlackWorkerIngress");
  });

  it("mock server preserves timeout error and not_collected semantics planned Red", async () => {
    const { createTenantRuntimeHttpClients } = await import("../multitenancy/http-clients.js");
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/tenant-authority")) {
        return Response.json({ result: snapshotA });
      }
      if (url.endsWith("/accounting")) {
        return Response.json({ result_ref: "brainbase-write-a" });
      }
      if (url.endsWith("/credential-broker")) {
        const request = body as unknown as import("../multitenancy/contracts.js").CredentialLeaseRequest;
        return Response.json({ result: {
          message_type: "credential_lease_response",
          protocol_version: request.protocol_version,
          lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB2",
          contract_revision: request.binding.contract_revision,
          binding: structuredClone(request.binding),
          issued_at: NOW,
          expires_at: "2026-08-16T13:03:00.000Z",
          max_uses: 1,
          lease_token: "fixture-provider-token",
        } });
      }
      return new Response("unavailable", { status: 503 });
    });
    const bindings = {
      deployment_profile: "shared_cloud" as const,
      tenant_authority_url: "https://mock.invalid/tenant-authority",
      credential_broker_url: "https://mock.invalid/credential-broker",
      quota_url: "https://mock.invalid/quota",
      accounting_url: "https://mock.invalid/accounting",
      api_token: "fixture-runtime-token",
      timeout_ms: 25,
    };
    const clients = createTenantRuntimeHttpClients(bindings, { fetch: fetchMock, now: () => NOW });
    await expect(clients.authority.resolve_workspace_connection({ provider: "slack", app_id: "A-MANA",
      workspace_id: "T-A" })).resolves.toEqual(snapshotA);
    const customerManagedClients = createTenantRuntimeHttpClients(
      { ...bindings, deployment_profile: "customer_managed_oss" },
      { fetch: fetchMock, now: () => NOW },
    );
    await expect(customerManagedClients.authority.resolve_workspace_connection({ provider: "slack",
      app_id: "A-MANA", workspace_id: "T-A" })).resolves.toEqual(snapshotA);
    const { value, publicKey } = await envelope();
    const injector = new TenantCredentialInjector();
    await expect(withTenantCredentialLease({
      envelope: value,
      expected_scope: expectedScope,
      audience: "api.anthropic.com",
      broker: clients.credential_broker,
      read_authoritative_snapshot: () => clients.authority.read_workspace_connection(CONNECTION_A),
      resolve_verification_key: async () => publicKey,
      now: () => NOW,
      injector,
      run: async (handle) => {
        const headers = injector.inject({
          hostname: "api.anthropic.com",
          headers: new Headers({ authorization: `Bearer mana-credential-lease-v1:${handle}` }),
          now: NOW,
        });
        expect(headers.get("authorization")).toBe("Bearer fixture-provider-token");
        return "injected";
      },
    })).resolves.toBe("injected");
    const expiringRegistry = {
      register: vi.fn(async () => "lease_handle_expiring_abcdefghijklmnopqrstuvwxyz"),
      dispose: vi.fn(async () => undefined),
    };
    await expect(withTenantCredentialLease({
      envelope: value,
      expected_scope: expectedScope,
      audience: "api.anthropic.com",
      broker: clients.credential_broker,
      read_authoritative_snapshot: () => clients.authority.read_workspace_connection(CONNECTION_A),
      resolve_verification_key: async () => publicKey,
      now: () => NOW,
      credential_registry: expiringRegistry,
      release: "on_expiration",
      run: async (handle) => handle,
    })).resolves.toBe("lease_handle_expiring_abcdefghijklmnopqrstuvwxyz");
    expect(expiringRegistry.dispose).not.toHaveBeenCalled();
    expect(requests.find((request) => request.url.endsWith("/credential-broker"))?.body)
      .toMatchObject({ requested_ttl_seconds: 60, binding: {
        tenant_id: TENANT_A, connection_revision: "7", contract_revision: "11",
        operation_id: OPERATION_A, audience: "api.anthropic.com", credential_ref: "credential-ref-a",
      } });
    expect(JSON.stringify(requests)).not.toContain("fixture-provider-token");
    const usage = createUsageEvent({ usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FB8", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_id: OPERATION_A,
      idempotency_key: value.idempotency_key, kind: "model_tokens", quantity: null, unit: "tokens",
      collection_state: "not_collected", outcome: "failed", failure_code: "UPSTREAM_UNAVAILABLE", observed_at: NOW });
    const receipt = createOperationReceipt({ receipt_id: "receipt_01ARZ3NDEKTSV4RRFFQ69G5FB9", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_ids: [OPERATION_A],
      idempotency_keys: [value.idempotency_key], actor_principal_id: "person-a", project_id: "project-a",
      capability_id: "task.write", quota_decision: "unavailable", credential_mode: "customer_oauth",
      collection_state: "not_collected", outcome: "failed", failure_code: "UPSTREAM_UNAVAILABLE",
      usage_event_ids: [usage.usage_event_id], reply: { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 },
      completed_at: NOW });
    await expect(clients.accounting.write({ partition_key: "tp1/test", usage_events: [usage], receipt }))
      .resolves.toEqual({ result_ref: "brainbase-write-a" });
    expect(requests.at(-1)?.body).toMatchObject({ usage_events: [{ quantity: null,
      collection_state: "not_collected", outcome: "failed" }], receipt: { collection_state: "not_collected",
      outcome: "failed" } });
    expect(requests.every((request) => request.authorization === "Bearer fixture-runtime-token")).toBe(true);
    expect(requests.every((request) => !JSON.stringify(request.body).includes("fixture-runtime-token"))).toBe(true);

    const timeoutClients = createTenantRuntimeHttpClients({ ...bindings, timeout_ms: 1 }, {
      fetch: vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
      })),
    });
    await expect(timeoutClients.authority.resolve_workspace_connection({ provider: "slack", app_id: "A-MANA",
      workspace_id: "T-A" })).rejects.toEqual(expect.objectContaining({ code: "WORKSPACE_CONNECTION_UNAVAILABLE" }));
  });

  it("two adapter instances share one Durable Object state and execute duplicate once planned Red", async () => {
    const { createDurableTenantAccountingStore, createDurableTenantStateStore } =
      await import("../multitenancy/tenant-runtime-state.js");
    const { value } = await envelope();
    const values = new Map<string, unknown>();
    interface FixtureStorage {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      transaction<T>(callback: (txn: FixtureStorage) => Promise<T>): Promise<T>;
    }
    const storage: FixtureStorage = {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => values.delete(key),
      transaction: async <T>(callback: (txn: FixtureStorage) => Promise<T>) => callback(storage),
    };
    const storeFromFirstIsolate = createDurableTenantStateStore(storage);
    const storeAfterRestart = createDurableTenantStateStore(storage);
    const claim = {
      key: "ik1_persistent-fixture",
      owner: "mana_runtime" as const,
      scope: "queue_execution" as const,
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      slack_event_id: "Ev-A-001",
      operation_id: OPERATION_A,
      context_hash: `sha256:${"a".repeat(64)}`,
      payload_hash: PAYLOAD_HASH,
      connection_revision: "7",
      updated_at: NOW,
    };
    const businessEffect = vi.fn(async () => undefined);
    for (const store of [storeFromFirstIsolate, storeAfterRestart]) {
      const result = await claimIdempotency(store, claim);
      if (result.disposition === "claimed") await businessEffect();
    }
    expect(businessEffect).toHaveBeenCalledOnce();
    expect(values.size).toBe(1);
    const accountingFromFirstIsolate = createDurableTenantAccountingStore(storage);
    const accountingAfterRestart = createDurableTenantAccountingStore(storage);
    const receiptId = "receipt_01ARZ3NDEKTSV4RRFFQ69G5FBA";
    await expect(accountingFromFirstIsolate.reserve_timestamp({ tenant_context: value, receipt_id: receiptId,
      proposed_at: NOW })).resolves.toBe(NOW);
    await expect(accountingAfterRestart.reserve_timestamp({ tenant_context: value, receipt_id: receiptId,
      proposed_at: "2026-08-16T13:02:30.000Z" })).resolves.toBe(NOW);
    expect(values.size).toBe(2);
    const usage = createUsageEvent({ usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FBB", protocol_version: "1.0",
      tenant_id: TENANT_A, connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_id: OPERATION_A,
      idempotency_key: value.idempotency_key, kind: "runtime_operation", quantity: null, unit: "model_tokens",
      outcome: "succeeded", collection_state: "not_collected", unknown_fields: ["observed_units"], observed_at: NOW });
    const receipt = createOperationReceipt({ receipt_id: receiptId, protocol_version: "1.0", tenant_id: TENANT_A,
      connection_id: CONNECTION_A, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_A, correlation_id: value.correlation_id, operation_ids: [OPERATION_A],
      idempotency_keys: [value.idempotency_key], actor_principal_id: "person-a", project_id: "project-a",
      capability_id: "task.write", quota_decision: "allowed", credential_mode: "customer_oauth",
      collection_state: "not_collected", outcome: "succeeded", usage_event_ids: [usage.usage_event_id],
      reply: { state: "delivered", reply_count: 1, legacy_reply_count: 0, slack_reply_ts: "4.0" }, completed_at: NOW });
    const artifact = { partition_key: "tp1/durable-accounting-fixture", usage_events: [usage], receipt };
    const accountingClaim = await accountingFromFirstIsolate.claim({ tenant_context: value,
      usage_event_ids: [usage.usage_event_id], receipt_id: receiptId, payload_hash: PAYLOAD_HASH, artifact });
    expect(accountingClaim.disposition).toBe("claimed");
    await expect(accountingAfterRestart.read_pending({ tenant_context: value, receipt_id: receiptId }))
      .resolves.toEqual(artifact);
    if (accountingClaim.disposition === "claimed") await accountingAfterRestart.complete(accountingClaim);
    await expect(accountingAfterRestart.read_pending({ tenant_context: value, receipt_id: receiptId }))
      .resolves.toBeUndefined();
  });
});
