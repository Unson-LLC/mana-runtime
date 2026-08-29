import { describe, expect, it, vi } from "vitest";

import {
  type ExpectedTenantScope,
  type QuotaDecision,
  type TenantContextEnvelope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { TenantAccountingLedger } from "../multitenancy/accounting.js";
import { signTenantContextEnvelope } from "../multitenancy/envelope.js";
import { IdempotencyMemoryStore, createIdempotencyKey } from "../multitenancy/idempotency.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import {
  TenantRuntimeBoundaryVerifier,
  consumeTenantQueueMessage,
} from "../multitenancy/runtime-boundaries.js";
import {
  executeTenantRuntimeOperation,
  postTenantSlackReply,
} from "../multitenancy/production-consumer.js";

const NOW = "2026-08-16T13:02:00.000Z";
const RETENTION_UNTIL = "2026-09-16T13:02:00.000Z";
const TENANT_A = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TENANT_B = "ten_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const CONNECTION_A = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CONNECTION_B = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const DEPLOYMENT_A = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DEPLOYMENT_B = "dep_01ARZ3NDEKTSV4RRFFQ69G5FB3";

function snapshot(input: {
  tenant_id: string;
  connection_id: string;
  workspace_id: string;
  deployment_id: string;
}): WorkspaceConnectionSnapshot {
  return {
    connection_id: input.connection_id,
    connection_revision: "7",
    tenant_id: input.tenant_id,
    installation_id: `installation-${input.tenant_id}`,
    workspace_id: input.workspace_id,
    app_id: "A-MANA",
    installer_id: "U-INSTALLER",
    granted_scopes: ["app_mentions:read", "chat:write"],
    status: "active",
    deployment_id: input.deployment_id,
    profile: "shared_cloud",
    credential_mode: "customer_oauth",
    contract_revision: "11",
  };
}

const snapshotA = snapshot({
  tenant_id: TENANT_A,
  connection_id: CONNECTION_A,
  workspace_id: "T-A",
  deployment_id: DEPLOYMENT_A,
});

