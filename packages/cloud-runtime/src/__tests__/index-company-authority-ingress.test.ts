import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TenantContextIssueRequest,
} from "../multitenancy/runtime-boundaries.js";
import type {
  TenantContextEnvelope,
  UnsignedTenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { signTenantContextEnvelope, validateTenantBoundary } from "../multitenancy/envelope.js";
import { createIdempotencyKey } from "../multitenancy/idempotency.js";
import type { TenantQueueBody } from "../multitenancy/runtime-boundaries.js";
import type { MeetingMinutesSelection } from "../meeting-minutes-contracts.js";

const runtimeMocks = vi.hoisted(() => ({
  createClients: vi.fn(),
  companyAuthority: { resolve: vi.fn() },
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

import worker, { resolveTaskBoardRepairTenantContext } from "../index.js";

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

const meetingMinutesDestination = {
  id: "mana",
  projectId: "p1",
  contextProjectCode: "back-office",
  taskProjectCodes: ["back-office"],
  taskBoardTargetId: "minutes-back-office",
  name: "Back Office",
  organization: { id: "unson-business", name: "雲孫 事業運営" },
  slackChannelId: "C2",
  github: { owner: "Unson-LLC", repo: "back_office" },
};

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

function signedSelectionRequest(): Request {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const body = new URLSearchParams({ payload: JSON.stringify({
    api_app_id: "A_UNSON",
    team: { id: "T_UNSON" },
    user: { id: "U123" },
    channel: { id: "CROUTER" },
    message: { ts: "1786420000.000450", thread_ts: "1786420000.000451" },
    actions: [{
      action_id: "mana_meeting_minutes_choose_destination:mana",
      action_ts: "1786420000.000452",
      value: JSON.stringify({ runId: "Ev1_F1", destinationId: "mana", fileName: "meeting.txt" }),
    }],
  }) }).toString();
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${nowSeconds}:${body}`)
    .digest("hex")}`;
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature,
    },
    body,
  });
}

function meetingMinutesBindings(overrides: Record<string, unknown> = {}) {
  return env({
    SLACK_ALLOWED_CHANNEL_ID: "CROUTER",
    MEETING_MINUTES_ENABLED: "true",
    MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
    MEETING_MINUTES_OPERATOR_USER_IDS: "U123",
    MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([meetingMinutesDestination]),
    ...overrides,
  });
}

function selectionTenantContext(selection: MeetingMinutesSelection): TenantContextEnvelope {
  return {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: tenantId, tenant_revision: "3" },
    workspace_connection: {
      connection_id: connectionId,
      connection_revision: "7",
      provider: "slack",
      installation_id: "installation-unson",
      workspace_id: selection.workspaceId,
      app_id: selection.appId,
      status: "active",
    },
    actor: {
      principal_id: "person-1",
      principal_type: "person",
      authenticated_subject_id: selection.userId,
    },
    authorization: {
      organization_ids: ["organization-1"],
      project_ids: ["prj_backoffice"],
      data_scopes: ["tasks:tenant"],
      capability_ids: ["task.write"],
    },
    placement: { deployment_id: deploymentId, profile: "shared_cloud" },
    slack: {
      event_id: `meeting_minutes_selection:${selection.runId}:${selection.actionTs}`,
      channel_id: selection.channelId,
      thread_ts: selection.threadTs,
      requester_id: selection.userId,
    },
    correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    idempotency_key: "idem_01ARZ3NDEKTSV4RRFFQ69G5FB0",
    contract_revision: "11",
    credential: {
      mode: "customer_oauth",
      credential_ref: "credential-ref-1",
      billing_principal_id: "person-1",
    },
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "tenant-key-1", value: "signature" },
  };
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
    runtimeMocks.companyAuthority.resolve.mockResolvedValue({ state: "not_collected" });
    runtimeMocks.createClients.mockReturnValue({
      authority: runtimeMocks.legacyAuthority,
      company_authority: runtimeMocks.companyAuthority,
    });
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
    expect(runtimeMocks.companyAuthority.resolve).toHaveBeenCalledOnce();
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

  it.each([
    { reason: "task_write" as const, capabilityId: "runtime.execute", expectedCapabilityId: "runtime.execute" },
    { reason: "manual" as const, capabilityId: undefined, expectedCapabilityId: "task_board_send" },
  ])("round-trips destination repair authorization for $reason", async ({
    reason,
    capabilityId,
    expectedCapabilityId,
  }) => {
    const bindings = env({
      ...(await legacyAuthorityBindings()),
      MANA_REQUIRED_CAPABILITY_ID: "runtime.execute",
      MANA_TASK_BOARD_SERVICE_ACTOR_ID: "service-task-board",
      MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON: JSON.stringify({ "back-office": "prj_backoffice" }),
    });
    const requestedAt = new Date().toISOString();
    const repair = {
      eventType: "task_board_repair" as const,
      tenantId,
      workspaceId: "T_UNSON",
      channelId: "C2",
      targetId: "minutes-back-office",
      manaCanvasId: null,
      bindingRevision: 1,
      reason,
      requestedAt,
    };

    const tenantContext = await resolveTaskBoardRepairTenantContext(bindings as never, repair, {
      appId: "A_UNSON",
      destination: meetingMinutesDestination,
      ...(capabilityId ? { capabilityId } : {}),
    });

    expect(runtimeMocks.legacyAuthority.issue_tenant_context).toHaveBeenLastCalledWith(
      expect.objectContaining({
        required_authorization: {
          audience: "mana-runtime",
          project_id: "prj_backoffice",
          capability_id: expectedCapabilityId,
        },
      }),
    );
    expect(tenantContext.authorization.capability_ids).toContain(expectedCapabilityId);
    await validateTenantBoundary({
      boundary: "queue_consumer",
      envelope: tenantContext,
      authoritative_snapshot: snapshot,
      expected_scope: {
        audience: "mana-runtime",
        workspace_id: "T_UNSON",
        app_id: "A_UNSON",
        channel_id: "C2",
        thread_ts: requestedAt,
        actor_principal_id: tenantContext.actor.principal_id,
        project_id: "prj_backoffice",
        capability_id: expectedCapabilityId,
        deployment_id: deploymentId,
      },
      now: requestedAt,
      resolve_verification_key: async (keyId) => {
        const jwks = JSON.parse(String((bindings as Record<string, unknown>).BRAINBASE_TENANT_CONTEXT_JWKS_JSON)) as {
          keys: JsonWebKey[];
        };
        const jwk = jwks.keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === keyId);
        return jwk ? crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]) : undefined;
      },
    });
  });

  it.each([200, 302, 503])("uses the private HTTP client and rejects an untrusted response (HTTP %s)", async (status) => {
    const actual = await vi.importActual<typeof import("../multitenancy/http-clients.js")>(
      "../multitenancy/http-clients.js",
    );
    runtimeMocks.createClients.mockImplementation(actual.createTenantRuntimeHttpClients);
    const fetch = vi.fn(async () => Response.json({ untrusted: true }, { status }));
    const bindings = env({
      BRAINBASE_TENANT_RUNTIME_SERVICE: { fetch },
      BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://authority.example.com",
      BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID: deploymentId,
      BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: JSON.stringify({
        kty: "OKP", crv: "Ed25519", x: "a".repeat(43),
      }),
      BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({ keys: [{
        kty: "OKP", crv: "Ed25519", x: "b".repeat(43), kid: "tenant-key-1",
      }] }),
      MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: JSON.stringify({ "task.write": "write" }),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await fetchWorker(signedEventRequest(), bindings);
      expect(response.ok).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        "https://brainbase.internal/api/v1/runtime/company-authority:resolve",
        expect.objectContaining({ method: "POST", redirect: "manual" }),
      );
      expect(bindings.TECHKNIGHT_EVENTS.send).not.toHaveBeenCalled();
      expect(runtimeMocks.legacyAuthority.issue_tenant_context).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
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

  it("fails closed during initial destination-scoped interaction resolution when the authority project is unmapped", async () => {
    const bindings = meetingMinutesBindings();
    const waitUntil = vi.fn();
    const response = await worker.fetch(signedSelectionRequest(), bindings as never, { waitUntil } as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "administrator_action_required" });
    expect(runtimeMocks.legacyAuthority.resolve_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.issue_tenant_context).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.read_workspace_connection).not.toHaveBeenCalled();
    expect(bindings.TECHKNIGHT_EVENTS.send).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("fails closed before Queue consumption when the destination authority project is unmapped", async () => {
    const selection: MeetingMinutesSelection = {
      kind: "meeting_minutes_selection",
      runId: "Ev1_F1",
      destinationId: "mana",
      workspaceId: "T_UNSON",
      appId: "A_UNSON",
      channelId: "CROUTER",
      threadTs: "1786420000.000451",
      userId: "U123",
      actionTs: "1786420000.000452",
    };
    const body: TenantQueueBody<MeetingMinutesSelection> = {
      schema_version: "1.0",
      tenant_context: selectionTenantContext(selection),
      payload: selection,
    };
    const bindings = meetingMinutesBindings({ MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON: "{}" });
    const ack = vi.fn();
    const retry = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await worker.queue({
        queue: "unson-mana-runtime-events",
        messages: [{ body, ack, retry }],
      } as never, bindings as never);
    } finally {
      errorLog.mockRestore();
    }

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.resolve_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.read_workspace_connection).not.toHaveBeenCalled();
    expect(runtimeMocks.legacyAuthority.issue_tenant_context).not.toHaveBeenCalled();
    expect(bindings.TECHKNIGHT_EVENTS.send).not.toHaveBeenCalled();
  });
});
