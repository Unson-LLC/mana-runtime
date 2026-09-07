import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackQueueEvent } from "../types.js";
import type { ExternalEffectReconciliationJob } from "../multitenancy/company-authority-external-effect-outbox.js";

const runtimeMocks = vi.hoisted(() => ({
  createClients: vi.fn(),
  createClientsInputs: [] as Array<Record<string, unknown>>,
  createCredentialFetch: vi.fn(),
  trustedForwarder: vi.fn(),
  executeBoundary: vi.fn(),
  executeTenantBoundary: vi.fn(),
  resolveSlackWorkerIngress: vi.fn(),
  executeContainer: vi.fn(),
  executeTenantRuntimeOperation: vi.fn(),
  postTenantSlackReply: vi.fn(),
  executeReplyRuntime: vi.fn(),
  readback: vi.fn(),
  readWorkspaceSession: vi.fn(),
  reconcilePermissionRevision: vi.fn(),
  persistEventOnce: vi.fn(),
  createAccountingClient: vi.fn(),
  createStateClient: vi.fn(),
  getWorkspace: vi.fn(),
  withDisposableResource: vi.fn(),
  brokerFetch: vi.fn(),
  hydrateGraphContext: vi.fn(),
  getSandbox: vi.fn(),
  mutateReplyEvent: false,
  preparedRequesters: [] as Array<Record<string, unknown>>,
  workspaceStub: {
    claimRuntimeEvent: vi.fn(),
    completeRuntimeEvent: vi.fn(),
    readRuntimeEventClaim: vi.fn(),
  },
  workspaceFs: {
    mkdir: vi.fn(),
    ls: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
  workspaceHandle: undefined as unknown,
  containerInputs: [] as Array<Record<string, unknown>>,
  credentialFetchInputs: [] as Array<Record<string, unknown>>,
  tenantBoundaryInputs: [] as Array<Record<string, unknown>>,
  replyInputs: [] as Array<Record<string, unknown>>,
  slackRequests: [] as Array<{ request: Request; body: Record<string, unknown> }>,
  readbackInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@cloudflare/computer", () => ({
  getWorkspace: runtimeMocks.getWorkspace,
  withWorkspace: (Base: abstract new (...args: never[]) => object) => Base,
}));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  getSandbox: runtimeMocks.getSandbox,
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
vi.mock("../multitenancy/company-authority-runtime-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/company-authority-runtime-adapter.js")>();
  return { ...actual, executeCompanyAuthorityRuntimeBoundary: runtimeMocks.executeBoundary };
});
vi.mock("../multitenancy/runtime-boundaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/runtime-boundaries.js")>();
  return {
    ...actual,
    executeTenantBoundary: runtimeMocks.executeTenantBoundary,
    resolveSlackWorkerIngress: runtimeMocks.resolveSlackWorkerIngress,
  };
});
vi.mock("../multitenancy/tenant-container-operation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/tenant-container-operation.js")>();
  return { ...actual, executeTenantContainerOperation: runtimeMocks.executeContainer };
});
vi.mock("../multitenancy/production-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/production-consumer.js")>();
  return {
    ...actual,
    executeTenantRuntimeOperation: runtimeMocks.executeTenantRuntimeOperation,
    postTenantSlackReply: runtimeMocks.postTenantSlackReply,
  };
});
vi.mock("../reply-runtime-execution.js", () => ({
  executeReplyRuntime: runtimeMocks.executeReplyRuntime,
}));
vi.mock("../brainbase-graph-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brainbase-graph-runtime.js")>();
  return {
    ...actual,
    hydrateGraphContext: runtimeMocks.hydrateGraphContext,
  };
});
vi.mock("../multitenancy/tenant-credential-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/tenant-credential-fetch.js")>();
  return { ...actual, createTenantCredentialFetch: runtimeMocks.createCredentialFetch };
});
vi.mock("../multitenancy/trusted-provider-forwarder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/trusted-provider-forwarder.js")>();
  return {
    ...actual,
    createBrainbaseTrustedProviderForwarderFromEnv: runtimeMocks.trustedForwarder,
  };
});
vi.mock("../multitenancy/slack-delivery-readback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/slack-delivery-readback.js")>();
  return { ...actual, readSlackDeliveryReadback: runtimeMocks.readback };
});
vi.mock("../multitenancy/tenant-runtime-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/tenant-runtime-state.js")>();
  return {
    ...actual,
    createDurableTenantAccountingClient: runtimeMocks.createAccountingClient,
    createDurableTenantStateClient: runtimeMocks.createStateClient,
  };
});
vi.mock("../workspace-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace-session.js")>();
  return {
    ...actual,
    readWorkspaceSession: runtimeMocks.readWorkspaceSession,
    reconcilePermissionRevision: runtimeMocks.reconcilePermissionRevision,
  };
});
vi.mock("../workspace-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace-store.js")>();
  return { ...actual, persistEventOnce: runtimeMocks.persistEventOnce };
});
vi.mock("../disposable-resource.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../disposable-resource.js")>();
  return { ...actual, withDisposableResource: runtimeMocks.withDisposableResource };
});

