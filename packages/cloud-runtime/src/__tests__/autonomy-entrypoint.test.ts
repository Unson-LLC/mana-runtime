import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runAutonomyScheduledEntrypoint,
  type AutonomyEntrypointEnv,
} from "../autonomy-entrypoint.js";
import type { AutonomyRunHistoryNamespace } from "../autonomy-run-history.js";
import type { ResolvedAutonomyTenantContext } from "../autonomy-tenant-context.js";
import { TaskWriteBudget } from "../task-write-budget.js";
import type { TenantContextEnvelope, WorkspaceConnectionSnapshot } from "../multitenancy/contracts.js";

const sandboxMocks = vi.hoisted(() => ({
  createTechKnightSandbox: vi.fn(),
}));

vi.mock("../sandbox-runtime.js", () => ({
  createTechKnightSandbox: sandboxMocks.createTechKnightSandbox,
}));

const SECRET = "autonomy-capability-secret-at-least-32-bytes";
const NOW = Date.parse("2026-08-26T01:00:00Z");
const RUN_ID = `mana-autonomy-24h-v0:${new Date(NOW).toISOString()}`;
const TENANT_ID = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONNECTION_ID = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEPLOYMENT_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";

function history() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    setAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
    transaction: vi.fn(async <T>(
      closure: (transaction: { get: typeof storage.get; put: typeof storage.put }) => Promise<T>,
    ) => closure(storage)),
  };
  const durable = new TaskWriteBudget(
    { storage } as unknown as ConstructorParameters<typeof TaskWriteBudget>[0],
  );
  const fetch = vi.fn((request: Request) => durable.fetch(request));
  const namespace: AutonomyRunHistoryNamespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch })),
  };
  return { namespace, fetch };
}

const workspaceConnection: WorkspaceConnectionSnapshot = {
  tenant_id: TENANT_ID,
  connection_id: CONNECTION_ID,
  connection_revision: "1",
  installation_id: "slack_T_UNSON_A_MANA",
  workspace_id: "T_UNSON",
  app_id: "A_MANA",
  installer_id: "brainbase-control-plane",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active",
  deployment_id: DEPLOYMENT_ID,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "2",
};

function tenantContext(): TenantContextEnvelope {
  return {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: TENANT_ID, tenant_revision: "1" },
    workspace_connection: {
      connection_id: CONNECTION_ID,
      connection_revision: "1",
      provider: "slack",
      installation_id: "slack_T_UNSON_A_MANA",
      workspace_id: "T_UNSON",
      app_id: "A_MANA",
      status: "active",
    },
    actor: {
      principal_id: "mana_autonomy_v0",
      principal_type: "service",
      authenticated_subject_id: "mana_autonomy_v0",
    },
    authorization: {
      organization_ids: ["unson-business"],
      project_ids: ["proj_brainbase"],
      capability_ids: ["runtime.execute"],
      data_scopes: [
        "company_authority:decision:auto",
        "company_authority:membership:svc-membership@1",
        "company_authority:resource:project:brainbase@1",
        "company_authority:raci:1",
        "company_authority:policy:1",
        "company_authority:effect:read",
        "company_authority:placement:mana-autonomy",
        "company_authority:identity_receipt:idres-service",
        "company_authority:authority_receipt:authres-service",
      ],
    },
    placement: { deployment_id: DEPLOYMENT_ID, profile: "shared_cloud" },
    slack: {
      event_id: RUN_ID,
      channel_id: "C_BRAINBASE",
      thread_ts: RUN_ID,
    },
    correlation_id: "cor_service_autonomy",
    operation_id: "op_service_autonomy",
    idempotency_key: "ik1_service-autonomy-entrypoint",
    contract_revision: "2",
    credential: {
      mode: "customer_oauth",
      credential_ref: "credential-ref-unson",
      billing_principal_id: "mana_autonomy_v0",
    },
    issued_at: "2026-08-26T01:00:00Z",
    expires_at: "2026-08-26T01:05:00Z",
    integrity: {
      method: "jws_detached",
      algorithm: "EdDSA",
      key_id: "brainbase-key-1",
      value: "signed-service-context",
    },
  };
}

function resolved(): ResolvedAutonomyTenantContext {
  return {
    tenant_context: tenantContext(),
    authoritative_snapshot: workspaceConnection,
    expected_scope: {
      audience: "mana-runtime",
      workspace_id: "T_UNSON",
      app_id: "A_MANA",
      channel_id: "C_BRAINBASE",
      thread_ts: RUN_ID,
      actor_principal_id: "mana_autonomy_v0",
      project_id: "proj_brainbase",
      project_ids: ["proj_brainbase"],
      capability_id: "runtime.execute",
      deployment_id: DEPLOYMENT_ID,
    },
  };
}

