import { describe, expect, it, vi } from "vitest";
import type {
  CredentialLeaseRequest,
  QuotaDecision,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { createTenantRuntimeHttpClients, parseWorkspaceConnectionHints } from "../multitenancy/http-clients.js";
import { createOperationReceipt, createUsageEvent } from "../multitenancy/accounting.js";

const NOW = "2026-08-19T01:00:00.000Z";
const TENANT_ID = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONNECTION_ID = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEPLOYMENT_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OPERATION_ID = "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ";

const snapshot: WorkspaceConnectionSnapshot = {
  tenant_id: TENANT_ID,
  connection_id: CONNECTION_ID,
  connection_revision: "7",
  installation_id: "I1",
  workspace_id: "T1",
  app_id: "A1",
  installer_id: "U1",
  granted_scopes: ["app_mentions:read"],
  status: "active",
  deployment_id: DEPLOYMENT_ID,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "11",
};

const context: TenantContextEnvelope = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime"],
  tenant: { tenant_id: TENANT_ID, tenant_revision: "3" },
  workspace_connection: {
    connection_id: CONNECTION_ID,
    connection_revision: "7",
    provider: "slack",
    installation_id: "I1",
    workspace_id: "T1",
    app_id: "A1",
    status: "active",
  },
  actor: { principal_id: "person-1", principal_type: "person", authenticated_subject_id: "U1" },
  authorization: {
    organization_ids: ["organization-1"],
    project_ids: ["project-1"],
    data_scopes: [
      "company_authority:decision:auto",
      "company_authority:membership:membership-1@3",
      "company_authority:resource:project:project-1@12",
      "company_authority:raci:5",
      "company_authority:policy:8",
      "company_authority:effect:write",
      "company_authority:placement:placement-1",
      "company_authority:identity_receipt:idres-1",
      "company_authority:authority_receipt:authres-1",
    ],
    capability_ids: ["task.write"],
  },
  placement: { deployment_id: DEPLOYMENT_ID, profile: "shared_cloud" },
  slack: { event_id: "Ev1", channel_id: "C1", thread_ts: "1.0", requester_id: "U1" },
  correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  operation_id: OPERATION_ID,
  idempotency_key: `ik1_${"a".repeat(43)}`,
  contract_revision: "11",
  credential: {
    mode: "customer_oauth", credential_ref: "credential-ref-1", billing_principal_id: "person-1",
  },
  issued_at: NOW,
  expires_at: "2026-08-19T01:05:00.000Z",
  integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "key-1", value: "signature" },
};

function clients(fetchImpl: typeof fetch) {
  return createTenantRuntimeHttpClients({
    deployment_profile: "shared_cloud",
    service: { fetch: fetchImpl },
    timeout_ms: 5_000,
  }, { now: () => NOW });
}