import {
  executeCompanyAuthorityReplyOperation,
  handleExternalEffectReconciliationQueueMessage,
} from "../index.js";
import { verifyTaskWriteCapability } from "@openryoko/write-broker";

type CompanyAuthorityReplyOperation = Parameters<typeof executeCompanyAuthorityReplyOperation>[1];
type RuntimeEnv = Parameters<typeof executeCompanyAuthorityReplyOperation>[0];

const tenantId = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const connectionId = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const deploymentId = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const workspaceId = "T_UNSON";
const appId = "A_UNSON";
const channelId = "C_ROUTER";
const userId = "U123";
const personId = "person-accepted";
const projectId = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const threadTs = "1786420000.000001";
const responseTs = "1786420000.000451";

const capabilities = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
].join(",");

const snapshot = {
  tenant_id: tenantId,
  connection_id: connectionId,
  connection_revision: "7",
  installation_id: "installation-unson",
  workspace_id: workspaceId,
  app_id: appId,
  installer_id: "U_INSTALLER",
  granted_scopes: ["chat:write"],
  status: "active" as const,
  deployment_id: deploymentId,
  profile: "shared_cloud" as const,
  credential_mode: "customer_oauth" as const,
  contract_revision: "11",
};

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId,
    eventId: "EvCompanyAuthorityReply",
    workspaceId,
    channelId,
    channelType: "channel",
    threadTs,
    messageTs: "1786420000.000450",
    userId,
    eventType: "message",
    text: "通常の返信を実行する",
    receivedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function tenantContext(projectIds: string[] = [projectId]) {
  return {
    schema_version: "1.0" as const,
    protocol_id: "mana-brainbase-tenant-context" as const,
    protocol_version: "1.0" as const,
    issuer: "brainbase" as const,
    audience: ["mana-runtime"],
    tenant: { tenant_id: tenantId, tenant_revision: "3" },
    workspace_connection: {
      connection_id: connectionId,
      connection_revision: "7",
      provider: "slack" as const,
      installation_id: snapshot.installation_id,
      workspace_id: workspaceId,
      app_id: appId,
      status: "active" as const,
    },
    actor: {
      principal_id: personId,
      principal_type: "person" as const,
      authenticated_subject_id: userId,
    },
    authorization: {
      organization_ids: ["organization-1"],
      project_ids: projectIds,
      data_scopes: ["tasks:tenant"],
      capability_ids: ["runtime.execute"],
    },
    placement: { deployment_id: deploymentId, profile: "shared_cloud" as const },
    slack: {
      event_id: "EvCompanyAuthorityReply",
      channel_id: channelId,
      thread_ts: threadTs,
      requester_id: userId,
    },
    correlation_id: "cor_company_authority_reply",
    operation_id: "op_company_authority_reply",
    idempotency_key: "idem_company_authority_reply",
    contract_revision: "11",
    credential: {
      mode: "customer_oauth" as const,
      credential_ref: "credential-ref-1",
      billing_principal_id: personId,
    },
    issued_at: "2026-09-05T00:00:00.000Z",
    expires_at: "2026-09-05T00:05:00.000Z",
    integrity: {
      method: "jws_detached" as const,
      algorithm: "EdDSA" as const,
      key_id: "tenant-key-1",
      value: "signed-tenant-context",
    },
  };
}

