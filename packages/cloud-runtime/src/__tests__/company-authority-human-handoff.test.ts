import { describe, expect, it } from "vitest";
import {
  CompanyAuthorityHumanHandoffMemoryStore,
  processCompanyAuthorityHumanHandoff,
  type CompanyAuthorityHumanHandoffRecord,
} from "../multitenancy/company-authority-human-handoff.js";
import type {
  AcceptedCompanyAuthorityContext,
  ObservedExecutionRequestV1,
} from "../multitenancy/company-authority-runtime-adapter.js";
import {
  createDurableCompanyAuthorityHumanHandoffClient,
  TenantRuntimeStateHandler,
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

  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class TenantRuntimeNamespace {
  readonly handlers = new Map<string, TenantRuntimeStateHandler>();
  readonly storages = new Map<string, MemoryStorage>();

  idFromName(name: string): string { return name; }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return {
      fetch: (request) => {
        let handler = this.handlers.get(key);
        if (!handler) {
          const storage = new MemoryStorage();
          this.storages.set(key, storage);
          handler = new TenantRuntimeStateHandler(storage, key);
          this.handlers.set(key, handler);
        }
        return handler.fetch(request);
      },
    };
  }
}

function request(desiredEffect: "write" | "external_side_effect"): ObservedExecutionRequestV1 {
  return {
    provider_identity: {
      provider: "slack",
      authenticated_subject_id: "person-sato",
      workspace_id: "workspace-a",
      app_id: "app-a",
    },
    requested_action: {
      capability_id: desiredEffect === "write" ? "company_write" : "company_external_side_effect",
      resource_ref: desiredEffect === "write"
        ? "company://tenant-a/project-a/write"
        : "company://tenant-a/project-a/external",
      project_hint: "project-a",
      desired_effect: desiredEffect,
    },
    delivery: { channel_id: "channel-a", thread_ts: "thread-a", event_id: "event-a" },
    correlation_id: "correlation-a",
  };
}

function context(decision: "approval" | "human_action"): AcceptedCompanyAuthorityContext {
  const desiredEffect = decision === "approval" ? "external_side_effect" : "write";
  return {
    schema_version: "1.0",
    tenant_context: {
      tenant: { tenant_id: "tenant-a" },
      operation_id: "operation-a",
      idempotency_key: "handoff-a",
      correlation_id: "correlation-a",
    },
    actor: { canonical_person_id: "person-sato" },
    scope: {
      organization_id: "organization-a",
      project_id: "project-a",
      resource_ref: request(desiredEffect).requested_action.resource_ref,
    },
    authority: {
      decision,
      capability_id: request(desiredEffect).requested_action.capability_id,
      allowed_effects: [desiredEffect],
      approver_person_id: decision === "approval" ? "person-umeda" : null,
      responsible_person_id: decision === "human_action" ? "person-umeda" : null,
      policy_revision: "policy-1",
      raci_revision: "raci-1",
      resource_revision: "resource-1",
    },
    evidence: { authority_resolution_receipt_id: `receipt-${decision}` },
    issued_at: "2026-09-02T00:00:00.000Z",
    expires_at: "2026-09-02T00:05:00.000Z",
    integrity: { method: "jws_detached", value: `signature-${decision}` },
  };
}

async function persist(
  decision: "approval" | "human_action",
  store = new CompanyAuthorityHumanHandoffMemoryStore(),
): Promise<{ record: CompanyAuthorityHumanHandoffRecord; store: CompanyAuthorityHumanHandoffMemoryStore }> {
  const desiredEffect = decision === "approval" ? "external_side_effect" : "write";
  const result = await processCompanyAuthorityHumanHandoff({
    context: context(decision),
    request: request(desiredEffect),
    payload: { event_id: "event-a", text: "accepted snapshot" },
    execution_hash: `sha256:${decision}`,
    store,
    now: () => "2026-09-02T00:01:00.000Z",
  });
  return { record: result.record, store };
}

