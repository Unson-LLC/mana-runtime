import {
  runAutonomyAgent,
  type AutonomyCanonicalState,
  type AutonomyAgentInput,
} from "./autonomy-agent.js";
import {
  runScheduledAutonomy,
  type AutonomyCanonicalStateRequest,
  type AutonomyScheduledEnv,
  type AutonomyScheduledRun,
} from "./autonomy-scheduled.js";
import {
  resolveAutonomyTenantContext,
  type ResolveAutonomyTenantContextInput,
  type ResolvedAutonomyTenantContext,
} from "./autonomy-tenant-context.js";
import { resolveClaudeRuntimeConfig, type ClaudeRuntimeBindings } from "./claude-runtime-config.js";
import { createTechKnightSandbox, type SandboxRuntimeEnv } from "./sandbox-runtime.js";
import { createDurableTenantBoundaryRegistry } from "./multitenancy/durable-tenant-boundary.js";
import {
  parseWorkspaceConnectionHints,
  type TenantRuntimeServiceBinding,
} from "./multitenancy/http-clients.js";
import type { ReplySandbox } from "./reply-pipeline.js";

export interface AutonomyEntrypointEnv extends AutonomyScheduledEnv, ClaudeRuntimeBindings, SandboxRuntimeEnv {
  BRAINBASE_WORKSPACE_CONNECTIONS_JSON?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE?: TenantRuntimeServiceBinding;
  SLACK_EXPECTED_APP_ID?: string;
  MANA_REQUIRED_AUDIENCE?: string;
  MANA_AUTONOMY_PLACEMENT_ID?: string;
  MANA_AUTONOMY_CHANNEL_ID?: string;
  MANA_AUTONOMY_CAPABILITY_ID?: string;
  MANA_AUTONOMY_PER_RUN_BUDGET?: string;
  MANA_AUTONOMY_CLAUDE_MODEL?: string;
}

export interface AutonomyEntrypointDependencies {
  now(): number;
  resolveTenantContext(input: ResolveAutonomyTenantContextInput): Promise<ResolvedAutonomyTenantContext>;
  runAgent(input: AutonomyAgentInput): Promise<{ outcomeCode?: string; evidence?: Array<{
    kind: "task" | "receipt" | "artifact" | "run";
    id: string;
  }> }>;
  createSandbox(env: SandboxRuntimeEnv, id: string): ReplySandbox;
  resolveVerificationKey(rawJwks: string | undefined, keyId: string): Promise<CryptoKey | undefined>;
}

function required(value: string | undefined): string {
  if (!value?.trim()) throw new Error("autonomy_runtime_not_configured");
  return value.trim();
}

function timeout(value: string | undefined): number {
  if (!value) return 5_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30_000) {
    throw new Error("autonomy_runtime_not_configured");
  }
  return parsed;
}

function perRunBudget(value: string | undefined): number {
  if (!value) return 2;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("autonomy_runtime_not_configured");
  }
  return parsed;
}

function autonomyModel(value: string | undefined): "opus" | "sonnet" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "opus" && value !== "sonnet") {
    throw new Error("autonomy_runtime_not_configured");
  }
  return value;
}

async function importVerificationKey(
  rawJwks: string | undefined,
  keyId: string,
): Promise<CryptoKey | undefined> {
  if (!rawJwks?.trim() || !keyId) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(rawJwks);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return undefined;
  const matches = keys.filter((item) => item && typeof item === "object" && !Array.isArray(item)
    && (item as { kid?: unknown }).kid === keyId);
  if (matches.length !== 1) return undefined;
  const jwk = matches[0] as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || jwk.alg !== "EdDSA") return undefined;
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return undefined;
  }
}

const defaultDependencies: AutonomyEntrypointDependencies = {
  now: () => Date.now(),
  resolveTenantContext: resolveAutonomyTenantContext,
  runAgent: runAutonomyAgent,
  createSandbox: (env, id) => createTechKnightSandbox(env, id) as unknown as ReplySandbox,
  resolveVerificationKey: importVerificationKey,
};