function reconciliationJob(): ExternalEffectReconciliationJob {
  const context = tenantContext();
  const runtimeEventId = "runtime-event-reconcile";
  const accountingArtifact = {
    partition_key: `${tenantId}/${connectionId}/usage`,
    usage_events: [{
      usage_event_id: "usage-reconcile",
      tenant_id: tenantId,
      connection_id: connectionId,
      connection_revision: context.workspace_connection.connection_revision,
      contract_revision: context.contract_revision,
      deployment_id: deploymentId,
      correlation_id: context.correlation_id,
      operation_id: context.operation_id,
      idempotency_key: context.idempotency_key,
    }],
    receipt: {
      receipt_id: "receipt-reconcile",
      tenant_id: tenantId,
      connection_id: connectionId,
      connection_revision: context.workspace_connection.connection_revision,
      contract_revision: context.contract_revision,
      deployment_id: deploymentId,
      correlation_id: context.correlation_id,
      operation_ids: [context.operation_id],
      idempotency_keys: [context.idempotency_key],
      actor_principal_id: context.actor.principal_id,
      project_id: projectId,
      reply: { state: "delivered" },
    },
  };
  return {
    schema_version: "1.0",
    tenant_id: tenantId,
    effect_id: context.idempotency_key,
    provider_key: "provider-key-reconcile",
    payload_hash: `sha256:${"a".repeat(64)}`,
    recovery: {
      runtime_event_id: runtimeEventId,
      runtime_claim_token: "runtime-claim-token-reconcile",
      operation_id: context.operation_id,
      correlation_id: context.correlation_id,
      accounting_context: context,
      accounting_artifact: accountingArtifact,
      delivery_identity: {
        provider: "slack",
        workspace_id: workspaceId,
        app_id: appId,
        channel_id: channelId,
        thread_ts: threadTs,
        event_id: context.slack.event_id,
        delivery_id: runtimeEventId,
        response_ts: responseTs,
        body_hash: `sha256:${"b".repeat(64)}`,
        bot_id: "B_UNSON",
        workspace_name: "runtime-workspace-reconcile",
      },
    },
    enqueued_at: "2026-09-05T00:00:01.000Z",
  } as unknown as ExternalEffectReconciliationJob;
}

function operation(options: {
  projectIds?: string[];
  canonicalPersonId?: string;
  payload?: Partial<SlackQueueEvent>;
} = {}): CompanyAuthorityReplyOperation {
  const payload = event(options.payload);
  const context = tenantContext(options.projectIds);
  const expectedScope = {
    audience: "mana-runtime",
    workspace_id: workspaceId,
    app_id: appId,
    channel_id: channelId,
    thread_ts: threadTs,
    actor_principal_id: personId,
    project_id: projectId,
    project_ids: [projectId],
    capability_id: "runtime.execute",
    deployment_id: deploymentId,
  };
  return {
    provider_key: "provider-key-1",
    tenant_context: context,
    expected_scope: expectedScope,
    company_authority_envelope: {
      schema_version: "1.0",
      correlation_id: context.correlation_id,
      company_authority_request: {
        correlation_id: context.correlation_id,
        provider_identity: {
          provider: "slack",
          authenticated_subject_id: userId,
          workspace_id: workspaceId,
          app_id: appId,
        },
        requested_action: {
          capability_id: "runtime.execute",
          resource_ref: `project:${projectId}`,
          project_hint: projectId,
          desired_effect: "external_side_effect",
        },
        delivery: { channel_id: channelId, thread_ts: threadTs, event_id: payload.eventId },
      },
      company_authority_response: {
        accepted: true,
        context: { actor: { canonical_person_id: personId } },
      },
      payload,
    },
    payload,
    canonical_person_id: Object.prototype.hasOwnProperty.call(options, "canonicalPersonId")
      ? options.canonicalPersonId
      : personId,
  } as CompanyAuthorityReplyOperation;
}

