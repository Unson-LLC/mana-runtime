import { describe, expect, it, vi } from "vitest";
import {
  ExternalEffectOutboxMemoryStore,
  ExternalEffectReconciliationMemoryQueue,
  processCompanyAuthorityExternalEffect,
  reconcileCompanyAuthorityExternalEffectFromQueue,
  type ExternalEffectReconciliationJob,
  type ExternalEffectReconciliationQueue,
  type ExternalEffectRecoveryRecord,
} from "../multitenancy/company-authority-external-effect-outbox.js";
import type { AcceptedCompanyAuthorityContext } from "../multitenancy/company-authority-runtime-adapter.js";
import type { AccountingArtifact } from "../multitenancy/accounting.js";
import type { TenantContextEnvelope } from "../multitenancy/contracts.js";
import {
  createDurableExternalEffectReconciliationQueue,
  type TenantStateTransaction,
} from "../multitenancy/tenant-runtime-state.js";

class MemoryStorage implements TenantStateTransaction {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: TenantStateTransaction) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const tenantContext: TenantContextEnvelope = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime"],
  tenant: { tenant_id: "ten_reconcile", tenant_revision: "rev-1" },
  workspace_connection: {
    connection_id: "conn_reconcile",
    connection_revision: "conn-rev-1",
    provider: "slack",
    installation_id: "install-reconcile",
    workspace_id: "T_RECONCILE",
    app_id: "A_RECONCILE",
    status: "active",
  },
  actor: {
    principal_id: "person_reconcile",
    principal_type: "person",
    authenticated_subject_id: "U_RECONCILE",
  },
  authorization: {
    organization_ids: ["org_reconcile"],
    project_ids: ["project_reconcile"],
    data_scopes: ["runtime.execute"],
    capability_ids: ["company_authority_v1"],
  },
  placement: { deployment_id: "deploy-reconcile", profile: "shared_cloud" },
  slack: {
    event_id: "event_reconcile",
    channel_id: "C_RECONCILE",
    thread_ts: "1000.0001",
    requester_id: "U_RECONCILE",
  },
  correlation_id: "corr_reconcile",
  operation_id: "op_reconcile",
  idempotency_key: "effect_reconcile",
  contract_revision: "contract-reconcile",
  credential: {
    mode: "cloud_standard",
    credential_ref: "credential-ref-reconcile",
    billing_principal_id: "person_reconcile",
  },
  issued_at: "2026-09-05T00:00:00.000Z",
  expires_at: "2026-09-05T00:05:00.000Z",
  integrity: {
    method: "jws_detached",
    algorithm: "EdDSA",
    key_id: "tenant-key-reconcile",
    value: "protected..signature",
  },
};

const accountingArtifact: AccountingArtifact = {
  partition_key: "tp1/reconcile/usage",
  usage_events: [{
    message_type: "usage_event",
    usage_event_id: "usage_reconcile",
    protocol_version: tenantContext.protocol_version,
    tenant_id: tenantContext.tenant.tenant_id,
    connection_id: tenantContext.workspace_connection.connection_id,
    connection_revision: tenantContext.workspace_connection.connection_revision,
    contract_revision: tenantContext.contract_revision,
    deployment_id: tenantContext.placement.deployment_id,
    correlation_id: tenantContext.correlation_id,
    operation_id: tenantContext.operation_id,
    idempotency_key: tenantContext.idempotency_key,
    kind: "model_tokens",
    quantity: 1,
    unit: "model_tokens",
    outcome: "succeeded",
    collection_state: "collected",
    failure_code: null,
    unknown_fields: [],
    observed_at: "2026-09-05T00:00:01.000Z",
  }],
  receipt: {
    message_type: "operation_receipt",
    receipt_id: "receipt_reconcile",
    protocol_version: tenantContext.protocol_version,
    tenant_id: tenantContext.tenant.tenant_id,
    connection_id: tenantContext.workspace_connection.connection_id,
    connection_revision: tenantContext.workspace_connection.connection_revision,
    contract_revision: tenantContext.contract_revision,
    deployment_id: tenantContext.placement.deployment_id,
    correlation_id: tenantContext.correlation_id,
    operation_ids: [tenantContext.operation_id],
    idempotency_keys: [tenantContext.idempotency_key],
    actor_principal_id: tenantContext.actor.principal_id,
    project_id: "project_reconcile",
    capability_id: "company_authority_v1",
    quota_decision: "allowed",
    credential_mode: tenantContext.credential.mode,
    collection_state: "collected",
    outcome: "succeeded",
    failure_code: null,
    usage_event_ids: ["usage_reconcile"],
    reply: { state: "delivered", reply_count: 1, legacy_reply_count: 0, slack_reply_ts: "1000.0002" },
    completed_at: "2026-09-05T00:00:01.000Z",
  },
};

const recovery: ExternalEffectRecoveryRecord = {
  runtime_event_id: "message_1000_0000",
  runtime_claim_token: "runtime-claim-reconcile",
  operation_id: tenantContext.operation_id,
  correlation_id: tenantContext.correlation_id,
  accounting_context: tenantContext,
  accounting_artifact: accountingArtifact,
  delivery_identity: {
    provider: "slack",
    workspace_id: tenantContext.workspace_connection.workspace_id,
    app_id: tenantContext.workspace_connection.app_id,
    channel_id: tenantContext.slack.channel_id,
    thread_ts: tenantContext.slack.thread_ts!,
    event_id: tenantContext.slack.event_id,
    delivery_id: "message_1000_0000",
    message_ts: "1000.0000",
  },
};

