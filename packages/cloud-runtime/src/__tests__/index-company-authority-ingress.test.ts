import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TenantContextIssueRequest,
} from "../multitenancy/runtime-boundaries.js";
import type {
  UnsignedTenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { signTenantContextEnvelope } from "../multitenancy/envelope.js";
import { createIdempotencyKey } from "../multitenancy/idempotency.js";

const runtimeMocks = vi.hoisted(() => ({
  createClients: vi.fn(),
  legacyAuthority: {
    resolve_workspace_connection: vi.fn(),
    read_workspace_connection: vi.fn(),
    issue_tenant_context: vi.fn(),
  },
}));

vi.mock("@cloudflare/computer", () => ({
  getWorkspace: vi.fn(),
  withWorkspace: (Base: abstract new (...args: never[]) => object) => Base,
}));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  getSandbox: vi.fn(),
}));
vi.mock("../multitenancy/cloudflare-worker-runtime.js", () => ({ DurableObject: class {} }));
vi.mock("../runtime-session-registry.js", () => ({
  RuntimeSessionRegistry: class {},
  upsertRuntimeSession: vi.fn(),
}));
vi.mock("../meeting-minutes-deployment-gate.js", () => ({
  MeetingMinutesDeploymentGate: class {},
}));
vi.mock("../multitenancy/http-clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/http-clients.js")>();
  return { ...actual, createTenantRuntimeHttpClients: runtimeMocks.createClients };
});

import worker from "../index.js";

const signingSecret = "test-signing-secret";
const tenantId = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const connectionId = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const deploymentId = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const capabilities = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
].join(",");

function env(overrides: Record<string, unknown> = {}) {
  return {
    SLACK_SIGNING_SECRET: signingSecret,
    SLACK_EXPECTED_APP_ID: "A_UNSON",
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    TENANT_ID: tenantId,
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    MANA_RUNTIME_CAPABILITIES: capabilities,
    MANA_REQUIRED_SLACK_SCOPES: "task:write",
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    MANA_REQUIRED_CAPABILITY_ID: "task.write",
    BRAINBASE_WORKSPACE_CONNECTIONS_JSON: JSON.stringify([{
      tenant_id: tenantId,
      tenant_revision: "3",
      connection_id: connectionId,
      connection_revision: "7",
      installation_id: "installation-unson",
      workspace_id: "T_UNSON",
      app_id: "A_UNSON",
      installer_id: "U_INSTALLER",
      granted_scopes: ["task:write"],
      status: "active",
      deployment_id: deploymentId,
      profile: "shared_cloud",
      credential_mode: "customer_oauth",
      contract_revision: "11",
    }]),
    RUNTIME_PLACEMENTS_JSON: JSON.stringify([{
      placementId: "tasks",
      channelId: "C_ROUTER",
      projectCodes: ["back-office"],
      taskWriteEnabled: true,
    }]),
    TECHKNIGHT_EVENTS: { send: vi.fn() },
    ...overrides,
  };
}

function signedEventRequest(): Request {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const body = JSON.stringify({
    type: "event_callback",
    api_app_id: "A_UNSON",
    team_id: "T_UNSON",
    event_id: "EvWorkerIngress",
    event: {
      type: "message",
      channel: "C_ROUTER",
      ts: "1786420000.000450",
      user: "U123",
      text: "create task",
    },
  });
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${nowSeconds}:${body}`)
    .digest("hex")}`;
  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature,
    },
    body,
  });
}

const snapshot: WorkspaceConnectionSnapshot = {
  tenant_id: tenantId,
  connection_id: connectionId,
  connection_revision: "7",
  installation_id: "installation-unson",
  workspace_id: "T_UNSON",
  app_id: "A_UNSON",
  installer_id: "U_INSTALLER",
  granted_scopes: ["task:write"],
  status: "active",
  deployment_id: deploymentId,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "11",
};

