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
  runProbe: vi.fn(),
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
vi.mock("../meeting-minutes-generation-probe.js", () => ({
  runMeetingMinutesGenerationProbe: runtimeMocks.runProbe,
}));
vi.mock("../meeting-minutes-state.js", () => ({
  loadMeetingMinutesRun: runtimeMocks.loadRun,
  saveMeetingMinutesRun: vi.fn(),
}));
vi.mock("../disposable-resource.js", () => ({
  withDisposableResource: runtimeMocks.withDisposableResource,
}));

import worker from "../index.js";

const ADMIN_TOKEN = "admin-probe-token";
const RUN_ID = "run-001";
const TENANT_ID = "tenant-001";
const WORKSPACE_ID = "T01";
const APP_ID = "A01";
const CHANNEL_ID = "C01";
const THREAD_TS = "100.200";
const PROBE_ID = "00000000-0000-4000-8000-000000000001";

const destination: MeetingMinutesDestination = {
  id: "mana",
  projectId: "project-1",
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
  return {
    SANDBOX_PROBE_TOKEN: ADMIN_TOKEN,
    TENANT_ID,
    MEETING_MINUTES_ENABLED: "true",
    MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
    MEETING_MINUTES_OPERATOR_USER_IDS: "U01",
    MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([destination]),
    MEETING_MINUTES_WORKSPACE: workspaceNamespace,
    MEETING_MINUTES_DEPLOYMENT_GATE: gateNamespace,
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    MANA_REQUIRED_CAPABILITY_ID: "task.write",
    MANA_REQUIRED_SLACK_SCOPES: "chat:write",
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
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
    runtimeMocks.loadRun.mockResolvedValue(undefined);
    runtimeMocks.runProbe.mockResolvedValue({ ok: true });
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
});