describe("company authority human handoff", () => {
  it("persists approval only for the signed approver without marking notification or completion", async () => {
    const { record } = await persist("approval");

    expect(record).toMatchObject({
      tenant_id: "tenant-a",
      handoff_id: "handoff-a",
      execution_hash: "sha256:approval",
      decision: "approval",
      state: "pending_approval",
      target: { role: "approver", person_id: "person-umeda" },
      capability_id: "company_external_side_effect",
      desired_effect: "external_side_effect",
      authority_receipt_id: "receipt-approval",
    });
    expect(record).not.toHaveProperty("notified_at");
    expect(record).not.toHaveProperty("completed_at");
    expect(record.source.context.integrity).toEqual(context("approval").integrity);
  });

  it("persists human action only for the signed responsible person and remains pending", async () => {
    const { record } = await persist("human_action");

    expect(record).toMatchObject({
      decision: "human_action",
      state: "pending_human_action",
      target: { role: "responsible", person_id: "person-umeda" },
      capability_id: "company_write",
      desired_effect: "write",
    });
    expect(record).not.toHaveProperty("completed_at");
  });

  it("returns one identical record on redelivery and rejects changed accepted evidence", async () => {
    const first = await persist("approval");
    const duplicate = await processCompanyAuthorityHumanHandoff({
      context: context("approval"),
      request: request("external_side_effect"),
      payload: { event_id: "event-a", text: "accepted snapshot" },
      execution_hash: "sha256:approval",
      store: first.store,
      now: () => "2026-09-02T00:02:00.000Z",
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.record).toEqual(first.record);
    await expect(processCompanyAuthorityHumanHandoff({
      context: context("approval"),
      request: request("external_side_effect"),
      payload: { event_id: "event-a", text: "tampered after acceptance" },
      execution_hash: "sha256:changed",
      store: first.store,
      now: () => "2026-09-02T00:03:00.000Z",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await first.store.read("tenant-a", "handoff-a")).toEqual(first.record);
  });

  it.each([
    ["approval", null, null],
    ["approval", null, "person-other"],
    ["human_action", null, null],
    ["human_action", "person-other", null],
  ] as const)("rejects %s with missing signed target", async (
    decision,
    approverPersonId,
    responsiblePersonId,
  ) => {
    const accepted = structuredClone(context(decision));
    Object.assign(accepted.authority, {
      approver_person_id: approverPersonId,
      responsible_person_id: responsiblePersonId,
    });
    const desiredEffect = decision === "approval" ? "external_side_effect" : "write";
    const store = new CompanyAuthorityHumanHandoffMemoryStore();

    await expect(processCompanyAuthorityHumanHandoff({
      context: accepted,
      request: request(desiredEffect),
      payload: { event_id: "event-a" },
      execution_hash: "sha256:invalid",
      store,
      now: () => "2026-09-02T00:01:00.000Z",
    })).rejects.toMatchObject({ code: "AUTHORITY_SCOPE_MISMATCH" });
    expect(await store.read("tenant-a", "handoff-a")).toBeNull();
  });

  it.each([
    ["approval", "person-umeda", "person-responsible", { role: "approver", person_id: "person-umeda" }],
    ["human_action", "person-approver", "person-umeda", { role: "responsible", person_id: "person-umeda" }],
  ] as const)("accepts %s when both signed targets are present", async (
    decision,
    approverPersonId,
    responsiblePersonId,
    target,
  ) => {
    const accepted = structuredClone(context(decision));
    Object.assign(accepted.authority, {
      approver_person_id: approverPersonId,
      responsible_person_id: responsiblePersonId,
    });
    const desiredEffect = decision === "approval" ? "external_side_effect" : "write";
    const { record } = await processCompanyAuthorityHumanHandoff({
      context: accepted,
      request: request(desiredEffect),
      payload: { event_id: "event-a" },
      execution_hash: `sha256:${decision}:dual-target`,
      store: new CompanyAuthorityHumanHandoffMemoryStore(),
      now: () => "2026-09-02T00:01:00.000Z",
    });

    expect(record.target).toEqual(target);
  });

  it("persists through the tenant-bound durable client and rejects cross-scope reads", async () => {
    const namespace = new TenantRuntimeNamespace();
    const scope = { tenant_id: "tenant-a", handoff_id: "handoff-a" };
    const store = createDurableCompanyAuthorityHumanHandoffClient(namespace, scope);
    const result = await processCompanyAuthorityHumanHandoff({
      context: context("approval"),
      request: request("external_side_effect"),
      payload: { event_id: "event-a", text: "accepted snapshot" },
      execution_hash: "sha256:approval",
      store,
      now: () => "2026-09-02T00:01:00.000Z",
    });
    const restarted = createDurableCompanyAuthorityHumanHandoffClient(namespace, scope);

    expect(await restarted.read("tenant-a", "handoff-a")).toEqual(result.record);
    await expect(restarted.read("tenant-b", "handoff-a"))
      .rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });
  });
});