async function legacyAuthorityBindings() {
  const keyId = "tenant-key-1";
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  runtimeMocks.legacyAuthority.resolve_workspace_connection.mockResolvedValue(snapshot);
  runtimeMocks.legacyAuthority.read_workspace_connection.mockResolvedValue(snapshot);
  runtimeMocks.legacyAuthority.issue_tenant_context.mockImplementation(async (request: TenantContextIssueRequest) => {
    const now = Date.now();
    const operationId = "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const idempotencyKey = await createIdempotencyKey({
      protocol_id: "mana-brainbase-tenant-context",
      protocol_major: "1",
      tenant_id: tenantId,
      connection_id: connectionId,
      slack_event_id: request.slack.event_id,
      operation_id: operationId,
    });
    const unsigned: UnsignedTenantContextEnvelope = {
      schema_version: "1.0",
      protocol_id: "mana-brainbase-tenant-context",
      protocol_version: "1.0",
      issuer: "brainbase",
      audience: [request.required_authorization.audience],
      tenant: { tenant_id: tenantId, tenant_revision: "3" },
      workspace_connection: {
        connection_id: connectionId,
        connection_revision: "7",
        provider: "slack",
        installation_id: snapshot.installation_id,
        workspace_id: snapshot.workspace_id,
        app_id: snapshot.app_id,
        status: "active",
      },
      actor: {
        principal_id: "person-1",
        principal_type: "person",
        authenticated_subject_id: request.slack.requester_id,
      },
      authorization: {
        organization_ids: ["organization-1"],
        project_ids: [request.required_authorization.project_id],
        data_scopes: ["tasks:tenant"],
        capability_ids: [request.required_authorization.capability_id],
      },
      placement: { deployment_id: deploymentId, profile: "shared_cloud" },
      slack: { ...request.slack },
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      operation_id: operationId,
      idempotency_key: idempotencyKey,
      contract_revision: "11",
      credential: {
        mode: "customer_oauth",
        credential_ref: "credential-ref-1",
        billing_principal_id: "person-1",
      },
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 300_000).toISOString(),
    };
    return signTenantContextEnvelope(unsigned, keyPair.privateKey, keyId);
  });
  return {
    BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({ keys: [{ ...publicJwk, kid: keyId }] }),
  };
}

async function fetchWorker(request: Request, bindings: Record<string, unknown>): Promise<Response> {
  return worker.fetch(request, bindings as never, {} as never);
}

describe("default Worker Company Authority ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.createClients.mockReturnValue({ authority: runtimeMocks.legacyAuthority });
  });

  it("fails closed through Company Authority before either Queue or legacy authority", async () => {
    const bindings = env({
      BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://authority.example.com",
      BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID: deploymentId,
      BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: JSON.stringify({
        kty: "OKP", crv: "Ed25519", x: "a".repeat(43),
      }),
      BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({ keys: [{
        kty: "OKP", crv: "Ed25519", x: "b".repeat(43), kid: "tenant-key-1",
      }] }),
      MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: JSON.stringify({
        "task.write": "write",
      }),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await fetchWorker(signedEventRequest(), bindings);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTHORITY_UNAVAILABLE",
      stage: "tenant_context_resolution",
    });
    expect(runtimeMocks.legacyAuthority.resolve_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.read_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.issue_tenant_context).not.toHaveBeenCalled();
    expect(bindings.TECHKNIGHT_EVENTS.send).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("keeps disabled configuration on the successful legacy authority and Queue path", async () => {
    const bindings = env(await legacyAuthorityBindings());

    const response = await fetchWorker(signedEventRequest(), bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(runtimeMocks.legacyAuthority.resolve_workspace_connection).toHaveBeenCalledOnce();
    expect(runtimeMocks.legacyAuthority.issue_tenant_context).toHaveBeenCalledOnce();
    expect(runtimeMocks.legacyAuthority.read_workspace_connection).toHaveBeenCalledOnce();
    expect(bindings.TECHKNIGHT_EVENTS.send).toHaveBeenCalledOnce();
    expect(bindings.TECHKNIGHT_EVENTS.send).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: "1.0",
      payload: expect.objectContaining({ tenantId }),
    }));
  });

  it("rejects partial configuration before authority retrieval or Queue effects", async () => {
    const bindings = env({
      BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://authority.example.com",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await fetchWorker(signedEventRequest(), bindings);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "CONFIGURATION_INVALID",
      stage: "runtime_configuration",
    });
    expect(runtimeMocks.legacyAuthority.resolve_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.read_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.issue_tenant_context).not.toHaveBeenCalled();
    expect(bindings.TECHKNIGHT_EVENTS.send).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