function runtimeEnv(overrides: Record<string, unknown> = {}): RuntimeEnv {
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => runtimeMocks.workspaceStub),
  };
  return {
    TENANT_ID: tenantId,
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    MANA_RUNTIME_CAPABILITIES: capabilities,
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    MANA_REQUIRED_CAPABILITY_ID: "runtime.execute",
    MANA_REQUIRED_SLACK_SCOPES: "chat:write",
    RUNTIME_CLAUDE_MODEL: "sonnet",
    RUNTIME_TASK_SEARCH_ENABLED: "false",
    RUNTIME_TASK_WRITE_ENABLED: "true",
    TASK_WRITE_CAPABILITY_SECRET: "company-authority-task-write-test-secret",
    BRAINBASE_WORKSPACE_CONNECTIONS_JSON: JSON.stringify([{
      ...snapshot,
      tenant_revision: "3",
    }]),
    RUNTIME_PLACEMENTS_JSON: JSON.stringify([{
      placementId: "tasks",
      channelId,
      projectCodes: [projectId],
      taskWriteEnabled: true,
      respondTo: { channel: "always", im: "never", mpim: "never", engagedThreads: false },
      agent: { model: "sonnet" },
    }]),
    BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://authority.example.com/",
    BRAINBASE_GRAPH_API_BASE_URL: "https://graph.example.com/",
    BRAINBASE_GRAPH_API_TOKEN: "graph-service-token",
    BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID: deploymentId,
    BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: JSON.stringify({
      kty: "OKP", crv: "Ed25519", x: "a".repeat(43),
    }),
    BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({ keys: [{
      kty: "OKP", crv: "Ed25519", x: "b".repeat(43), kid: "tenant-key-1",
    }] }),
    MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: JSON.stringify({
      "runtime.execute": "external_side_effect",
    }),
    TECHKNIGHT_WORKSPACE: namespace,
    TENANT_RUNTIME_STATE: namespace,
    ...overrides,
  } as unknown as RuntimeEnv;
}

async function brokerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const bodyText = await request.clone().text();
  const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
  runtimeMocks.slackRequests.push({ request, body });
  const path = new URL(request.url).pathname;
  if (path.endsWith("/auth.test")) {
    return Response.json({ ok: true, team_id: workspaceId, bot_id: "B_UNSON" });
  }
  if (path.endsWith("/chat.postMessage")) {
    return Response.json({ ok: true, ts: responseTs });
  }
  return Response.json({ ok: false, error: "unexpected_test_request" }, { status: 500 });
}

