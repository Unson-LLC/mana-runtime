import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingMinutesDestination,
  MeetingMinutesRecoveryAuthorization,
  MeetingMinutesRun,
} from "../meeting-minutes-contracts.js";

const runtimeMocks = vi.hoisted(() => ({
  createClients: vi.fn(),
  getWorkspace: vi.fn(),
  withDisposableResource: vi.fn(),
  loadRun: vi.fn(),
  saveRun: vi.fn(),
  runProbe: vi.fn(),
  resolveSlackWorkerIngress: vi.fn(),
  executeTenantBoundary: vi.fn(),
  executeTenantRuntimeOperation: vi.fn(),
}));

vi.mock("@cloudflare/computer", () => ({
  getWorkspace: runtimeMocks.getWorkspace,
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
vi.mock("../multitenancy/runtime-boundaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/runtime-boundaries.js")>();
  return { ...actual, resolveSlackWorkerIngress: runtimeMocks.resolveSlackWorkerIngress,
    executeTenantBoundary: runtimeMocks.executeTenantBoundary };
});
vi.mock("../multitenancy/production-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/production-consumer.js")>();
  return { ...actual, executeTenantRuntimeOperation: runtimeMocks.executeTenantRuntimeOperation };
});
vi.mock("../meeting-minutes-generation-probe.js", () => ({
  runMeetingMinutesGenerationProbe: runtimeMocks.runProbe,
}));
vi.mock("../meeting-minutes-state.js", () => ({
  loadMeetingMinutesRun: runtimeMocks.loadRun,
  saveMeetingMinutesRun: runtimeMocks.saveRun,
}));
vi.mock("../disposable-resource.js", () => ({
  withDisposableResource: runtimeMocks.withDisposableResource,
}));

import worker from "../index.js";
import { buildMeetingMinutesRunReceipt } from "../meeting-minutes-run-receipt.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";

const ADMIN_TOKEN = "admin-probe-token";
const RUN_ID = "run-001";
const TENANT_ID = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKSPACE_ID = "T01";
const APP_ID = "A01";
const CHANNEL_ID = "C01";
const THREAD_TS = "100.200";
const PROBE_ID = "00000000-0000-4000-8000-000000000001";

const destination: MeetingMinutesDestination = {
  id: "mana",
  projectId: "prj_123ABC",
  contextProjectCode: "back-office",
  taskProjectCodes: ["back-office"],
  taskBoardTargetId: "minutes-board",
  name: "Back Office",
  organization: { id: "org-1", name: "Unson" },
  slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "back-office" },
};

const recoveryAuthorization: MeetingMinutesRecoveryAuthorization = {
  tenantId: TENANT_ID,
  tenantRevision: "1",
  connectionId: "connection-1",
  connectionRevision: "1",
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  channelId: CHANNEL_ID,
  threadTs: THREAD_TS,
  requesterId: "U01",
  actorPrincipalId: "person-1",
  projectIds: [destination.projectId],
  audience: "mana-runtime",
  capabilityId: "task.write",
  deploymentId: "deployment-1",
  profile: "shared_cloud",
};

function run(overrides: Partial<MeetingMinutesRun> = {}): MeetingMinutesRun {
  return {
    version: 1,
    runId: RUN_ID,
    eventId: "event-001",
    workspaceId: WORKSPACE_ID,
    sourceAppId: APP_ID,
    sourceChannelId: CHANNEL_ID,
    sourceThreadTs: THREAD_TS,
    sourceMessageTs: THREAD_TS,
    file: { id: "file-001", name: "meeting.txt" },
    status: "failed",
    destination,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    recoveryAuthorization,
    ...overrides,
  };
}