describe("Brainbase canonical tenant runtime transport", () => {
  it("rejects a routing-only hint before it can erase the trusted deployment boundary", () => {
    const { deployment_id: _deploymentId, ...incomplete } = snapshot;
    expect(() => parseWorkspaceConnectionHints(JSON.stringify([{
      ...incomplete,
      tenant_revision: "3",
    }]))).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
  });

  it("resolves a signed context through the single Service Binding without a generic operation envelope", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://brainbase.internal/api/v1/runtime/tenant-context:resolve");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toEqual({
        tenant_id: TENANT_ID,
        expected_tenant_revision: "3",
        connection_id: CONNECTION_ID,
        expected_connection_revision: "7",
        workspace_id: "T1",
        app_id: "A1",
        provider_identity: {
          provider: "slack",
          authenticated_subject_id: "U1",
          workspace_id: "T1",
          app_id: "A1",
        },
        requested_action: {
          capability_id: "task.write",
          resource_ref: "project:project-1",
          project_hint: "project-1",
          desired_effect: "write",
        },
        slack: context.slack,
        correlation_id: context.correlation_id,
        operation_id: context.operation_id,
      });
      expect(String(init?.body)).not.toContain('"operation"');
      expect(String(init?.body)).not.toContain('"input"');
      expect(String(init?.body)).not.toContain('"actor"');
      expect(String(init?.body)).not.toContain('"authorization"');
      expect(String(init?.body)).not.toContain('"billing_principal_id"');
      return Response.json(context);
    });
    const result = await clients(fetchMock).authority.issue_tenant_context({
      workspace_connection: snapshot,
      tenant_revision: "3",
      actor: context.actor,
      authorization: context.authorization,
      slack: {
        event_id: context.slack.event_id,
        channel_id: context.slack.channel_id,
        thread_ts: context.slack.thread_ts ?? "",
        requester_id: context.slack.requester_id ?? "",
      },
      correlation_id: context.correlation_id,
      operation_id: context.operation_id,
      billing_principal_id: "person-1",
      required_authorization: { audience: "mana-runtime", project_id: "project-1", capability_id: "task.write" },
    });
    expect(result).toEqual(context);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a service actor identity for scheduled external task-board writes", async () => {
    const serviceContext = structuredClone(context);
    serviceContext.actor = {
      principal_id: "svc_mana_runtime",
      principal_type: "service",
      authenticated_subject_id: "svc_mana_runtime",
    };
    serviceContext.slack.requester_id = "svc_mana_runtime";
    serviceContext.authorization.capability_ids = ["task_board_send"];
    serviceContext.authorization.data_scopes = serviceContext.authorization.data_scopes
      .map((scope) => scope === "company_authority:effect:write"
        ? "company_authority:effect:external_side_effect" : scope);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.provider_identity).toEqual({
        provider: "service",
        authenticated_subject_id: "svc_mana_runtime",
        workspace_id: "T1",
        app_id: "A1",
      });
      expect(body.requested_action).toMatchObject({
        capability_id: "task_board_send",
        desired_effect: "external_side_effect",
      });
      return Response.json(serviceContext);
    });
    const result = await clients(fetchMock).authority.issue_tenant_context({
      workspace_connection: snapshot,
      tenant_revision: "3",
      slack: {
        event_id: serviceContext.slack.event_id,
        channel_id: serviceContext.slack.channel_id,
        thread_ts: serviceContext.slack.thread_ts ?? "",
        requester_id: serviceContext.slack.requester_id ?? "",
      },
      provider_identity: {
        provider: "service",
        authenticated_subject_id: "svc_mana_runtime",
        workspace_id: "T1",
        app_id: "A1",
      },
      required_authorization: {
        audience: "mana-runtime",
        project_id: "project-1",
        capability_id: "task_board_send",
      },
    });
    expect(result.actor.principal_type).toBe("service");
  });

  it("sends signed tenant context and protocol/deployment headers on credential and quota calls", async () => {
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const leaseRequest: CredentialLeaseRequest = {
      message_type: "credential_lease_request",
      protocol_version: "1.0",
      binding: {
        tenant_id: TENANT_ID, connection_id: CONNECTION_ID, connection_revision: "7",
        contract_revision: "11", operation_id: OPERATION_ID, audience: "api.anthropic.com",
        credential_mode: "customer_oauth", credential_ref: "credential-ref-1",
      },
      requested_ttl_seconds: 60,
    };
    const quota: QuotaDecision = {
      message_type: "quota_decision", tenant_id: TENANT_ID, contract_revision: "11", quota_revision: "4",
      decision: "allowed", limit: 100, used: 1, remaining: 99, unit: "tool_calls",
      window_started_at: NOW, window_ends_at: "2026-08-20T01:00:00.000Z", decided_at: NOW, failure_code: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ url: String(input), headers: new Headers(init?.headers), body });
      if (String(input).endsWith("/credential-leases")) {
        return Response.json({
          message_type: "credential_lease_response", protocol_version: "1.0",
          lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB2", contract_revision: "11",
          binding: leaseRequest.binding, issued_at: NOW, expires_at: "2026-08-19T01:01:00.000Z",
          max_uses: 1, lease_token: "opaque-lease-token",
        }, { status: 201 });
      }
      return Response.json(quota);
    });
    const runtime = clients(fetchMock);
    await runtime.credential_broker.acquire_lease(leaseRequest, context);
    await runtime.quota.read_authoritative_decision({
      tenant_context: context, metric: "tool_calls", requested_quantity: 1,
    });

    expect(seen.map((request) => request.url)).toEqual([
      "https://brainbase.internal/api/v1/runtime/credential-leases",
      "https://brainbase.internal/api/v1/runtime/quota:decide",
    ]);
    for (const request of seen) {
      expect(request.headers.get("brainbase-protocol-version")).toBe("1.0");
      expect(request.headers.get("brainbase-deployment-id")).toBe(DEPLOYMENT_ID);
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.body.tenant_context).toEqual(context);
    }
    expect(seen[1]?.body).toEqual({
      tenant_context: context,
      metric: "tool_calls",
      requested_quantity: 1,
    });
    expect(seen[1]?.body).not.toHaveProperty("observed_quantity");
    expect(seen[1]?.body).not.toHaveProperty("window_started_at");
    expect(seen[1]?.body).not.toHaveProperty("window_ends_at");
  });

  it("rejects a missing or mismatched quota metric before making an upstream request", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      message_type: "quota_decision", tenant_id: TENANT_ID, contract_revision: "11",
      quota_revision: "4", decision: "allowed", limit: 100, used: 1, remaining: 99,
      unit: "tool_calls", window_started_at: NOW, window_ends_at: NOW,
      decided_at: NOW, failure_code: null,
    }));
    const runtime = clients(fetchMock);

    await expect(runtime.quota.read_authoritative_decision({
      tenant_context: context, metric: "model_tokens", requested_quantity: 1,
    })).rejects.toMatchObject({ code: "QUOTA_INPUT_INVALID" });
    await expect(runtime.quota.read_authoritative_decision({
      tenant_context: context, metric: "tool_calls", requested_quantity: 0,
    })).rejects.toMatchObject({ code: "QUOTA_INPUT_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a quota decision whose canonical unit does not match the requested metric", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      message_type: "quota_decision", tenant_id: TENANT_ID, contract_revision: "11",
      quota_revision: "4", decision: "allowed", limit: 100, used: 1, remaining: 99,
      unit: "model_tokens", window_started_at: NOW, window_ends_at: NOW,
      decided_at: NOW, failure_code: null,
    }));
    const runtime = clients(fetchMock);

    await expect(runtime.quota.read_authoritative_decision({
      tenant_context: context, metric: "tool_calls", requested_quantity: 1,
    })).rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("writes usage before receipt finalization and safely retries the same canonical identifiers", async () => {
    const calls: string[] = [];
    let failReceipt = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const body = JSON.parse(String(init?.body));
      expect(body.tenant_context).toEqual(context);
      if (url.endsWith("/usage-events")) return Response.json(body, { status: 202 });
      if (failReceipt) {
        failReceipt = false;
        return Response.json({ code: "UPSTREAM_UNAVAILABLE", retryable: true, fault_domain: "brainbase_cloud" }, { status: 503 });
      }
      return Response.json(body, { status: 201 });
    });
    const usage = createUsageEvent({
      usage_event_id: "usage_01ARZ3NDEKTSV4RRFFQ69G5FB8", protocol_version: "1.0",
      tenant_id: TENANT_ID, connection_id: CONNECTION_ID, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_ID, correlation_id: context.correlation_id, operation_id: OPERATION_ID,
      idempotency_key: context.idempotency_key, kind: "runtime_operation", quantity: 1, unit: "requests",
      collection_state: "collected", outcome: "succeeded", observed_at: NOW,
    });
    const receipt = createOperationReceipt({
      receipt_id: "receipt_01ARZ3NDEKTSV4RRFFQ69G5FB9", protocol_version: "1.0",
      tenant_id: TENANT_ID, connection_id: CONNECTION_ID, connection_revision: "7", contract_revision: "11",
      deployment_id: DEPLOYMENT_ID, correlation_id: context.correlation_id, operation_ids: [OPERATION_ID],
      idempotency_keys: [context.idempotency_key], actor_principal_id: "person-1", project_id: "project-1",
      capability_id: "task.write", quota_decision: "allowed", credential_mode: "customer_oauth",
      collection_state: "collected", outcome: "succeeded", usage_event_ids: [usage.usage_event_id],
      reply: { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 }, completed_at: NOW,
    });
    const runtime = clients(fetchMock);
    const payload = { tenant_context: context, partition_key: "ignored-by-canonical-api", usage_events: [usage], receipt };
    await expect(runtime.accounting.write(payload)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(runtime.accounting.write(payload)).resolves.toEqual({ result_ref: receipt.receipt_id });
    expect(calls.map((url) => url.split("/api/v1/runtime/")[1])).toEqual([
      "usage-events", "operation-receipts:finalize", "usage-events", "operation-receipts:finalize",
    ]);
  });

  it("fails closed without the Service Binding and preserves canonical problem codes", async () => {
    expect(() => createTenantRuntimeHttpClients({
      deployment_profile: "shared_cloud", timeout_ms: 5_000,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));

    const runtime = clients(vi.fn(async () => Response.json({
      type: "urn:brainbase:error:workspace-connection-stale-revision",
      title: "Workspace connection revision is stale",
      status: 409,
      code: "WORKSPACE_CONNECTION_STALE_REVISION",
      retryable: false,
      fault_domain: "protocol",
    }, { status: 409, headers: { "content-type": "application/problem+json" } })));
    await expect(runtime.quota.read_authoritative_decision({
      tenant_context: context, metric: "tool_calls", requested_quantity: 1,
    })).rejects.toMatchObject({
      code: "WORKSPACE_CONNECTION_STALE_REVISION",
      details: expect.objectContaining({ status: 409, retryable: false, fault_domain: "protocol" }),
    });
  });
});