function workspaceConnection(env: AutonomyEntrypointEnv) {
  const workspaceId = required(env.SLACK_EXPECTED_TEAM_ID);
  const appId = required(env.SLACK_EXPECTED_APP_ID);
  const matches = parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON)
    .filter((item) => item.workspace_id === workspaceId && item.app_id === appId);
  if (matches.length !== 1) throw new Error("autonomy_runtime_not_configured");
  return matches[0]!;
}

function canonicalState(
  resolved: ResolvedAutonomyTenantContext,
  observedAt: string,
): AutonomyCanonicalState {
  const context = resolved.tenant_context;
  return {
    observedAt,
    tenantId: context.tenant.tenant_id,
    tenantRevision: context.tenant.tenant_revision,
    connectionId: context.workspace_connection.connection_id,
    connectionRevision: context.workspace_connection.connection_revision,
    actorPrincipalId: context.actor.principal_id,
    actorSubjectId: context.actor.authenticated_subject_id,
    projectIds: [...context.authorization.project_ids],
    capabilityIds: [...context.authorization.capability_ids],
    authorityScopes: context.authorization.data_scopes.filter((scope) => scope.startsWith("company_authority:")),
    contractRevision: context.contract_revision,
  };
}

export async function runAutonomyScheduledEntrypoint(
  env: AutonomyEntrypointEnv,
  dependencyOverrides: Partial<AutonomyEntrypointDependencies> = {},
): Promise<"inactive" | "disabled" | "busy" | "replayed" | "ran"> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const now = dependencies.now();
  const resolvedByRun = new Map<string, ResolvedAutonomyTenantContext>();
  const placementId = env.MANA_AUTONOMY_PLACEMENT_ID ?? "";
  const writeBudget = perRunBudget(env.MANA_AUTONOMY_PER_RUN_BUDGET);

  return runScheduledAutonomy<AutonomyCanonicalState>({
    env,
    now,
    config: {
      placementId,
      perRunBudget: writeBudget,
    },
    readCanonicalState: async (request: AutonomyCanonicalStateRequest) => {
      const connection = workspaceConnection(env);
      const observedAt = new Date(now).toISOString();
      const resolved = await dependencies.resolveTenantContext({
        service: env.BRAINBASE_TENANT_RUNTIME_SERVICE
          ?? (() => { throw new Error("autonomy_runtime_not_configured"); })(),
        workspaceConnection: connection,
        tenantRevision: connection.tenant_revision,
        actorId: request.actorId,
        project: request.project,
        capabilityId: required(env.MANA_AUTONOMY_CAPABILITY_ID),
        audience: required(env.MANA_REQUIRED_AUDIENCE),
        runId: request.runId,
        channelId: required(env.MANA_AUTONOMY_CHANNEL_ID),
        now: observedAt,
        timeoutMs: timeout(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS),
        resolveVerificationKey: (keyId) => dependencies.resolveVerificationKey(
          env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON,
          keyId,
        ),
      });
      resolvedByRun.set(request.runId, resolved);
      return canonicalState(resolved, observedAt);
    },
    run: async (scheduled: AutonomyScheduledRun<AutonomyCanonicalState>) => {
      const resolved = resolvedByRun.get(scheduled.runId);
      if (!resolved) throw new Error("autonomy_runtime_not_configured");
      const registry = createDurableTenantBoundaryRegistry(env.TENANT_RUNTIME_STATE);
      const handle = await registry.register({
        tenant_context: resolved.tenant_context,
        expected_scope: resolved.expected_scope,
        now: new Date(now).toISOString(),
      });
      try {
        return await dependencies.runAgent({
          runId: scheduled.runId,
          actorId: scheduled.actorId,
          placementId: required(placementId),
          project: scheduled.project,
          writeBudget,
          taskWriteCapability: scheduled.taskWriteCapability,
          tenantBoundaryHandle: handle,
          canonicalState: scheduled.canonicalState,
          historicalContext: scheduled.historicalContext,
          claudeRuntime: resolveClaudeRuntimeConfig(env, autonomyModel(env.MANA_AUTONOMY_CLAUDE_MODEL)),
          createSandbox: (id) => dependencies.createSandbox(env, id),
        });
      } finally {
        await registry.dispose(handle);
      }
    },
  });
}