async function retryableReceiptRun(overrides: Partial<MeetingMinutesRun> = {}): Promise<MeetingMinutesRun> {
  const completed = run({
    status: "completed",
    github: { transcriptPath: "meeting.txt", minutesPath: "minutes.md",
      transcriptUrl: "https://example.com/meeting.txt", minutesUrl: "https://example.com/minutes.md" },
    taskRegistration: { registered: [] },
    statusProjection: { outcome: "completed", projectedAt: "2026-09-06T00:00:01.000Z" },
    terminalSlackReadback: { outcome: "completed", channel: CHANNEL_ID, ts: THREAD_TS,
      bodyHash: "sha256:abc", confirmedAt: "2026-09-06T00:00:01.000Z" },
    revision: 1,
    ...overrides,
  });
  const receipt = await buildMeetingMinutesRunReceipt(completed);
  if (!receipt) throw new Error("test fixture must build a receipt");
  return { ...completed, runReceipt: { idempotencyKey: receipt.delivery.idempotency_key, status: "pending" } };
}

function reauthorizedTenantContext(eventId: string) {
  return {
    protocol_version: "1.0", contract_revision: "1", correlation_id: "correlation-1", operation_id: "operation-1",
    idempotency_key: "idempotency-1", expires_at: "2026-09-06T01:00:00.000Z",
    tenant: { tenant_id: TENANT_ID },
    workspace_connection: { connection_id: "connection-1", connection_revision: "1",
      workspace_id: WORKSPACE_ID, app_id: APP_ID },
    actor: { authenticated_subject_id: "U01", principal_id: "person-1" },
    slack: { event_id: eventId, channel_id: CHANNEL_ID, thread_ts: THREAD_TS, requester_id: "U01" },
    audience: ["mana-runtime"], authorization: { capability_ids: ["task.write"], project_ids: [destination.projectId] },
    placement: { deployment_id: "deployment-1", profile: "shared_cloud" }, credential: { mode: "tenant_bound" },
  };
}

function bindings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workspaceNamespace = {
    idFromName: vi.fn().mockReturnValue("meeting-minutes-workspace"),
    get: vi.fn().mockReturnValue({}),
  };
  const gate = {
    isIntakePaused: vi.fn().mockResolvedValue(false),
    markActive: vi.fn().mockResolvedValue(undefined),
    markTerminal: vi.fn().mockResolvedValue(undefined),
  };
  const gateNamespace = {
    idFromName: vi.fn().mockReturnValue("meeting-minutes-gate"),
    get: vi.fn().mockReturnValue(gate),
  };
  const tenantStateNamespace = {
    idFromName: vi.fn().mockReturnValue("tenant-runtime-state"),
    get: vi.fn().mockReturnValue({}),
  };
  const tenantRuntimeService = {
    fetch: vi.fn(),
  };
  return {
    SANDBOX_PROBE_TOKEN: ADMIN_TOKEN,
    TENANT_ID,
    MEETING_MINUTES_ENABLED: "true",
    MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
    MEETING_MINUTES_OPERATOR_USER_IDS: "U01",
    MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([destination]),
    MEETING_MINUTES_WORKSPACE: workspaceNamespace,
    MEETING_MINUTES_DEPLOYMENT_GATE: gateNamespace,
    TENANT_RUNTIME_STATE: tenantStateNamespace,
    BRAINBASE_TENANT_RUNTIME_SERVICE: tenantRuntimeService,
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    MANA_REQUIRED_CAPABILITY_ID: "task.write",
    MANA_REQUIRED_SLACK_SCOPES: "chat:write",
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    MANA_RUNTIME_CAPABILITIES: "signed_tenant_context,connection_revision_recheck,tenant_scoped_authorization,credential_broker_v1,usage_receipt_v1,idempotent_effects_v1,container_sanitization_v1",
    MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON: JSON.stringify({ "back-office": destination.projectId }),
    BRAINBASE_WORKSPACE_CONNECTIONS_JSON: JSON.stringify([{
      tenant_id: TENANT_ID, tenant_revision: "1", connection_id: "connection-1", connection_revision: "1",
      installation_id: "installation-1", workspace_id: WORKSPACE_ID, app_id: APP_ID, installer_id: "U01",
      granted_scopes: ["chat:write"], status: "active", deployment_id: "deployment-1",
      profile: "shared_cloud", credential_mode: "customer_oauth", contract_revision: "1",
    }]),
    ...overrides,
  };
}