function env(
  namespace: AutonomyRunHistoryNamespace,
  overrides: Partial<AutonomyEntrypointEnv> = {},
): AutonomyEntrypointEnv {
  return {
    MANA_AUTONOMY_EXPERIMENT_JSON: JSON.stringify({
      id: "mana-autonomy-24h-v0",
      actor_id: "mana_autonomy_v0",
      project: "brainbase",
      starts_at: "2026-08-26T00:00:00Z",
      expires_at: "2026-08-27T00:00:00Z",
      max_writes: 20,
    }),
    MANA_AUTONOMY_DISABLED: "false",
    MANA_AUTONOMY_PLACEMENT_ID: "mana-autonomy",
    MANA_AUTONOMY_CHANNEL_ID: "C_BRAINBASE",
    MANA_AUTONOMY_CAPABILITY_ID: "runtime.execute",
    MANA_AUTONOMY_PER_RUN_BUDGET: "2",
    MANA_AUTONOMY_CLAUDE_MODEL: "sonnet",
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    RUNTIME_CLAUDE_MODEL: "opus",
    RUNTIME_CLAUDE_EFFORT: "xhigh",
    TASK_WRITE_CAPABILITY_SECRET: SECRET,
    TASK_WRITE_BUDGETS: namespace,
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    SLACK_EXPECTED_APP_ID: "A_MANA",
    BRAINBASE_WORKSPACE_CONNECTIONS_JSON: JSON.stringify([{
      ...workspaceConnection,
      tenant_revision: "1",
    }]),
    BRAINBASE_TENANT_RUNTIME_SERVICE: {
      fetch: vi.fn(async () => Response.json({ error: "must-use-injected-resolver" }, { status: 500 })),
    },
    TECHKNIGHT_SANDBOX: {} as AutonomyEntrypointEnv["TECHKNIGHT_SANDBOX"],
    TENANT_RUNTIME_STATE: {} as AutonomyEntrypointEnv["TENANT_RUNTIME_STATE"],
    ...overrides,
  } as AutonomyEntrypointEnv;
}

describe("autonomy scheduled entrypoint", () => {
  it("resolves read-scoped service authority and runs with a separate create-only write capability", async () => {
    const current = history();
    const canonical = resolved();
    const resolveTenantContext = vi.fn(async (input) => {
      expect(input).toMatchObject({
        actorId: "mana_autonomy_v0",
        project: "brainbase",
        capabilityId: "runtime.execute",
        audience: "mana-runtime",
        runId: RUN_ID,
        channelId: "C_BRAINBASE",
        tenantRevision: "1",
      });
      expect(input.workspaceConnection).toEqual(workspaceConnection);
      return canonical;
    });
    const dispose = vi.fn(async () => undefined);
    const registerTenantBoundary = vi.fn(async (_env, value, now) => {
      expect(value).toEqual(canonical);
      expect(now).toBe("2026-08-26T01:00:00.000Z");
      return { handle: `tb_${"a".repeat(32)}`, dispose };
    });
    const runAgent = vi.fn(async (input) => {
      expect(input).toMatchObject({
        runId: RUN_ID,
        actorId: "mana_autonomy_v0",
        placementId: "mana-autonomy",
        project: "brainbase",
        writeBudget: 2,
        tenantBoundaryHandle: `tb_${"a".repeat(32)}`,
        claudeRuntime: { model: "sonnet" },
      });
      expect(input.canonicalState).toMatchObject({
        tenantId: TENANT_ID,
        actorPrincipalId: "mana_autonomy_v0",
        projectIds: ["proj_brainbase"],
        capabilityIds: ["runtime.execute"],
        authorityScopes: expect.arrayContaining(["company_authority:effect:read"]),
      });
      expect(input.historicalContext.untrustedHistoricalContext).toBe(true);
      const claims = await verifyTaskWriteCapability(input.taskWriteCapability, SECRET, {
        requestId: RUN_ID,
        workspace: "T_UNSON",
        placementId: "mana-autonomy",
        now: NOW,
      });
      expect(claims.actor).toEqual({
        provider: "service",
        id: "mana_autonomy_v0",
        workspace: "T_UNSON",
      });
      expect(claims.projects).toEqual(["brainbase"]);
      expect(claims.operations).toEqual(["task.create"]);
      expect(claims.budget).toBe(2);
      return { outcomeCode: "autonomy_no_action", evidence: [] };
    });

    await expect(runAutonomyScheduledEntrypoint(env(current.namespace), {
      now: () => NOW,
      resolveTenantContext,
      registerTenantBoundary,
      runAgent,
      createSandbox: vi.fn(),
      resolveVerificationKey: vi.fn(async () => undefined),
    })).resolves.toBe("ran");

    expect(resolveTenantContext).toHaveBeenCalledOnce();
    expect(registerTenantBoundary).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not resolve authority or register a boundary while the kill switch is active", async () => {
    const current = history();
    const resolveTenantContext = vi.fn();
    const registerTenantBoundary = vi.fn();
    const runAgent = vi.fn();

    await expect(runAutonomyScheduledEntrypoint(env(current.namespace, {
      MANA_AUTONOMY_DISABLED: "true",
    }), {
      now: () => NOW,
      resolveTenantContext,
      registerTenantBoundary,
      runAgent,
    })).resolves.toBe("disabled");

    expect(resolveTenantContext).not.toHaveBeenCalled();
    expect(registerTenantBoundary).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(current.fetch).not.toHaveBeenCalled();
  });

  it("disposes the tenant boundary when the agent fails", async () => {
    const current = history();
    const dispose = vi.fn(async () => undefined);

    await expect(runAutonomyScheduledEntrypoint(env(current.namespace), {
      now: () => NOW,
      resolveTenantContext: vi.fn(async () => resolved()),
      registerTenantBoundary: vi.fn(async () => ({
        handle: `tb_${"b".repeat(32)}`,
        dispose,
      })),
      runAgent: vi.fn(async () => { throw new Error("must-not-leak-to-run-history"); }),
    })).rejects.toThrow("must-not-leak-to-run-history");

    expect(dispose).toHaveBeenCalledOnce();
  });
});