describe("Company Authority runtime.execute reply executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.createClientsInputs.length = 0;
    runtimeMocks.containerInputs.length = 0;
    runtimeMocks.credentialFetchInputs.length = 0;
    runtimeMocks.tenantBoundaryInputs.length = 0;
    runtimeMocks.replyInputs.length = 0;
    runtimeMocks.slackRequests.length = 0;
    runtimeMocks.readbackInputs.length = 0;
    runtimeMocks.mutateReplyEvent = false;
    runtimeMocks.hydrateGraphContext.mockResolvedValue({ status: "empty", content: "" });
    runtimeMocks.preparedRequesters.length = 0;
    runtimeMocks.workspaceHandle = { fs: runtimeMocks.workspaceFs };
    runtimeMocks.workspaceStub.claimRuntimeEvent.mockResolvedValue({
      disposition: "claimed", claimToken: "claim-token-1",
    });
    runtimeMocks.workspaceStub.completeRuntimeEvent.mockResolvedValue(undefined);
    runtimeMocks.workspaceStub.readRuntimeEventClaim.mockResolvedValue({
      status: "completed",
      claimToken: "claim-token-1",
      responseTs,
    });
    runtimeMocks.workspaceFs.readFile.mockResolvedValue(JSON.stringify({ generation: 1, engaged: true }));
    runtimeMocks.workspaceFs.ls.mockResolvedValue([]);
    runtimeMocks.readWorkspaceSession.mockResolvedValue({ generation: 1, engaged: true });
    runtimeMocks.getWorkspace.mockReturnValue(runtimeMocks.workspaceHandle);
    runtimeMocks.getSandbox.mockReturnValue({});
    runtimeMocks.withDisposableResource.mockImplementation(async (_acquire, use) =>
      use(runtimeMocks.workspaceHandle));
    runtimeMocks.createClients.mockImplementation((input: Record<string, unknown>) => {
      runtimeMocks.createClientsInputs.push(input);
      return {
        authority: { read_workspace_connection: vi.fn().mockResolvedValue(snapshot) },
        company_authority: {},
        credential_broker: {},
        quota: {},
        accounting: {},
        workspace_connections: {},
      };
    });
    runtimeMocks.createCredentialFetch.mockImplementation((input: Record<string, unknown>) => {
      runtimeMocks.credentialFetchInputs.push(input);
      return runtimeMocks.brokerFetch;
    });
    runtimeMocks.trustedForwarder.mockReturnValue({ forward: vi.fn() });
    runtimeMocks.brokerFetch.mockImplementation(brokerFetch);
    runtimeMocks.createAccountingClient.mockReturnValue({});
    runtimeMocks.createStateClient.mockReturnValue({});
    runtimeMocks.reconcilePermissionRevision.mockResolvedValue(undefined);
    runtimeMocks.persistEventOnce.mockResolvedValue({ created: true, path: "/events/event.json" });
    runtimeMocks.executeBoundary.mockImplementation(async (input: { execute_auto: () => Promise<unknown> }) => ({
      result: await input.execute_auto(),
    }));
    runtimeMocks.executeTenantBoundary.mockImplementation(async (input: {
      boundary: string;
      tenant_context: Record<string, unknown>;
      execute: () => Promise<unknown>;
    }) => {
      runtimeMocks.tenantBoundaryInputs.push(input);
      return input.execute();
    });
    runtimeMocks.executeContainer.mockImplementation(async (input: Record<string, unknown>) => {
      runtimeMocks.containerInputs.push(input);
      return (input.execute as (handle: string) => Promise<unknown>)("tenant-boundary-handle");
    });
    runtimeMocks.executeTenantRuntimeOperation.mockImplementation(async (input: {
      process: (decision: unknown) => Promise<unknown>;
    }) => input.process({ decision: "allowed" }));
    runtimeMocks.postTenantSlackReply.mockImplementation(async (input: {
      post: () => Promise<string>;
    }) => input.post());
    runtimeMocks.executeReplyRuntime.mockImplementation(async (input: Record<string, unknown>) => {
      runtimeMocks.replyInputs.push(input);
      const options = input.options as {
        postReply?: (replyEvent: SlackQueueEvent, text: string) => Promise<string>;
      };
      const prepareRequester = input.prepareRequester as
        ((input: { event: SlackQueueEvent; taskSearch: Record<string, unknown> }) => Promise<Record<string, unknown>>);
      const preparedRequester = await prepareRequester({ event: input.event as SlackQueueEvent, taskSearch: {} });
      if (preparedRequester) runtimeMocks.preparedRequesters.push(preparedRequester);
      const originalEvent = input.event as SlackQueueEvent;
      const replyEvent = runtimeMocks.mutateReplyEvent
        ? { ...originalEvent, channelId: "C_UNAUTHORIZED" }
        : originalEvent;
      const ts = await options.postReply?.(replyEvent, "返信本文");
      return { outcome: "replied", responseTs: ts };
    });
    runtimeMocks.readback.mockImplementation(async (input: Record<string, unknown>) => {
      runtimeMocks.readbackInputs.push(input);
      return {
        state: "confirmed",
        receipt: { channel: channelId, ts: responseTs, body_hash: input.bodyHash },
      };
    });
  });

  it.each([
    ["canonical person is missing", operation({ canonicalPersonId: undefined })],
    ["multiple projects are present", operation({ projectIds: [projectId, "project-2"] })],
    ["a control command is received", operation({ payload: { text: "/status" } })],
  ])("rejects %s before broker or Slack delivery", async (_label, candidate) => {
    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), candidate)).rejects.toMatchObject({
      code: "AUTHORITY_SCOPE_MISMATCH",
    });
    expect(runtimeMocks.createCredentialFetch).not.toHaveBeenCalled();
    expect(runtimeMocks.executeContainer).not.toHaveBeenCalled();
    expect(runtimeMocks.executeReplyRuntime).not.toHaveBeenCalled();
    expect(runtimeMocks.slackRequests).toHaveLength(0);
  });

  it("rejects placement policy belonging to a different canonical project before credentials", async () => {
    const env = runtimeEnv();
    const placements = JSON.parse(env.RUNTIME_PLACEMENTS_JSON!);
    placements[0].projectCodes = ["other-project"];
    env.RUNTIME_PLACEMENTS_JSON = JSON.stringify(placements);
    await expect(executeCompanyAuthorityReplyOperation(env, operation())).rejects.toMatchObject({
      code: "AUTHORITY_SCOPE_MISMATCH",
    });
    expect(runtimeMocks.createCredentialFetch).not.toHaveBeenCalled();
    expect(runtimeMocks.executeContainer).not.toHaveBeenCalled();
  });

  it("uses the accepted canonical person, sends through the broker, and confirms the same Slack ts", async () => {
    const candidate = operation();

    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), candidate)).resolves.toEqual({
      applied: true,
      response_observed: true,
      result_ref: `slack:${channelId}:${responseTs}`,
    });

    expect(runtimeMocks.containerInputs).toHaveLength(1);
    expect(runtimeMocks.containerInputs[0]).toMatchObject({ release: "on_expiration" });
    expect(runtimeMocks.containerInputs[0]?.company_authority_envelope)
      .toEqual(candidate.company_authority_envelope);
    expect(runtimeMocks.replyInputs).toHaveLength(1);
    expect(runtimeMocks.preparedRequesters).toHaveLength(1);
    expect(runtimeMocks.preparedRequesters[0]?.requesterIdentity).toEqual({
      slackUserId: userId,
      personId,
    });
    expect(runtimeMocks.preparedRequesters[0]).toMatchObject({
      taskWriteEnabled: true,
      taskWriteCapability: expect.any(String),
    });
    expect(runtimeMocks.replyInputs[0]?.options).toMatchObject({
      brainbaseProjectCode: projectId,
      capabilities: { mcp: [], gatewayTools: [] },
      resolveActorIdentity: undefined,
    });
    const replyOptions = runtimeMocks.replyInputs[0]?.options as {
      createSandbox(id: string): unknown;
    };
    replyOptions.createSandbox("reply-sandbox-id");
    expect(runtimeMocks.getSandbox).toHaveBeenCalledWith(
      undefined,
      "reply-sandbox-id",
      { enableDefaultSession: false, sleepAfter: "5m" },
    );
    expect(runtimeMocks.createCredentialFetch).toHaveBeenCalledOnce();
    expect(runtimeMocks.postTenantSlackReply).toHaveBeenCalledOnce();
    expect(runtimeMocks.postTenantSlackReply.mock.calls[0]?.[0]).toMatchObject({
      effect_id: "provider-key-1",
      release_on_failure: false,
    });
    const slackPosts = runtimeMocks.slackRequests.filter(({ request }) =>
      request.url.endsWith("/chat.postMessage"));
    expect(slackPosts).toHaveLength(1);
    const slackPost = slackPosts[0]!;
    expect(slackPost.request.method).toBe("POST");
    expect(slackPost.request.url).toBe("https://slack.com/api/chat.postMessage");
    expect(slackPost.body).toMatchObject({
      channel: channelId,
      thread_ts: threadTs,
      metadata: {
        event_type: "mana_external_effect",
        event_payload: { provider_key: "provider-key-1" },
      },
    });
    expect(runtimeMocks.readbackInputs).toHaveLength(1);
    expect(runtimeMocks.readbackInputs[0]?.observed).toEqual({ channel: channelId, ts: responseTs });
    expect(runtimeMocks.readbackInputs[0]?.bodyHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    expect(runtimeMocks.workspaceStub.completeRuntimeEvent).toHaveBeenCalledOnce();
  });

  it("uses the refreshed tenant context for broker, Slack delivery, and readback", async () => {
    const candidate = operation();
    const refreshedExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const refreshedContext = structuredClone(candidate.tenant_context);
    refreshedContext.expires_at = refreshedExpiresAt;
    refreshedContext.integrity.value = "fresh-signed-tenant-context";
    runtimeMocks.resolveSlackWorkerIngress.mockResolvedValue({
      tenant_context: refreshedContext,
      authoritative_snapshot: snapshot,
    });
    runtimeMocks.executeContainer.mockImplementationOnce(async (input: Record<string, unknown>) => {
      runtimeMocks.containerInputs.push(input);
      await (input.refresh as { issue(): Promise<unknown> }).issue();
      return (input.execute as (handle: string) => Promise<unknown>)("tenant-boundary-handle");
    });

    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), candidate)).resolves.toEqual({
      applied: true,
      response_observed: true,
      result_ref: `slack:${channelId}:${responseTs}`,
    });

    expect(runtimeMocks.createCredentialFetch).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createClientsInputs.map((input) => input.tenant_context)).toEqual([
      candidate.tenant_context,
      undefined,
      refreshedContext,
    ]);
    expect(runtimeMocks.credentialFetchInputs.map((input) => input.envelope)).toEqual([
      candidate.tenant_context,
      refreshedContext,
    ]);
    expect(runtimeMocks.tenantBoundaryInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "brainbase_proxy", tenant_context: refreshedContext }),
      expect.objectContaining({ boundary: "slack_delivery", tenant_context: refreshedContext }),
    ]));
    expect(runtimeMocks.postTenantSlackReply.mock.calls[0]?.[0]).toMatchObject({
      tenant_context: refreshedContext,
    });
    expect(runtimeMocks.readbackInputs[0]?.expiresAt).toBeGreaterThan(
      Date.parse(candidate.tenant_context.expires_at),
    );
    expect(runtimeMocks.readbackInputs[0]?.expiresAt).toBeLessThanOrEqual(
      Date.parse(refreshedContext.expires_at),
    );
  });

  it("keeps the Task API project code in the write capability when authority uses a canonical ID", async () => {
    const env = runtimeEnv();
    const placements = JSON.parse(env.RUNTIME_PLACEMENTS_JSON!);
    placements[0].projectCodes = ["mana"];
    env.RUNTIME_PLACEMENTS_JSON = JSON.stringify(placements);
    env.RUNTIME_AUTHORITY_PROJECT_IDS_JSON = JSON.stringify({ tasks: [projectId] });

    await executeCompanyAuthorityReplyOperation(env, operation());

    const token = runtimeMocks.preparedRequesters[0]?.taskWriteCapability as string;
    const claims = await verifyTaskWriteCapability(token, env.TASK_WRITE_CAPABILITY_SECRET!, {
      requestId: "EvCompanyAuthorityReply",
      workspace: workspaceId,
      placementId: "tasks",
    });
    expect(claims.projects).toEqual(["mana"]);
    expect(runtimeMocks.replyInputs[0]?.options).toMatchObject({
      brainbaseProjectCode: "mana",
    });
    expect(runtimeMocks.replyInputs[0]?.taskSearch).toMatchObject({
      projectCodes: "mana",
    });
    expect(runtimeMocks.hydrateGraphContext).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "EvCompanyAuthorityReply" }),
      "mana",
      {
        baseUrl: "https://graph.example.com/",
        token: "graph-service-token",
      },
    );
  });

  it("keeps an unknown readback unresolved and does not resend an existing claim", async () => {
    runtimeMocks.readback.mockResolvedValue({
      state: "unknown",
      reason: "not_found",
      receipt: { channel: channelId, ts: responseTs, body_hash: "sha256:" + "0".repeat(64) },
    });
    const candidate = operation();

    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), candidate)).rejects.toThrow(
      "SLACK_READBACK_not_found",
    );
    expect(runtimeMocks.slackRequests.filter(({ request }) =>
      request.url.endsWith("/chat.postMessage"))).toHaveLength(1);
    expect(runtimeMocks.postTenantSlackReply).toHaveBeenCalledOnce();
    expect(runtimeMocks.postTenantSlackReply.mock.calls[0]?.[0]).toMatchObject({ release_on_failure: false });

    runtimeMocks.workspaceStub.claimRuntimeEvent.mockResolvedValue({
      disposition: "completed", responseTs,
    });
    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), candidate)).resolves.toEqual({
      applied: true,
      response_observed: false,
    });
    expect(runtimeMocks.slackRequests.filter(({ request }) =>
      request.url.endsWith("/chat.postMessage"))).toHaveLength(1);
    expect(runtimeMocks.executeReplyRuntime).toHaveBeenCalledOnce();
  });

  it("rejects a reply callback whose signed delivery target changes before POST", async () => {
    runtimeMocks.mutateReplyEvent = true;

    await expect(executeCompanyAuthorityReplyOperation(runtimeEnv(), operation())).rejects.toMatchObject({
      code: "AUTHORITY_SCOPE_MISMATCH",
    });
    expect(runtimeMocks.slackRequests.filter(({ request }) =>
      request.url.endsWith("/chat.postMessage"))).toHaveLength(0);
    expect(runtimeMocks.postTenantSlackReply).not.toHaveBeenCalled();
  });

  it("does not ACK the reconciliation queue message before settlement completes", async () => {
    const message = { body: reconciliationJob(), ack: vi.fn(), retry: vi.fn() };
    const started = vi.fn();
    let release: (() => void) | undefined;
    const processing = handleExternalEffectReconciliationQueueMessage(
      message,
      runtimeEnv(),
      async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return "succeeded";
      },
    );

    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    if (!release) throw new Error("reconciliation_settlement_not_started");
    release();
    await expect(processing).resolves.toBe(true);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries unknown or transient reconciliation outcomes without ACK", async () => {
    const message = { body: reconciliationJob(), ack: vi.fn(), retry: vi.fn() };
    const readbackOnly = vi.fn(async () => "retry" as const);

    await expect(handleExternalEffectReconciliationQueueMessage(
      message,
      runtimeEnv(),
      readbackOnly,
    )).resolves.toBe(true);

    expect(readbackOnly).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("retries malformed reconciliation candidates instead of dropping them", async () => {
    const message = {
      body: { effect_id: "effect-reconcile", provider_key: "provider-reconcile", payload_hash: "payload" },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await expect(handleExternalEffectReconciliationQueueMessage(message, runtimeEnv())).resolves.toBe(true);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });
});