function request(payload: unknown, options: { authorization?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  return new Request(
    `https://example.com/admin/meeting-minutes/runs/${RUN_ID}/authorized-generation-probe`,
    { method: "POST", headers, body: JSON.stringify(payload) },
  );
}

function authorizedReceiptRetryRequest(payload: unknown, options: { authorization?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  return new Request(
    `https://example.com/admin/meeting-minutes/runs/${RUN_ID}/authorized-receipt-retry`,
    { method: "POST", headers, body: JSON.stringify(payload) },
  );
}

function authorizedStatusRequest(options: { authorization?: string } = {}): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  return new Request(
    `https://example.com/admin/meeting-minutes/runs/${RUN_ID}/authorized-status?tenant_id=${TENANT_ID}&workspace_id=${WORKSPACE_ID}`,
    { headers },
  );
}

async function fetchWorker(input: Request, env: Record<string, unknown> = bindings()): Promise<Response> {
  return worker.fetch(input, env as never, {} as never);
}

const validPayload = {
  runId: RUN_ID,
  tenantId: TENANT_ID,
  workspaceId: WORKSPACE_ID,
  probeId: PROBE_ID,
};

describe("authorized meeting-minutes generation probe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.getWorkspace.mockResolvedValue({ fs: {} });
    runtimeMocks.withDisposableResource.mockImplementation(async (
      acquire: () => Promise<{ fs: unknown }>,
      use: (workspace: { fs: unknown }) => Promise<unknown>,
    ) => use(await acquire()));
    runtimeMocks.loadRun.mockReset().mockResolvedValue(undefined);
    runtimeMocks.runProbe.mockResolvedValue({ ok: true });
    runtimeMocks.createClients.mockReturnValue({ authority: {} });
    runtimeMocks.executeTenantBoundary.mockImplementation(async (input: { execute: () => Promise<unknown> }) => input.execute());
    runtimeMocks.resolveSlackWorkerIngress.mockImplementation(async (input: { identity: { event_id: string } }) => ({
      tenant_context: reauthorizedTenantContext(input.identity.event_id),
    }));
    runtimeMocks.executeTenantRuntimeOperation.mockResolvedValue({
      outcome: "completed", receiptId: "receipt-001", deliveredAt: "2026-09-06T00:00:02.000Z",
    });
  });

  it("rejects missing admin authorization before parsing or loading a run", async () => {
    const response = await fetchWorker(request(validPayload));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(runtimeMocks.loadRun).not.toHaveBeenCalled();
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("rejects an invalid probe schema before loading the saved run", async () => {
    const response = await fetchWorker(request({ ...validPayload, probeId: "not-a-uuid", extra: "rejected" }, {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "authorization",
      code: "meeting_minutes_probe_scope_invalid",
    });
    expect(runtimeMocks.loadRun).not.toHaveBeenCalled();
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("rejects a saved run without recovery authorization before generation", async () => {
    runtimeMocks.loadRun.mockResolvedValue(run({ recoveryAuthorization: undefined }));

    const response = await fetchWorker(request(validPayload, {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "authorization",
      code: "meeting_minutes_probe_not_authorized",
    });
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it.each([
    ["a persisted destination that differs from the configured destination", {
      destination: { ...destination, contextProjectCode: "other-project" },
    }],
    ["a source channel that differs from the saved authorization", {
      sourceChannelId: "COTHER",
    }],
  ])("rejects %s before generation", async (_description, overrides) => {
    runtimeMocks.loadRun.mockResolvedValue(run(overrides));

    const response = await fetchWorker(request(validPayload, {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      probeId: PROBE_ID,
      ok: false,
      generationOk: null,
      stage: "authorization",
      code: "CROSS_TENANT_CANDIDATE",
    });
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("rejects a non-retryable receipt failure before reauthorizing or emitting a receipt", async () => {
    const events = { send: vi.fn() };
    runtimeMocks.loadRun.mockResolvedValue(run({ runReceipt: {
      idempotencyKey: "meeting-minutes:run-001",
      status: "pending",
      failure: { stage: "run_receipt", code: "RUN_RECEIPT_OUTCOME_CASE_LINK_UNCONFIRMED",
        retryable: false, failedAt: "2026-09-06T00:00:01.000Z" },
    } }));

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }), bindings({ TECHKNIGHT_EVENTS: events }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "meeting_minutes_admin_retry_run_receipt_non_retryable",
    });
    expect(runtimeMocks.createClients).not.toHaveBeenCalled();
    expect(events.send).not.toHaveBeenCalled();
  });

  it.each(["RUN_RECEIPT_AUTHENTICATION_FAILED", "RUN_RECEIPT_FORBIDDEN"])(
    "reauthorizes and retries an explicit admin receipt retry after %s",
    async (code) => {
      const receiptRun = await retryableReceiptRun();
      runtimeMocks.loadRun.mockResolvedValue(run({ ...receiptRun, runReceipt: {
        ...receiptRun.runReceipt!,
        failure: { stage: "run_receipt", code, retryable: false,
          failedAt: "2026-09-06T00:00:01.000Z", operation: "ingest", httpStatus: code.endsWith("FORBIDDEN") ? 403 : 401 },
      } }));

      const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ runId: RUN_ID, status: "completed",
        runReceipt: { status: "delivered", receiptId: "receipt-001" } });
      expect(runtimeMocks.executeTenantRuntimeOperation).toHaveBeenCalledOnce();
      expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
    },
  );

  it("returns a delivered receipt result without enqueueing the full retry workflow", async () => {
    const receiptRun = await retryableReceiptRun();
    runtimeMocks.loadRun.mockResolvedValue(receiptRun);

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runId: RUN_ID, status: "completed",
      runReceipt: { status: "delivered", receiptId: "receipt-001", deliveredAt: "2026-09-06T00:00:02.000Z" } });
    expect(runtimeMocks.executeTenantRuntimeOperation).toHaveBeenCalledOnce();
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("corrects a pending receipt OutcomeCase without re-entering the full minutes workflow", async () => {
    const receiptRun = await retryableReceiptRun({ outcomeCaseId: "wrong_case" });
    runtimeMocks.loadRun.mockImplementation(async () => receiptRun);

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200", outcomeCaseId: "correct_case" },
    { authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    expect(receiptRun.outcomeCaseId).toBe("correct_case");
    expect(receiptRun.revision).toBe(2);
    expect(runtimeMocks.saveRun).toHaveBeenCalled();
    expect(runtimeMocks.executeTenantRuntimeOperation).toHaveBeenCalledOnce();
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("retries from the persisted run when destination metadata changed after completion", async () => {
    const receiptRun = await retryableReceiptRun();
    runtimeMocks.loadRun.mockResolvedValue(receiptRun);
    const changedDestination = {
      ...destination,
      github: { ...destination.github, pathPrefix: "meetings/new-location/" },
    };

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }),
    bindings({ MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([changedDestination]) }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runId: RUN_ID, status: "completed",
      runReceipt: { status: "delivered", receiptId: "receipt-001" } });
    expect(runtimeMocks.executeTenantRuntimeOperation).toHaveBeenCalledOnce();
    expect(runtimeMocks.runProbe).not.toHaveBeenCalled();
  });

  it("returns a safe 502 delivery failure without exposing the upstream error", async () => {
    runtimeMocks.loadRun.mockResolvedValue(await retryableReceiptRun());
    runtimeMocks.executeTenantRuntimeOperation.mockRejectedValue(new Error("token=must-not-leak"));

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "RUN_RECEIPT_DELIVERY_FAILED" });
  });

  it.each([
    ["AUTHORITY_UNAVAILABLE", 503, "RUN_RECEIPT_AUTHORITY_UNAVAILABLE"],
    ["CROSS_TENANT_CANDIDATE", 403, "RUN_RECEIPT_AUTHORITY_REJECTED"],
  ])("maps authority %s to its safe HTTP result", async (authorityCode, status, error) => {
    runtimeMocks.loadRun.mockResolvedValue(await retryableReceiptRun());
    runtimeMocks.resolveSlackWorkerIngress.mockRejectedValue(new TenantBoundaryError("worker_ingress", authorityCode));

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(runtimeMocks.executeTenantRuntimeOperation).not.toHaveBeenCalled();
  });

  it("returns 409 when the durable run changed after receipt authority was rechecked", async () => {
    const initial = await retryableReceiptRun();
    runtimeMocks.loadRun.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, revision: 2 });
    runtimeMocks.executeTenantRuntimeOperation.mockImplementation(async (input: {
      process: () => Promise<unknown>;
    }) => input.process());

    const response = await fetchWorker(authorizedReceiptRetryRequest({ tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID, actionTs: "100.200" }, { authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "meeting_minutes_admin_retry_run_receipt_stale" });
  });

  it("returns only allowlisted receipt operation and HTTP status diagnostics from authorized status", async () => {
    runtimeMocks.loadRun.mockResolvedValue(run({ runReceipt: {
      idempotencyKey: "meeting-minutes:run-001",
      status: "pending",
      failure: {
        stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
        failedAt: "2026-09-06T00:00:01.000Z", operation: "ingest", httpStatus: 503,
        upstreamResponse: "must-not-leak",
      } as never,
    } }));

    const response = await fetchWorker(authorizedStatusRequest({ authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    const body = await response.json() as { runReceipt?: { failure?: unknown } };
    expect(body.runReceipt?.failure).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
      failedAt: "2026-09-06T00:00:01.000Z", operation: "ingest", httpStatus: 503,
    });
  });

  it("drops malformed receipt operation and HTTP status diagnostics from authorized status", async () => {
    runtimeMocks.loadRun.mockResolvedValue(run({ runReceipt: {
      idempotencyKey: "meeting-minutes:run-001",
      status: "pending",
      failure: { stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
        failedAt: "2026-09-06T00:00:01.000Z", operation: "untrusted", httpStatus: 700,
        upstreamResponse: "must-not-leak" } as never,
    } }));

    const response = await fetchWorker(authorizedStatusRequest({ authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    const body = await response.json() as { runReceipt?: { failure?: unknown } };
    expect(body.runReceipt?.failure).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
      failedAt: "2026-09-06T00:00:01.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it.each([
    "RUN_RECEIPT_AUTHORITY_UNAVAILABLE",
    "RUN_RECEIPT_AUTHORITY_REJECTED",
  ])("returns the safe %s authority diagnostic from authorized status", async (code) => {
    runtimeMocks.loadRun.mockResolvedValue(run({ runReceipt: {
      idempotencyKey: "meeting-minutes:run-001",
      status: "pending",
      failure: { stage: "run_receipt", code, retryable: true,
        failedAt: "2026-09-06T00:00:01.000Z", rawError: "must-not-leak" } as never,
    } }));

    const response = await fetchWorker(authorizedStatusRequest({ authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    const body = await response.json() as { runReceipt?: { failure?: unknown } };
    expect(body.runReceipt?.failure).toEqual({
      stage: "run_receipt", code, retryable: true, failedAt: "2026-09-06T00:00:01.000Z",
    });
  });

  it("omits malformed receipt failure diagnostics from authorized status", async () => {
    runtimeMocks.loadRun.mockResolvedValue(run({ runReceipt: {
      idempotencyKey: "meeting-minutes:run-001",
      status: "pending",
      failure: { stage: "run_receipt", code: "raw upstream error", retryable: false,
        failedAt: "not-a-timestamp", upstreamResponse: "must-not-leak" } as never,
    } }));

    const response = await fetchWorker(authorizedStatusRequest({ authorization: `Bearer ${ADMIN_TOKEN}` }));

    expect(response.status).toBe(200);
    const body = await response.json() as { runReceipt?: { failure?: unknown } };
    expect(body.runReceipt?.failure).toBeUndefined();
  });
});