function acceptedContext(): AcceptedCompanyAuthorityContext {
  return {
    schema_version: "1.0",
    tenant_context: tenantContext as unknown as AcceptedCompanyAuthorityContext["tenant_context"],
    actor: {},
    scope: { project_id: "project_reconcile" },
    authority: { decision: "auto", capability_id: "runtime.execute", allowed_effects: ["external_side_effect"] },
    evidence: {},
    issued_at: tenantContext.issued_at,
    expires_at: tenantContext.expires_at,
    integrity: tenantContext.integrity,
  };
}

async function createUnknownEffect(
  queue: ExternalEffectReconciliationQueue = new ExternalEffectReconciliationMemoryQueue(),
) {
  const outbox = new ExternalEffectOutboxMemoryStore();
  await processCompanyAuthorityExternalEffect({
    context: acceptedContext(),
    payload: { action: "reply" },
    outbox,
    recovery,
    reconciliation_queue: queue,
    now: () => 1_000,
    create_claim_token: () => "effect-claim-reconcile",
    provider_send: async () => ({ applied: true as const, response_observed: false as const }),
  });
  const job = await queue.read(tenantContext.tenant.tenant_id, tenantContext.idempotency_key);
  if (!job) throw new Error("reconciliation_job_missing");
  return { outbox, queue, job };
}

describe("company authority external effect reconciliation boundary", () => {
  it("durably stores one tenant/effect reconciliation job and rejects scope or identity conflicts", async () => {
    const storage = new MemoryStorage();
    const scope = { tenant_id: tenantContext.tenant.tenant_id, effect_id: tenantContext.idempotency_key };
    const first = createDurableExternalEffectReconciliationQueue(storage, scope);
    const { job } = await createUnknownEffect(first);

    const restarted = createDurableExternalEffectReconciliationQueue(storage, scope);
    await expect(restarted.read(scope.tenant_id, scope.effect_id)).resolves.toEqual(job);
    await expect(restarted.read("ten_other", scope.effect_id))
      .rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });
    await expect(restarted.enqueue({ ...job, payload_hash: "sha256:tampered" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("persists tenant-bound recovery metadata and enqueues it after an unknown provider result", async () => {
    const { outbox, job } = await createUnknownEffect();
    await expect(outbox.read(tenantContext.tenant.tenant_id, tenantContext.idempotency_key))
      .resolves.toMatchObject({
        state: "unknown_requires_reconcile",
        provider_key: expect.stringMatching(/^sha256:/),
        recovery: {
          runtime_event_id: recovery.runtime_event_id,
          runtime_claim_token: recovery.runtime_claim_token,
          operation_id: recovery.operation_id,
          correlation_id: recovery.correlation_id,
          accounting_context: recovery.accounting_context,
          accounting_artifact: recovery.accounting_artifact,
          delivery_identity: recovery.delivery_identity,
        },
      });
    expect(job).toMatchObject({
      schema_version: "1.0",
      tenant_id: tenantContext.tenant.tenant_id,
      effect_id: tenantContext.idempotency_key,
      provider_key: expect.stringMatching(/^sha256:/),
      recovery,
    });
  });

  it("reconciles by provider readback and settlement without exposing a provider send path", async () => {
    const { outbox, job } = await createUnknownEffect();
    const providerReconcile = vi.fn(async ({ provider_key }: { provider_key: string }) => ({
      state: "succeeded" as const,
      result_ref: `provider:${provider_key}`,
    }));
    const verifyContext = vi.fn(async (_context: TenantContextEnvelope) => undefined);
    const settleConfirmed = vi.fn(async (_input: {
      record: unknown;
      result_ref: string;
      recovery: ExternalEffectRecoveryRecord;
    }) => undefined);

    const result = await reconcileCompanyAuthorityExternalEffectFromQueue({
      job,
      outbox,
      provider_reconcile: providerReconcile,
      verify_context: verifyContext,
      settle_confirmed: settleConfirmed,
    });

    expect(result).toMatchObject({ state: "succeeded" });
    expect(providerReconcile).toHaveBeenCalledOnce();
    expect(verifyContext).toHaveBeenCalledOnce();
    expect(settleConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      result_ref: expect.stringMatching(/^provider:sha256:/),
      recovery,
    }));
  });

  it("keeps unknown sticky when provider readback is still unknown", async () => {
    const { outbox, job } = await createUnknownEffect();
    const providerReconcile = vi.fn(async () => ({ state: "unknown" as const }));
    const settleConfirmed = vi.fn();
    const result = await reconcileCompanyAuthorityExternalEffectFromQueue({
      job,
      outbox,
      provider_reconcile: providerReconcile,
      verify_context: async () => undefined,
      settle_confirmed: settleConfirmed,
    });

    expect(result).toMatchObject({ state: "unknown_requires_reconcile" });
    expect(settleConfirmed).not.toHaveBeenCalled();
    await expect(outbox.read(job.tenant_id, job.effect_id)).resolves.toMatchObject({
      state: "unknown_requires_reconcile",
    });
  });

  it("fails closed before provider readback when the queue identity is mismatched", async () => {
    const { outbox, job } = await createUnknownEffect();
    const providerReconcile = vi.fn();
    const tampered: ExternalEffectReconciliationJob = {
      ...job,
      payload_hash: "sha256:tampered",
    };

    await expect(reconcileCompanyAuthorityExternalEffectFromQueue({
      job: tampered,
      outbox,
      provider_reconcile: providerReconcile,
      verify_context: async () => undefined,
      settle_confirmed: async () => undefined,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(providerReconcile).not.toHaveBeenCalled();
  });
});