const expectedScopeA: ExpectedTenantScope = {
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

async function signedEnvelope(input: {
  tenant_id: string;
  connection_id: string;
  workspace_id: string;
  channel_id: string;
  actor_principal_id: string;
  project_id: string;
  deployment_id: string;
  event_id: string;
  operation_id: string;
  correlation_id: string;
}): Promise<{ value: TenantContextEnvelope; publicKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const idempotencyKey = await createIdempotencyKey({
    protocol_id: "mana-brainbase-tenant-context",
    protocol_major: "1",
    tenant_id: input.tenant_id,
    connection_id: input.connection_id,
    slack_event_id: input.event_id,
    operation_id: input.operation_id,
  });
  const unsigned: UnsignedTenantContextEnvelope = {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime", "brainbase-api"],
    tenant: { tenant_id: input.tenant_id, tenant_revision: "3" },
    workspace_connection: {
      connection_id: input.connection_id,
      connection_revision: "7",
      provider: "slack",
      installation_id: `installation-${input.tenant_id}`,
      workspace_id: input.workspace_id,
      app_id: "A-MANA",
      status: "active",
    },
    actor: {
      principal_id: input.actor_principal_id,
      principal_type: "person",
      authenticated_subject_id: `slack-${input.actor_principal_id}`,
    },
    authorization: {
      organization_ids: [`organization-${input.tenant_id}`],
      project_ids: [input.project_id],
      data_scopes: ["tasks:tenant"],
      capability_ids: ["task.read", "task.write"],
    },
    placement: { deployment_id: input.deployment_id, profile: "shared_cloud" },
    slack: {
      event_id: input.event_id,
      channel_id: input.channel_id,
      thread_ts: "1723800000.000001",
      requester_id: `slack-${input.actor_principal_id}`,
    },
    correlation_id: input.correlation_id,
    operation_id: input.operation_id,
    idempotency_key: idempotencyKey,
    contract_revision: "11",
    credential: {
      mode: "customer_oauth",
      credential_ref: `credential-${input.tenant_id}`,
      billing_principal_id: `billing-${input.tenant_id}`,
    },
    issued_at: "2026-08-16T13:00:00.000Z",
    expires_at: "2026-08-16T13:05:00.000Z",
  };
  return {
    value: await signTenantContextEnvelope(unsigned, keyPair.privateKey, "test-key-1"),
    publicKey: keyPair.publicKey,
  };
}

function allowedQuota(tenantId: string): QuotaDecision {
  return {
    message_type: "quota_decision",
    tenant_id: tenantId,
    contract_revision: "11",
    quota_revision: "19",
    decision: "allowed",
    limit: 100,
    used: 1,
    remaining: 99,
    unit: "tool_calls",
    window_started_at: "2026-08-01T00:00:00.000Z",
    window_ends_at: "2026-09-01T00:00:00.000Z",
    decided_at: NOW,
  };
}

function hardStoppedQuota(tenantId: string): QuotaDecision {
  return {
    ...allowedQuota(tenantId),
    decision: "hard_stopped",
    failure_code: "QUOTA_EXCEEDED",
  };
}

function queueMessage(value: TenantContextEnvelope) {
  return {
    body: {
      schema_version: "1.0" as const,
      tenant_context: value,
      payload: { text: "私のタスクを完了にして" },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("production multitenancy integration", () => {
  it("runs the production queue, quota, Slack delivery, and accounting path once across redelivery", async () => {
    const { value, publicKey } = await signedEnvelope({
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      workspace_id: "T-A",
      channel_id: "C-A",
      actor_principal_id: "person-a",
      project_id: "project-a",
      deployment_id: DEPLOYMENT_A,
      event_id: "Ev-A-PROD-001",
      operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FB4",
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FB5",
    });
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey,
    });
    const queueOwnership = new IdempotencyMemoryStore();
    const deliveryOwnership = new IdempotencyMemoryStore();
    const accountingLedger = new TenantAccountingLedger();
    const quota = { read_authoritative_decision: vi.fn(async () => allowedQuota(TENANT_A)) };
    const accounting = { write: vi.fn(async () => ({ result_ref: "receipt-result-a" })) };
    const post = vi.fn(async () => "1723800001.000002");
    const logError = vi.fn();
    const process = vi.fn(async (_payload: unknown, tenantContext: TenantContextEnvelope) => {
      return executeTenantRuntimeOperation({
        tenant_context: tenantContext,
        expected_scope: expectedScopeA,
        verifier,
        quota,
        accounting,
        ledger: accountingLedger,
        usage_unit: "model_tokens",
        now: () => NOW,
        process: async () => ({
          outcome: "completed",
          responseTs: await postTenantSlackReply({
            tenant_context: tenantContext,
            expected_scope: expectedScopeA,
            ownership: deliveryOwnership,
            read_authoritative_snapshot: async () => snapshotA,
            resolve_verification_key: async () => publicKey,
            now: NOW,
            retention_until: RETENTION_UNTIL,
            event: { text: "私のタスクを完了にして" },
            text: "完了しました",
            post,
          }),
        }),
      });
    });
    const run = (message: ReturnType<typeof queueMessage>) => consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => expectedScopeA,
      now: () => NOW,
      process,
      ownership: queueOwnership,
      payload_hash: () => `sha256:${"a".repeat(64)}`,
      retention_until: () => RETENTION_UNTIL,
      log_error: logError,
    });

    const first = queueMessage(value);
    await run(first);
    const redelivery = queueMessage(value);
    await run(redelivery);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(redelivery.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(redelivery.retry).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledOnce();
    expect(quota.read_authoritative_decision).toHaveBeenCalledOnce();
    expect(quota.read_authoritative_decision).toHaveBeenCalledWith({
      tenant_context: value,
      metric: "tool_calls",
      requested_quantity: 1,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(accounting.write).toHaveBeenCalledOnce();
    expect(accounting.write).toHaveBeenCalledWith(expect.objectContaining({
      usage_events: [expect.objectContaining({
        tenant_id: TENANT_A,
        unit: "model_tokens",
        collection_state: "not_collected",
        quantity: null,
        unknown_fields: ["observed_units"],
      })],
      receipt: expect.objectContaining({
        tenant_id: TENANT_A,
        collection_state: "not_collected",
        outcome: "succeeded",
        reply: expect.objectContaining({ state: "delivered", reply_count: 1, legacy_reply_count: 0 }),
      }),
    }));
  });

  it("does not execute a blocked operation or consume quota again on the same idempotency retry", async () => {
    const { value, publicKey } = await signedEnvelope({
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      workspace_id: "T-A",
      channel_id: "C-A",
      actor_principal_id: "person-a",
      project_id: "project-a",
      deployment_id: DEPLOYMENT_A,
      event_id: "Ev-A-PROD-BLOCKED-001",
      operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FC0",
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FC1",
    });
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => snapshotA,
      resolve_verification_key: async () => publicKey,
    });
    const ownership = new IdempotencyMemoryStore();
    const ledger = new TenantAccountingLedger();
    const quota = {
      read_authoritative_decision: vi.fn(async (request: { metric: string; requested_quantity: number }) => {
        expect(request).toEqual(expect.objectContaining({ metric: "tool_calls", requested_quantity: 1 }));
        return hardStoppedQuota(TENANT_A);
      }),
    };
    const accounting = { write: vi.fn(async () => ({ result_ref: "blocked-receipt" })) };
    const operation = vi.fn(async () => ({ outcome: "completed" as const }));
    const process = vi.fn((_payload: unknown, tenantContext: TenantContextEnvelope) => executeTenantRuntimeOperation({
      tenant_context: tenantContext,
      expected_scope: expectedScopeA,
      verifier,
      quota,
      accounting,
      ledger,
      usage_unit: "model_tokens",
      now: () => NOW,
      process: operation,
    }));
    const run = (message: ReturnType<typeof queueMessage>) => consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => expectedScopeA,
      now: () => NOW,
      process,
      ownership,
      payload_hash: () => `sha256:${"b".repeat(64)}`,
      retention_until: () => RETENTION_UNTIL,
    });

    const first = queueMessage(value);
    await run(first);
    const retry = queueMessage(value);
    await run(retry);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(retry.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(retry.retry).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    expect(quota.read_authoritative_decision).toHaveBeenCalledOnce();
    expect(accounting.write).toHaveBeenCalledOnce();
  });

  it("rejects a signed tenant B context before quota, processing, delivery, or accounting under tenant A scope", async () => {
    const { value, publicKey } = await signedEnvelope({
      tenant_id: TENANT_B,
      connection_id: CONNECTION_B,
      workspace_id: "T-B",
      channel_id: "C-B",
      actor_principal_id: "person-b",
      project_id: "project-b",
      deployment_id: DEPLOYMENT_B,
      event_id: "Ev-B-PROD-001",
      operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FB6",
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FB7",
    });
    const snapshotB = snapshot({
      tenant_id: TENANT_B,
      connection_id: CONNECTION_B,
      workspace_id: "T-B",
      deployment_id: DEPLOYMENT_B,
    });
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => snapshotB,
      resolve_verification_key: async () => publicKey,
    });
    const process = vi.fn();
    const logError = vi.fn();
    const message = queueMessage(value);

    await consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => ({
        ...expectedScopeA,
        workspace_id: "T-B",
        channel_id: "C-B",
        actor_principal_id: "person-b",
        project_id: "project-b",
      }),
      now: () => NOW,
      process,
      ownership: new IdempotencyMemoryStore(),
      payload_hash: () => `sha256:${"b".repeat(64)}`,
      retention_until: () => RETENTION_UNTIL,
      log_error: logError,
    });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ code: "CROSS_TENANT_CANDIDATE" }));
  });

  it("retries an authoritative connection outage without treating it as no data or producing side effects", async () => {
    const { value, publicKey } = await signedEnvelope({
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      workspace_id: "T-A",
      channel_id: "C-A",
      actor_principal_id: "person-a",
      project_id: "project-a",
      deployment_id: DEPLOYMENT_A,
      event_id: "Ev-A-PROD-002",
      operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FB8",
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FB9",
    });
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => { throw new Error("authority timeout"); },
      resolve_verification_key: async () => publicKey,
    });
    const process = vi.fn();
    const logError = vi.fn();
    const message = queueMessage(value);

    await consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => expectedScopeA,
      now: () => NOW,
      process,
      ownership: new IdempotencyMemoryStore(),
      payload_hash: () => `sha256:${"c".repeat(64)}`,
      retention_until: () => RETENTION_UNTIL,
      log_error: logError,
    });

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(process).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      code: "WORKSPACE_CONNECTION_UNAVAILABLE",
      stage: "queue_context_validation",
      boundary: "queue_consumer",
    }));
  });

  it("logs the failing tenant boundary and process stage for retryable processing failures", async () => {
    const { value, publicKey } = await signedEnvelope({
      tenant_id: TENANT_A,
      connection_id: CONNECTION_A,
      workspace_id: "T-A",
      channel_id: "C-A",
      actor_principal_id: "person-a",
      project_id: "project-a",
      deployment_id: DEPLOYMENT_A,
      event_id: "Ev-A-PROD-003",
      operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FBA",
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FBB",
    });
    const verifier = new TenantRuntimeBoundaryVerifier({
      read_authoritative_snapshot: async () => snapshot({
        tenant_id: TENANT_A,
        connection_id: CONNECTION_A,
        workspace_id: "T-A",
        deployment_id: DEPLOYMENT_A,
      }),
      resolve_verification_key: async () => publicKey,
    });
    const logError = vi.fn();
    const message = queueMessage(value);

    await consumeTenantQueueMessage(message, {
      verifier,
      expected_scope: () => expectedScopeA,
      now: () => NOW,
      process: async () => { throw new TenantBoundaryError(
        "slack_delivery",
        "WORKSPACE_CONNECTION_UNAVAILABLE",
        "WORKSPACE_CONNECTION_UNAVAILABLE",
        { phase: "response_body", path: "/workspace-connections:validate-revision", error_name: "TypeError" },
      ); },
      ownership: new IdempotencyMemoryStore(),
      payload_hash: () => `sha256:${"d".repeat(64)}`,
      retention_until: () => RETENTION_UNTIL,
      log_error: logError,
    });

    expect(message.retry).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      code: "WORKSPACE_CONNECTION_UNAVAILABLE",
      stage: "tenant_process",
      boundary: "slack_delivery",
      phase: "response_body",
      path: "/workspace-connections:validate-revision",
      error_name: "TypeError",
    }));
  });
});
