import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { handleTenantSlackRequest } from "./slack.js";
import {
  handleSandboxAdminRequest,
  isSandboxAdminAuthorized,
} from "./sandbox-admin.js";
import {
  createTechKnightSandbox,
  type SandboxRuntimeEnv,
} from "./sandbox-runtime.js";
import { destroyTenantContainer } from "./multitenancy/container-lifecycle.js";
import type { SlackQueueEvent } from "./types.js";
import {
  isMeetingMinutesSelection,
  isMeetingMinutesRedo,
  isMeetingMinutesSlackEvent,
  meetingMinutesRuntimeConfig,
  processMeetingMinutesSlackEvent,
  processMeetingMinutesRedo,
  type MeetingMinutesEnvironment,
} from "./meeting-minutes-entrypoints.js";
import type { MeetingMinutesDestination, MeetingMinutesRecovery, MeetingMinutesRedo, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import {
  handleMeetingMinutesInteractionEntrypoint,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
  type TenantInteractionTarget,
} from "./slack-interactions.js";
import { processMeetingMinutesSelectionWithStatus } from "./meeting-minutes-lifecycle.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import { handleMeetingMinutesTaskAction, type MeetingMinutesSourceIdentity } from "./meeting-minutes-task-actions.js";
import { createTaskWriteProxyHandler } from "./task-write-proxy.js";
import { peekTaskWriteApproval } from "./task-write-approval.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import { CloudflareMeetingMinutesGitHubClient } from "./meeting-minutes-github.js";
import { classifyMeetingMinutesDestinationInSandbox,
  generateMeetingMinutesInSandbox } from "./meeting-minutes-generator.js";
import { MeetingMinutesBrainbaseContextClient, resolveMeetingMinutesContextMode } from "./meeting-minutes-brainbase-context.js";
import { TaskApiClient, TaskApiError } from "@openryoko/task-runtime-core";
import { isReplyEligible, postSlackReply, processReplyEvent, ReplyPipelineError } from "./reply-pipeline.js";
import { resolveActorIdentityResolverFromEnv } from "./slack-actor-identity.js";
import {
  processMeetingTaskEvent,
} from "./meeting-task-pipeline.js";
import {
  parseRuntimePlacements,
  RuntimeBindingError,
  resolveRuntimePlacement,
  runWithReplyTaskSearchBinding,
} from "./runtime-config.js";
import { routeRuntimeEvent } from "./runtime-event-router.js";
import { persistEventOnce, persistReplyCompletion, readReplyCompletion } from "./workspace-store.js";
import { hydrateSlackQueueEventThreadContext } from "./slack-thread-context.js";
import { withDisposableResource } from "./disposable-resource.js";
import { resolveClaudeRuntimeConfig } from "./claude-runtime-config.js";
import { requesterProfileOrFallback, resolveSlackUserProfile } from "./slack-user-profile.js";
import { runtimeWorkspaceName } from "./runtime-workspace-key.js";
import { executeRuntimeControlCommand, parseRuntimeControlCommand, renderRuntimeControlCommandError, RuntimeControlCommandError } from "./runtime-control-command.js";
import { markWorkspaceEngaged, readWorkspaceSession, reconcilePermissionRevision } from "./workspace-session.js";
import { runRuntimeDoctor } from "./runtime-doctor.js";
import { executeRuntimeCron, parsePlacementCronJobs } from "./runtime-cron.js";
import { createCanonicalManualCronMessage } from "./runtime-cron-event.js";
import { handleSlackCommandRequest } from "./slack-command.js";
import { runCloudflareDevelopmentRequest } from "./development-runner-client.js";
import {
  handleDevelopmentCallback,
  type DevelopmentCallbackClaim,
  type DevelopmentCallbackDelivery,
  type DevelopmentCallbackPayload,
} from "./development-callback.js";
import {
  claimDevelopmentCallbackState,
  completeDevelopmentCallbackState,
  recordDevelopmentCallbackDeliveryState,
  releaseDevelopmentCallbackState,
} from "./multitenancy/development-callback-state.js";
import { appendSlackThreadParticipantProfiles } from "./slack-thread-participants.js";
import { hydrateSlackAttachments } from "./slack-attachments.js";
import { hydrateGraphContext, listGraphPeople, resolveGraphPersonByName, resolveGraphRequester } from "./brainbase-graph-runtime.js";
import { RuntimeSessionRegistry, upsertRuntimeSession } from "./runtime-session-registry.js";
import {
  createCanonicalTaskBoardRepairMessage,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
  processTaskBoardRepair,
  taskBoardRepairEventId,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import { parseTaskBoardTargets, taskBoardTargetsForProjects } from "./task-board-targets.js";
import { actorIdHash, emitTurnLog, type TurnRuntimeTrace } from "./turn-observability.js";
import { claimRuntimeEvent, completeRuntimeEvent, releaseRuntimeEvent, runtimeDeliveryId } from "./runtime-event-claim.js";
import { runRuntimeTriage } from "./runtime-triage.js";
import { armMeetingMinutesRecovery, isMeetingMinutesRecovery, recoverStaleMeetingMinutesRun,
  MEETING_MINUTES_RECOVERY_DELAY_SECONDS } from "./meeting-minutes-recovery.js";
import { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";
import {
  consumeTenantQueueMessage,
  executeTenantBoundary,
  resolveSlackWorkerIngress,
  type TenantQueueBody,
  TenantRuntimeBoundaryVerifier,
} from "./multitenancy/runtime-boundaries.js";
import { createTenantRuntimeHttpClients } from "./multitenancy/http-clients.js";
import {
  createDurableTenantAccountingClient,
  createDurableTenantStateClient,
  TenantRuntimeStateHandler,
  type TenantStateStorage,
} from "./multitenancy/tenant-runtime-state.js";
import {
  executeTenantRuntimeOperation,
  postTenantSlackReply,
  recordTenantRuntimeTerminalOperation,
} from "./multitenancy/production-consumer.js";
import {
  writeTenantAccountingContinuation,
  type AccountingArtifact,
} from "./multitenancy/accounting.js";
import {
  REQUIRED_TENANT_CAPABILITIES,
  type BoundaryName,
  type DeploymentProfileName,
  type ExpectedTenantScope,
  type QuotaDecision,
  type TenantContextEnvelope,
} from "./multitenancy/contracts.js";
import { deny, TenantBoundaryError } from "./multitenancy/errors.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { withTenantCredentialLease } from "./multitenancy/credential-injector.js";
import { createTenantCredentialFetch } from "./multitenancy/tenant-credential-fetch.js";
import {
  createDurableTenantCredentialRegistry,
  TenantCredentialRelayHandler,
} from "./multitenancy/durable-credential-relay.js";
import {
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  TenantBoundaryContextHandler,
} from "./multitenancy/durable-tenant-boundary.js";
import {
  claimDevelopmentJobOwner,
  developmentTenantContextHash,
  releaseDevelopmentJobOwner,
} from "./multitenancy/development-job-owner.js";
import {
  createDevelopmentTerminalOutboxClient,
  DevelopmentTerminalOutboxHandler,
} from "./multitenancy/development-terminal-outbox.js";
import {
  failDevelopmentTerminalOutboxRecord,
  retryDevelopmentTerminalOutboxRecord,
} from "./multitenancy/development-callback-proxy.js";
import { assessTenantRuntimeReadiness } from "./multitenancy/runtime-readiness.js";
import { handleSlackInstallationLifecycleRequest } from "./multitenancy/slack-installation-entrypoint.js";
import { SlackInstallationAdapter } from "./multitenancy/workspace-connection.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";
export { RuntimeSessionRegistry } from "./runtime-session-registry.js";
export { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_SIGNING_SECRET_TECHKNIGHT?: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON?: string;
  RUNTIME_CRON_JOBS_JSON?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  TASK_WRITE_APPROVAL_CHANNEL_ID?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  MEETING_MINUTES_CONTEXT_MODE?: string;
  RUNTIME_PROJECT_CODES?: string;
  RUNTIME_EXECUTION_MODE?: string;
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  RUNTIME_TASK_WRITE_ENABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  RUNTIME_PLACEMENT_ID?: string;
  RUNTIME_PLACEMENTS_JSON?: string;
  RUNTIME_TASK_BOARD_ENABLED?: string;
  TASK_BOARD_TARGETS_JSON?: string;
  RUNTIME_CLAUDE_MODEL?: string;
  RUNTIME_CLAUDE_EFFORT?: string;
  BRAINBASE_SLACK_PERSON_MAP_JSON?: string;
  BRAINBASE_GRAPH_API_BASE_URL?: string;
  BRAINBASE_GRAPH_API_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  TENANT_ID: string;
  MANA_DEPLOYMENT_PROFILE?: string;
  MANA_REQUIRED_AUDIENCE?: string;
  MANA_REQUIRED_PROJECT_ID?: string;
  MANA_REQUIRED_CAPABILITY_ID?: string;
  MANA_REQUIRED_SLACK_SCOPES?: string;
  MANA_CREDENTIAL_AUDIENCE?: string;
  MANA_TASK_BOARD_SERVICE_ACTOR_ID?: string;
  MANA_RUNTIME_CAPABILITIES?: string;
  BRAINBASE_TENANT_AUTHORITY_URL?: string;
  BRAINBASE_CREDENTIAL_BROKER_URL?: string;
  BRAINBASE_QUOTA_URL?: string;
  BRAINBASE_ACCOUNTING_URL?: string;
  BRAINBASE_RUNTIME_API_TOKEN?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
  SLACK_INSTALLATION_LIFECYCLE_TOKEN?: string;
  TECHKNIGHT_EVENTS: Queue<TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
    | TenantQueueBody<MeetingMinutesRedo>
    | TenantQueueBody<MeetingMinutesRecovery>
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery>;
  TASK_BOARD_REPAIRS: Queue<TenantQueueBody<TaskBoardRepairEvent> | TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS: DurableObjectNamespace;
  TASK_WRITE_APPROVALS: DurableObjectNamespace;
  TECHKNIGHT_WORKSPACE: DurableObjectNamespace<TechKnightWorkspace>;
  MEETING_MINUTES_WORKSPACE: DurableObjectNamespace<MeetingMinutesWorkspace>;
  MEETING_MINUTES_DEPLOYMENT_GATE: DurableObjectNamespace<MeetingMinutesDeploymentGate>;
  RUNTIME_SESSION_REGISTRY: DurableObjectNamespace<RuntimeSessionRegistry>;
  TENANT_RUNTIME_STATE: DurableObjectNamespace<TenantRuntimeState>;
}

interface WorkspaceEnv {}

export class TenantRuntimeState extends DurableObject<Env> {
  readonly #handler = new TenantRuntimeStateHandler(
    this.ctx.storage as unknown as TenantStateStorage,
  );
  readonly #credentialRelay = new TenantCredentialRelayHandler(fetch, {
    claim: async () => this.ctx.storage.transaction(async (transaction) => {
      const key = "credential-lease-claimed-v1";
      if (await transaction.get(key)) return false;
      await transaction.put(key, { claimed: true });
      return true;
    }),
  }, {
    setAlarm: (scheduledTime) => this.ctx.storage.setAlarm(scheduledTime),
  });
  readonly #boundaryContext = new TenantBoundaryContextHandler(
    this.ctx.storage,
    async (input) => {
      const clients = tenantRuntimeClients(this.env);
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(this.env, keyId),
      });
      await executeTenantBoundary({ ...input, verifier, execute: async () => undefined });
    },
  );
  readonly #developmentTerminalOutbox = new DevelopmentTerminalOutboxHandler(
    this.ctx.storage as unknown as TenantStateStorage,
    { setAlarm: (scheduledTime) => this.ctx.storage.setAlarm(scheduledTime) },
  );

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "tenant-credential-relay.internal") {
      return this.#credentialRelay.fetch(request);
    }
    if (new URL(request.url).hostname === "tenant-boundary-context.internal") {
      return this.#boundaryContext.fetch(request);
    }
    if (new URL(request.url).hostname === "development-terminal-outbox.internal") {
      return this.#developmentTerminalOutbox.fetch(request);
    }
    return this.#handler.fetch(request);
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    await Promise.all([
      this.#credentialRelay.alarm(),
      this.#boundaryContext.alarm(),
      this.#developmentTerminalOutbox.alarm(
        now,
        (record) => retryDevelopmentTerminalOutboxRecord(record, this.env, fetch, async (containerId) => {
          await destroyTenantContainer(createTechKnightSandbox(this.env, containerId));
        }),
        (record) => failDevelopmentTerminalOutboxRecord(record, this.env, now, async (containerId) => {
          await destroyTenantContainer(createTechKnightSandbox(this.env, containerId));
        }, (input) => writeDevelopmentTerminalAccounting(this.env, input)),
      ),
    ]);
  }
}

class WorkspaceBase extends DurableObject<WorkspaceEnv> {
  get workspaceStorage(): DurableObjectStorage {
    return this.ctx.storage;
  }
}

export class TechKnightWorkspace extends withWorkspace(
  WorkspaceBase,
  (self) => ({
    // @cloudflare/computer 0.1.1 was published against Workers types v4.
    storage: self.workspaceStorage as unknown as DurableObjectStorageLike,
  }),
) {
  async claimRuntimeEvent(eventId: string): Promise<boolean> {
    return claimRuntimeEvent(this.ctx.storage, eventId);
  }

  async completeRuntimeEvent(eventId: string, responseTs?: string): Promise<void> {
    await completeRuntimeEvent(this.ctx.storage, eventId, responseTs);
  }

  async releaseRuntimeEvent(eventId: string): Promise<void> {
    await releaseRuntimeEvent(this.ctx.storage, eventId);
  }

  async claimDevelopmentCallback(eventId: string,
    payload: DevelopmentCallbackPayload): Promise<DevelopmentCallbackClaim> {
    return claimDevelopmentCallbackState(this.ctx.storage, eventId, payload);
  }

  async recordDevelopmentCallbackDelivery(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void> {
    await recordDevelopmentCallbackDeliveryState(this.ctx.storage, eventId, payload, delivery, fence);
  }

  async completeDevelopmentCallback(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void> {
    await completeDevelopmentCallbackState(this.ctx.storage, eventId, payload, delivery, fence);
  }

  async releaseDevelopmentCallback(eventId: string, payload: DevelopmentCallbackPayload, fence?: number): Promise<void> {
    await releaseDevelopmentCallbackState(this.ctx.storage, eventId, payload, fence);
  }
}

export class MeetingMinutesWorkspace extends withWorkspace(
  WorkspaceBase,
  (self) => ({ storage: self.workspaceStorage as unknown as DurableObjectStorageLike }),
) {}

function workspaceName(event: SlackQueueEvent): string {
  return runtimeWorkspaceName(event);
}

function runtimeErrorCode(error: unknown): string {
  if (error instanceof ReplyPipelineError) return error.code;
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unexpected_error";
}

function meetingMinutesWorkspaceName(tenantId: string, workspaceId: string, runId: string): string {
  return [tenantId, workspaceId, "meeting-minutes", runId].join(":");
}

function meetingMinutesDeploymentGate(env: Env, tenantId = env.TENANT_ID): DurableObjectStub<MeetingMinutesDeploymentGate> {
  return env.MEETING_MINUTES_DEPLOYMENT_GATE.get(env.MEETING_MINUTES_DEPLOYMENT_GATE.idFromName(tenantId));
}

async function enqueueTaskBoardRepairsForProjects(env: Env, projectIds: readonly string[],
  reason: TaskBoardRepairEvent["reason"]): Promise<void> {
  let targets;
  try { targets = taskBoardTargetsForProjects(parseTaskBoardTargets(env.TASK_BOARD_TARGETS_JSON), projectIds); }
  catch (error) { console.error("task_board_targets_invalid", error); return; }
  const results = await Promise.allSettled(targets.map(async (target) => {
    const repair: TaskBoardRepairEvent = {
      eventType: "task_board_repair", targetId: target.targetId, tenantId: "",
      workspaceId: target.workspaceId, channelId: target.channelId, reason,
      requestedAt: new Date().toISOString(),
    };
    await env.TASK_BOARD_REPAIRS.send(await createCanonicalTaskBoardRepairMessage(
      repair,
      (candidate) => resolveTaskBoardRepairTenantContext(env, candidate),
    ));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error("task_board_repair_enqueue_failed", {
      targetId: targets[index]?.targetId, reason, error: result.reason,
    });
  });
}

async function childInteractionEventId(baseEventId: string, effectId: string): Promise<string> {
  if (!effectId.trim()) deny("worker_ingress", "CONFIGURATION_INVALID");
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${baseEventId}:${effectId}`),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `tenant-effect-${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

async function resolveDerivedSlackTenantContext(
  env: Env,
  sourceTenantContext: TenantContextEnvelope,
  identity: TenantInteractionIdentity,
  options: { workspace_policy?: "same_workspace" | "same_tenant" } = {},
): Promise<TenantContextEnvelope> {
  const clients = tenantRuntimeClients(env);
  const resolved = await resolveSlackWorkerIngress({
    identity: { provider: "slack", ...identity },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    authority: clients.authority,
    now: new Date().toISOString(),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  });
  const derived = resolved.tenant_context;
  if (derived.tenant.tenant_id !== sourceTenantContext.tenant.tenant_id
    || (options.workspace_policy !== "same_tenant"
      && derived.workspace_connection.workspace_id !== sourceTenantContext.workspace_connection.workspace_id)
    || derived.placement.deployment_id !== sourceTenantContext.placement.deployment_id
    || derived.placement.profile !== sourceTenantContext.placement.profile) {
    deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
  }
  return derived;
}

function createTenantInteractionEffectResolver(env: Env) {
  const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
    .split(",").map((value) => value.trim()).filter(Boolean);
  const requiredAuthorization = {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
  };
  const clients = tenantRuntimeClients(env);
  const resolve = (identity: TenantInteractionIdentity) => resolveSlackWorkerIngress({
    identity: { provider: "slack", ...identity },
    required_scopes: requiredScopes,
    required_authorization: requiredAuthorization,
    authority: clients.authority,
    now: new Date().toISOString(),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  });
  return async (source: TenantInteractionIdentity): Promise<TenantInteractionEffects> => {
    const sourceResolved = await resolve(source);
    const sourceTenantContext = sourceResolved.tenant_context;
    const resolveEffect = async (effectId: string, target: TenantInteractionTarget) => {
      const identity: TenantInteractionIdentity = {
        ...source,
        ...target,
        event_id: await childInteractionEventId(source.event_id, effectId),
      };
      const resolved = await resolve(identity);
      const tenantContext = resolved.tenant_context;
      if (tenantContext.tenant.tenant_id !== sourceTenantContext.tenant.tenant_id
        || tenantContext.placement.deployment_id !== sourceTenantContext.placement.deployment_id
        || tenantContext.placement.profile !== sourceTenantContext.placement.profile) {
        deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
      }
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
      });
      const expectedScope: ExpectedTenantScope = {
        ...requiredAuthorization,
        workspace_id: identity.workspace_id,
        app_id: identity.app_id,
        channel_id: identity.channel_id,
        thread_ts: identity.thread_ts,
        actor_principal_id: tenantContext.actor.principal_id,
        deployment_id: tenantContext.placement.deployment_id,
      };
      return { tenantContext, verifier, expectedScope, now: new Date().toISOString() };
    };
    const createCredentialFetch = (effect: Awaited<ReturnType<typeof resolveEffect>>) => createTenantCredentialFetch({
      envelope: effect.tenantContext,
      expected_scope: effect.expectedScope,
      broker: clients.credential_broker,
      credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
      credential_relay: env.TENANT_RUNTIME_STATE,
      read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
        effect.tenantContext.workspace_connection.connection_id),
      resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
      now: () => new Date().toISOString(),
    });
    const runBrainbaseWrite = async <T>(effectId: string, target: TenantInteractionTarget,
      execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T> => {
      const effect = await resolveEffect(effectId, target);
      const tenantFetch = createCredentialFetch(effect);
      const perform = async () => ({ outcome: "completed", value: await executeTenantBoundary({
        boundary: "brainbase_proxy",
        tenant_context: effect.tenantContext,
        expected_scope: effect.expectedScope,
        verifier: effect.verifier,
        now: new Date().toISOString(),
        execute: () => execute(tenantFetch),
      }) });
      const result = await executeTenantRuntimeOperation({
        tenant_context: effect.tenantContext,
        expected_scope: effect.expectedScope,
        verifier: effect.verifier,
        quota: clients.quota,
        accounting: clients.accounting,
        ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, effect.tenantContext),
        quota_unit: "interaction_effect",
        now: () => new Date().toISOString(),
        process: perform,
      });
      return result.value;
    };
    return {
      tenant_id: sourceTenantContext.tenant.tenant_id,
      source,
      async durableObject<T>(effectId: string, target: TenantInteractionTarget,
        execute: () => Promise<T>): Promise<T> {
        const effect = await resolveEffect(effectId, target);
        return executeTenantBoundary({ boundary: "durable_object", tenant_context: effect.tenantContext,
          expected_scope: effect.expectedScope, verifier: effect.verifier,
          now: new Date().toISOString(), execute });
      },
      async brainbaseProxy<T>(effectId: string, target: TenantInteractionTarget, mode: "read" | "write",
        execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T> {
        if (mode === "write") return runBrainbaseWrite(effectId, target, execute);
        const effect = await resolveEffect(effectId, target);
        const tenantFetch = createCredentialFetch(effect);
        return executeTenantBoundary({ boundary: "brainbase_proxy", tenant_context: effect.tenantContext,
          expected_scope: effect.expectedScope, verifier: effect.verifier,
          now: new Date().toISOString(), execute: () => execute(tenantFetch) });
      },
      async slackDelivery(effectId: string, target: TenantInteractionTarget, event: unknown,
        execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void> {
        const effect = await resolveEffect(effectId, target);
        const tenantFetch = createCredentialFetch(effect);
        const perform = async () => {
          await postTenantSlackReply({
            tenant_context: effect.tenantContext,
            expected_scope: effect.expectedScope,
            ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE,
              effect.tenantContext.tenant.tenant_id),
            read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
              effect.tenantContext.workspace_connection.connection_id,
            ),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
            now: new Date().toISOString(),
            retention_until: tenantRetentionUntil(new Date().toISOString()),
            event,
            text: `tenant_interaction_effect:${effectId}`,
            effect_id: effectId,
            post: async () => {
              await executeTenantBoundary({ boundary: "slack_delivery", tenant_context: effect.tenantContext,
                expected_scope: effect.expectedScope, verifier: effect.verifier,
                now: new Date().toISOString(), execute: () => execute(tenantFetch) });
              return `interaction_effect:${effect.tenantContext.operation_id}`;
            },
          });
          return { outcome: "completed" };
        };
        await executeTenantRuntimeOperation({
          tenant_context: effect.tenantContext,
          expected_scope: effect.expectedScope,
          verifier: effect.verifier,
          quota: clients.quota,
          accounting: clients.accounting,
          ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, effect.tenantContext),
          quota_unit: "interaction_effect",
          now: () => new Date().toISOString(),
          process: perform,
        });
      },
    };
  };
}

interface MeetingMinutesTenantEffectGuard {
  boundary<T>(boundary: BoundaryName, execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
  slack<T>(effectId: string, event: unknown, execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
  destinationSlack<T>(effectId: string, destination: MeetingMinutesDestination, threadTs: string | undefined,
    event: unknown, execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
}

function createMeetingMinutesTenantEffectGuard(input: {
  env: Env;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
}): MeetingMinutesTenantEffectGuard {
  const clients = tenantRuntimeClients(input.env);
  const createCredentialFetch = (tenantContext: TenantContextEnvelope, expectedScope: ExpectedTenantScope) =>
    createTenantCredentialFetch({
    envelope: tenantContext,
    expected_scope: expectedScope,
    broker: clients.credential_broker,
    credential_registry: createDurableTenantCredentialRegistry(input.env.TENANT_RUNTIME_STATE),
    credential_relay: input.env.TENANT_RUNTIME_STATE,
    read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
      tenantContext.workspace_connection.connection_id),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(input.env, keyId),
    now: input.now,
  });
  const runSlack = async <T>(effectId: string, event: unknown, tenantContext: TenantContextEnvelope,
    expectedScope: ExpectedTenantScope, verifier: TenantRuntimeBoundaryVerifier,
    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T> => {
    let output: T | undefined;
    const credentialFetch = createCredentialFetch(tenantContext, expectedScope);
    const resultRef = await postTenantSlackReply({
      tenant_context: tenantContext,
      expected_scope: expectedScope,
      ownership: createDurableTenantStateClient(input.env.TENANT_RUNTIME_STATE,
        tenantContext.tenant.tenant_id),
      read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
        tenantContext.workspace_connection.connection_id,
      ),
      resolve_verification_key: (keyId) => resolveTenantVerificationKey(input.env, keyId),
      now: input.now(),
      retention_until: tenantRetentionUntil(input.now()),
      event,
      text: `meeting_minutes_effect:${effectId}`,
      effect_id: effectId,
      post: async () => {
        output = await executeTenantBoundary({
          boundary: "slack_delivery",
          tenant_context: tenantContext,
          expected_scope: expectedScope,
          verifier,
          now: input.now(),
          execute: () => execute(credentialFetch),
        });
        return typeof output === "string" && output ? output : `meeting_minutes_effect:${effectId}`;
      },
    });
    return output === undefined ? resultRef as T : output;
  };
  return {
    boundary: (boundary, execute) => {
      const credentialFetch = createCredentialFetch(input.tenant_context, input.expected_scope);
      return executeTenantBoundary({
        boundary,
        tenant_context: input.tenant_context,
        expected_scope: input.expected_scope,
        verifier: input.verifier,
        now: input.now(),
        execute: () => execute(credentialFetch),
      });
    },
    async slack<T>(effectId: string, event: unknown,
      execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T> {
      return runSlack(effectId, event, input.tenant_context, input.expected_scope, input.verifier, execute);
    },
    async destinationSlack<T>(effectId: string, destination: MeetingMinutesDestination, threadTs: string | undefined,
      event: unknown, execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T> {
      let teamIds: Record<string, string>;
      try {
        teamIds = JSON.parse(requiredRuntimeBinding(input.env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON)) as Record<string, string>;
      } catch {
        deny("runtime_configuration", "CONFIGURATION_INVALID");
      }
      const workspaceId = teamIds[destination.organization.id];
      if (!workspaceId) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
      const destinationThreadTs = requiredRuntimeBinding(threadTs ?? input.tenant_context.slack.thread_ts);
      const requesterId = requiredRuntimeBinding(input.tenant_context.slack.requester_id);
      const tenantContext = await resolveDerivedSlackTenantContext(input.env, input.tenant_context, {
        app_id: requiredRuntimeBinding(input.env.SLACK_EXPECTED_APP_ID),
        workspace_id: workspaceId,
        event_id: await childInteractionEventId(input.tenant_context.slack.event_id, effectId),
        channel_id: destination.slackChannelId,
        thread_ts: destinationThreadTs,
        requester_id: requesterId,
      }, { workspace_policy: "same_tenant" });
      const expectedScope: ExpectedTenantScope = {
        audience: requiredRuntimeBinding(input.env.MANA_REQUIRED_AUDIENCE),
        project_id: requiredRuntimeBinding(input.env.MANA_REQUIRED_PROJECT_ID),
        capability_id: requiredRuntimeBinding(input.env.MANA_REQUIRED_CAPABILITY_ID),
        workspace_id: workspaceId,
        app_id: requiredRuntimeBinding(input.env.SLACK_EXPECTED_APP_ID),
        channel_id: destination.slackChannelId,
        thread_ts: destinationThreadTs,
        actor_principal_id: tenantContext.actor.principal_id,
        deployment_id: tenantContext.placement.deployment_id,
      };
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(input.env, keyId),
      });
      return runSlack(effectId, event, tenantContext, expectedScope, verifier, execute);
    },
  };
}

function meetingMinutesClients(
  env: Env,
  effects: MeetingMinutesTenantEffectGuard,
  credentialLeaseHandle?: string,
  tenantBoundaryHandle?: string,
) {
  const injectedCredential = "tenant-credential-injected";
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const destinations = meetingMinutesRuntimeConfig(env).destinations;
  const sourceSlack = (credentialFetch: typeof fetch) => new MeetingMinutesSlackClient(
    injectedCredential, credentialFetch);
  const destinationForChannel = (channelId: string) => {
    const destination = destinations.find((candidate) => candidate.slackChannelId === channelId);
    if (!destination) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
    return destination;
  };
  const destinationSlack = (destination: MeetingMinutesDestination, credentialFetch: typeof fetch) => {
    if (!destinations.some((candidate) => candidate.id === destination.id
      && candidate.slackChannelId === destination.slackChannelId)) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
    return new MeetingMinutesSlackClient(injectedCredential, credentialFetch);
  };
  const taskClient = (credentialFetch: typeof fetch) => new TaskApiClient({
    baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
    token: injectedCredential,
    fetchImpl: credentialFetch,
  });
  const contextMode = resolveMeetingMinutesContextMode(env.MEETING_MINUTES_CONTEXT_MODE);
  return {
    slack: {
      updateRunStatus: (run: MeetingMinutesRun,
        outcome: Parameters<MeetingMinutesSlackClient["updateRunStatus"]>[1]) =>
        effects.slack(`source-status:${run.runId}:${outcome}`,
          { kind: "source_status", runId: run.runId, outcome },
          (credentialFetch) => sourceSlack(credentialFetch).updateRunStatus(run, outcome)),
      downloadTextFile: (fileId: string) => effects.boundary("slack_delivery",
        (credentialFetch) => sourceSlack(credentialFetch).downloadTextFile(fileId)),
      requestDestination: (run: MeetingMinutesRun,
        candidates: Parameters<MeetingMinutesSlackClient["requestDestination"]>[1]) =>
        effects.slack(`destination-request:${run.runId}`,
          { kind: "destination_request", runId: run.runId },
          (credentialFetch) => sourceSlack(credentialFetch).requestDestination(run, candidates)),
    },
    classify: (transcript: string, candidates: Parameters<typeof classifyMeetingMinutesDestinationInSandbox>[1]) => {
      if (!credentialLeaseHandle) throw new Error("credential_lease_required");
      return effects.boundary("container_launch", () => classifyMeetingMinutesDestinationInSandbox(
        transcript, candidates, claudeRuntime,
        createTechKnightSandbox(env, `meeting-minutes-routing-${crypto.randomUUID()}`),
        credentialLeaseHandle, tenantBoundaryHandle));
    },
    resume: {
      contextMode,
      resolveContext: (identity: Parameters<MeetingMinutesBrainbaseContextClient["resolve"]>[0], receiptId?: string) =>
        effects.boundary("brainbase_proxy", (credentialFetch) => new MeetingMinutesBrainbaseContextClient(
          env.BRAINBASE_TASK_API_BASE_URL ?? "", injectedCredential, credentialFetch).resolve(identity, receiptId)),
      postProcessingStatus: (run: MeetingMinutesRun) => effects.slack(`processing-status:${run.runId}`,
        { kind: "processing_status", runId: run.runId },
        (credentialFetch) => sourceSlack(credentialFetch).postProcessingStatus(run)),
      download: (fileId: string) => effects.boundary("slack_delivery",
        (credentialFetch) => sourceSlack(credentialFetch).downloadTextFile(fileId)),
      generate: (transcript: string, destination: MeetingMinutesDestination,
        context: Parameters<typeof generateMeetingMinutesInSandbox>[2], mode: Parameters<typeof generateMeetingMinutesInSandbox>[3]) => {
        if (!credentialLeaseHandle) throw new Error("credential_lease_required");
        return effects.boundary("container_launch", () => generateMeetingMinutesInSandbox(
          transcript, destination, context, mode, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`),
          credentialLeaseHandle, tenantBoundaryHandle));
      },
      saveGitHub: (input: Parameters<CloudflareMeetingMinutesGitHubClient["save"]>[0]) =>
        effects.boundary("mcp_gateway", (credentialFetch) => new CloudflareMeetingMinutesGitHubClient(
          injectedCredential, credentialFetch).save(input)),
      createTask: async (input: Parameters<TaskApiClient["createTask"]>[0], idempotencyKey: string) => {
        return effects.boundary("brainbase_proxy",
          (credentialFetch) => taskClient(credentialFetch).createTask(input, idempotencyKey));
      },
      // Destination project IDs belong to the task destination contract and are
      // not Graph person scopes. Resolve globally, then let non-unique names
      // fail closed in resolveGraphPersonByName.
      resolveAssignee: (name: string, _projectId: string) => effects.boundary("brainbase_proxy", (credentialFetch) =>
        resolveGraphPersonByName(name, undefined, {
          baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
          token: injectedCredential,
          fetch: credentialFetch,
        })),
      postParent: (channelId: string, fileName: string, summary: string, clientMsgId: string) =>
        effects.destinationSlack(`destination-parent:${clientMsgId}`, destinationForChannel(channelId), undefined,
          { kind: "destination_parent", channelId, clientMsgId },
          (credentialFetch) => destinationSlack(destinationForChannel(channelId), credentialFetch).postParent(
            channelId, fileName, summary, clientMsgId)),
      postTaskCard: (run: MeetingMinutesRun) => effects.destinationSlack(`task-card:${run.runId}`,
        run.destination!, run.slack?.parentTs,
        { kind: "task_card", runId: run.runId, channelId: run.destination!.slackChannelId },
        (credentialFetch) => destinationSlack(run.destination!, credentialFetch).postTaskCard(run)),
      repairTaskBoard: (projectCodes: readonly string[]) =>
        effects.boundary("durable_object", () => enqueueTaskBoardRepairsForProjects(env, projectCodes, "task_write")),
      postThreadChunk: (channelId: string, threadTs: string, fileName: string, text: string,
        index: number, total: number, clientMsgId: string) =>
        effects.destinationSlack(`destination-thread:${clientMsgId}:${index}`, destinationForChannel(channelId), threadTs,
          { kind: "destination_thread", channelId, threadTs, clientMsgId, index, total },
          (credentialFetch) => destinationSlack(destinationForChannel(channelId), credentialFetch).postThreadChunk(
            channelId, threadTs, fileName, text, index, total, clientMsgId)),
    },
    redo: {
      deleteGitHub: (destination: MeetingMinutesDestination, paths: readonly string[]) =>
        effects.boundary("mcp_gateway", (credentialFetch) => new CloudflareMeetingMinutesGitHubClient(
          injectedCredential, credentialFetch).delete(destination.github, paths)),
      deleteTask: async (taskId: string, idempotencyKey: string) => {
        await effects.boundary("brainbase_proxy", async (credentialFetch) => {
          const client = taskClient(credentialFetch);
          try {
            const task = await client.getTask(taskId);
            await client.deleteTask(taskId, task.version, idempotencyKey);
          } catch (error) {
            if (error instanceof TaskApiError && error.status === 404) return;
            throw error;
          }
        });
      },
      retractSharedMinutes: (destination: MeetingMinutesDestination,
        parentTs: string, fileName: string) =>
        effects.destinationSlack(`retract:${parentTs}`, destination, parentTs,
          { kind: "minutes_retract", channelId: destination.slackChannelId, parentTs },
          (credentialFetch) => destinationSlack(destination, credentialFetch).retractSharedMinutes(
            destination.slackChannelId, parentTs, fileName)),
      showDestinationSelection: (run: MeetingMinutesRun,
        destinations: Parameters<MeetingMinutesSlackClient["showDestinationSelection"]>[1]) =>
        effects.slack(`destination-selection:${run.runId}`,
          { kind: "destination_selection", runId: run.runId },
          (credentialFetch) => sourceSlack(credentialFetch).showDestinationSelection(run, destinations)),
    },
  };
}

function requiredRuntimeBinding(value: string | undefined): string {
  if (!value?.trim()) deny("runtime_configuration", "CONFIGURATION_INVALID");
  return value;
}

interface SerializableHttpResponse {
  ok: boolean;
  status: number;
  content_type: string;
  body: string;
}

async function serializableResponse(response: Response): Promise<SerializableHttpResponse> {
  return {
    ok: response.ok,
    status: response.status,
    content_type: response.headers.get("content-type") ?? "application/json; charset=utf-8",
    body: await response.text(),
  };
}

function restoreSerializableResponse(response: SerializableHttpResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.content_type },
  });
}

function tenantDeploymentProfile(env: Env): DeploymentProfileName {
  const profile = requiredRuntimeBinding(env.MANA_DEPLOYMENT_PROFILE);
  if (profile !== "shared_cloud" && profile !== "dedicated_cloud" && profile !== "customer_managed_oss") {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  const capabilities = new Set(requiredRuntimeBinding(env.MANA_RUNTIME_CAPABILITIES)
    .split(",").map((value) => value.trim()).filter(Boolean));
  const missing = REQUIRED_TENANT_CAPABILITIES.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) deny("runtime_configuration", "PROTOCOL_CAPABILITY_UNSUPPORTED", { missing });
  return profile;
}

function tenantRuntimeClients(env: Env) {
  return createTenantRuntimeHttpClients({
    deployment_profile: tenantDeploymentProfile(env),
    tenant_authority_url: requiredRuntimeBinding(env.BRAINBASE_TENANT_AUTHORITY_URL),
    credential_broker_url: requiredRuntimeBinding(env.BRAINBASE_CREDENTIAL_BROKER_URL),
    quota_url: requiredRuntimeBinding(env.BRAINBASE_QUOTA_URL),
    accounting_url: requiredRuntimeBinding(env.BRAINBASE_ACCOUNTING_URL),
    api_token: requiredRuntimeBinding(env.BRAINBASE_RUNTIME_API_TOKEN),
    timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
  });
}

async function writeDevelopmentTerminalAccounting(env: Env, input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  artifact: AccountingArtifact;
}): Promise<{ result_ref: string }> {
  const clients = tenantRuntimeClients(env);
  const artifactContext = input.tenant_context;
  const snapshot = await clients.authority.read_workspace_connection(
    artifactContext.workspace_connection.connection_id,
  );
  const authorizationContext = await clients.authority.issue_tenant_context({
    workspace_connection: snapshot,
    slack: {
      event_id: artifactContext.slack.event_id,
      channel_id: artifactContext.slack.channel_id,
      thread_ts: artifactContext.slack.thread_ts ?? "",
      requester_id: artifactContext.slack.requester_id
        ?? artifactContext.actor.authenticated_subject_id,
      ...(artifactContext.slack.enterprise_id
        ? { enterprise_id: artifactContext.slack.enterprise_id }
        : {}),
    },
    required_authorization: {
      audience: input.expected_scope.audience,
      project_id: input.expected_scope.project_id,
      capability_id: input.expected_scope.capability_id,
    },
  });
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  });
  return writeTenantAccountingContinuation({
    authorization_context: authorizationContext,
    artifact_context: artifactContext,
    expected_scope: input.expected_scope,
    now: new Date().toISOString(),
    verifier,
    artifact: input.artifact,
    write: clients.accounting.write,
  });
}

async function resolveTaskBoardRepairTenantContext(
  env: Env,
  repair: TaskBoardRepairEvent,
): Promise<TenantContextEnvelope> {
  const clients = tenantRuntimeClients(env);
  const resolved = await resolveSlackWorkerIngress({
    identity: {
      provider: "slack",
      app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
      workspace_id: repair.workspaceId,
      event_id: taskBoardRepairEventId(repair),
      channel_id: repair.channelId,
      thread_ts: repair.requestedAt,
      requester_id: requiredRuntimeBinding(env.MANA_TASK_BOARD_SERVICE_ACTOR_ID),
    },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    authority: clients.authority,
    now: repair.requestedAt,
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  });
  return resolved.tenant_context;
}

async function resolveTenantVerificationKey(env: Env, keyId: string): Promise<CryptoKey | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredRuntimeBinding(env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON));
  } catch {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Array.isArray((parsed as { keys?: unknown }).keys)
    ? (parsed as { keys: JsonWebKey[] }).keys
    : [];
  const matches = keys.filter((key) => (key as JsonWebKey & { kid?: string }).kid === keyId
    && key.kty === "OKP" && key.crv === "Ed25519"
    && (key.use === undefined || key.use === "sig"));
  if (matches.length !== 1) return undefined;
  try {
    return await crypto.subtle.importKey("jwk", matches[0], { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return undefined;
  }
}

function isTenantSlackQueueBody(value: unknown): value is TenantQueueBody<SlackQueueEvent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<TenantQueueBody<SlackQueueEvent>>;
  const payload = body.payload as Partial<SlackQueueEvent> | undefined;
  return body.schema_version === "1.0" && !!body.tenant_context && !!payload
    && typeof payload.tenantId === "string" && typeof payload.eventId === "string"
    && typeof payload.workspaceId === "string" && typeof payload.channelId === "string"
    && typeof payload.threadTs === "string" && typeof payload.eventType === "string";
}

function isTenantTaskBoardRepairBody(value: unknown): value is TenantQueueBody<TaskBoardRepairEvent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<TenantQueueBody<TaskBoardRepairEvent>>;
  const payload = body.payload as Partial<TaskBoardRepairEvent> | undefined;
  return body.schema_version === "1.0" && !!body.tenant_context && !!payload
    && payload.eventType === "task_board_repair" && typeof payload.tenantId === "string"
    && typeof payload.targetId === "string" && typeof payload.workspaceId === "string"
    && typeof payload.channelId === "string" && typeof payload.requestedAt === "string";
}

function isTenantMeetingMinutesSelectionBody(value: unknown): value is TenantQueueBody<MeetingMinutesSelection> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<TenantQueueBody<MeetingMinutesSelection>>;
  return body.schema_version === "1.0" && !!body.tenant_context && isMeetingMinutesSelection(body.payload);
}

function isTenantMeetingMinutesRedoBody(value: unknown): value is TenantQueueBody<MeetingMinutesRedo> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<TenantQueueBody<MeetingMinutesRedo>>;
  return body.schema_version === "1.0" && !!body.tenant_context && isMeetingMinutesRedo(body.payload);
}

function isTenantMeetingMinutesRecoveryBody(value: unknown): value is TenantQueueBody<MeetingMinutesRecovery> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<TenantQueueBody<MeetingMinutesRecovery>>;
  return body.schema_version === "1.0" && !!body.tenant_context && isMeetingMinutesRecovery(body.payload);
}

function meetingMinutesSelectionEventId(selection: MeetingMinutesSelection): string {
  return `meeting_minutes_selection:${selection.runId}:${selection.actionTs}`;
}

function meetingMinutesRedoEventId(command: MeetingMinutesRedo): string {
  return `meeting_minutes_redo:${command.runId}:${command.actionTs}`;
}

function meetingMinutesRecoveryEventId(recovery: MeetingMinutesRecovery): string {
  return `meeting_minutes_recovery:${recovery.runId}:${recovery.actionTs}`;
}

function expectedTenantMeetingMinutesSelectionScope(
  env: Env,
  body: TenantQueueBody<MeetingMinutesSelection>,
): ExpectedTenantScope {
  const selection = body.payload;
  const envelope = body.tenant_context;
  if (selection.workspaceId !== envelope.workspace_connection.workspace_id
    || selection.appId !== envelope.workspace_connection.app_id
    || selection.channelId !== envelope.slack.channel_id
    || selection.threadTs !== envelope.slack.thread_ts
    || meetingMinutesSelectionEventId(selection) !== envelope.slack.event_id
    || selection.userId !== envelope.actor.authenticated_subject_id
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: selection.workspaceId,
    app_id: selection.appId,
    channel_id: selection.channelId,
    thread_ts: selection.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: envelope.placement.deployment_id,
  };
}

function expectedTenantMeetingMinutesRedoScope(
  env: Env,
  body: TenantQueueBody<MeetingMinutesRedo>,
): ExpectedTenantScope {
  const command = body.payload;
  const envelope = body.tenant_context;
  if (command.workspaceId !== envelope.workspace_connection.workspace_id
    || command.appId !== envelope.workspace_connection.app_id
    || command.channelId !== envelope.slack.channel_id
    || command.threadTs !== envelope.slack.thread_ts
    || meetingMinutesRedoEventId(command) !== envelope.slack.event_id
    || command.userId !== envelope.actor.authenticated_subject_id
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: command.workspaceId,
    app_id: command.appId,
    channel_id: command.channelId,
    thread_ts: command.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: envelope.placement.deployment_id,
  };
}

function expectedTenantMeetingMinutesRecoveryScope(
  env: Env,
  body: TenantQueueBody<MeetingMinutesRecovery>,
): ExpectedTenantScope {
  const recovery = body.payload;
  const envelope = body.tenant_context;
  if (recovery.workspaceId !== envelope.workspace_connection.workspace_id
    || recovery.appId !== envelope.workspace_connection.app_id
    || recovery.channelId !== envelope.slack.channel_id
    || recovery.threadTs !== envelope.slack.thread_ts
    || meetingMinutesRecoveryEventId(recovery) !== envelope.slack.event_id
    || recovery.userId !== envelope.actor.authenticated_subject_id
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: recovery.workspaceId,
    app_id: recovery.appId,
    channel_id: recovery.channelId,
    thread_ts: recovery.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: envelope.placement.deployment_id,
  };
}

function expectedTenantQueueScope(env: Env, body: TenantQueueBody<SlackQueueEvent>): ExpectedTenantScope {
  const event = body.payload;
  const envelope = body.tenant_context;
  if (event.tenantId !== envelope.tenant.tenant_id
    || event.workspaceId !== envelope.workspace_connection.workspace_id
    || event.channelId !== envelope.slack.channel_id
    || event.threadTs !== envelope.slack.thread_ts
    || event.eventId !== envelope.slack.event_id
    || event.userId !== envelope.actor.authenticated_subject_id
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: event.workspaceId,
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
    channel_id: event.channelId,
    thread_ts: event.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: envelope.placement.deployment_id,
  };
}

function expectedTenantTaskBoardRepairScope(
  env: Env,
  body: TenantQueueBody<TaskBoardRepairEvent>,
): ExpectedTenantScope {
  const repair = body.payload;
  const envelope = body.tenant_context;
  if (repair.tenantId !== envelope.tenant.tenant_id
    || repair.workspaceId !== envelope.workspace_connection.workspace_id
    || repair.channelId !== envelope.slack.channel_id
    || repair.requestedAt !== envelope.slack.thread_ts
    || taskBoardRepairEventId(repair) !== envelope.slack.event_id
    || envelope.actor.authenticated_subject_id !== requiredRuntimeBinding(env.MANA_TASK_BOARD_SERVICE_ACTOR_ID)
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: repair.workspaceId,
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
    channel_id: repair.channelId,
    thread_ts: repair.requestedAt,
    actor_principal_id: envelope.actor.principal_id,
    project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: envelope.placement.deployment_id,
  };
}

async function tenantPayloadHash(payload: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(payload)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function tenantRetentionUntil(now: string): string {
  const observedAt = Date.parse(now);
  if (!Number.isFinite(observedAt)) deny("queue_consumer", "TIME_INVALID");
  return new Date(observedAt + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

async function processTenantMeetingMinutesSelection(input: {
  env: Env;
  config: ReturnType<typeof meetingMinutesRuntimeConfig>;
  selection: MeetingMinutesSelection;
  tenantContext: TenantContextEnvelope;
  expectedScope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
  credentialLeaseHandle: string;
  tenantBoundaryHandle: string;
}): Promise<{ outcome: "completed" }> {
  const {
    env,
    config,
    selection,
    tenantContext,
    expectedScope,
    verifier,
    now,
    credentialLeaseHandle,
    tenantBoundaryHandle,
  } = input;
  const tenantId = tenantContext.tenant.tenant_id;
  const effects = createMeetingMinutesTenantEffectGuard({
    env,
    tenant_context: tenantContext,
    expected_scope: expectedScope,
    verifier,
    now,
  });
  await effects.boundary("durable_object", async () => {
    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
      tenantId, selection.workspaceId, selection.runId,
    ));
    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
      const clients = meetingMinutesClients(env, effects, credentialLeaseHandle, tenantBoundaryHandle);
      const armed = await armMeetingMinutesRecovery(workspace.fs, selection);
      if (!armed.terminal) {
        const recoveryTenantContext = await resolveDerivedSlackTenantContext(env, tenantContext, {
          app_id: armed.event.appId,
          workspace_id: armed.event.workspaceId,
          event_id: meetingMinutesRecoveryEventId(armed.event),
          channel_id: armed.event.channelId,
          thread_ts: armed.event.threadTs,
          requester_id: armed.event.userId,
        });
        await meetingMinutesDeploymentGate(env, tenantId).markActive({ runId: selection.runId,
          startedAt: now(),
          deadlineAt: new Date(Date.parse(now()) + armed.delaySeconds * 1_000).toISOString() });
        await env.TECHKNIGHT_EVENTS.send({
          schema_version: "1.0",
          tenant_context: recoveryTenantContext,
          payload: armed.event,
        }, {
          delaySeconds: Math.min(armed.delaySeconds, MEETING_MINUTES_RECOVERY_DELAY_SECONDS),
        });
      }
      try {
        await processMeetingMinutesSelectionWithStatus(workspace.fs, selection, config, clients.resume, {
          updateStatus: (run, outcome) => clients.slack.updateRunStatus(run, outcome),
          logProjectionError: (entry) => console.warn(JSON.stringify({
            event: "meeting_minutes_status_projection_failed", ...entry,
          })),
        });
      } catch (error) {
        const persisted = await loadMeetingMinutesRun(workspace.fs, selection.runId);
        if (persisted?.status === "completed" || persisted?.lifecycle?.recoveryProjectedAt) {
          await meetingMinutesDeploymentGate(env, tenantId).markTerminal(selection.runId);
        }
        throw error;
      }
    });
  });
  await meetingMinutesDeploymentGate(env, tenantId).markTerminal(selection.runId);
  return { outcome: "completed" };
}

async function processTenantMeetingMinutesRecovery(input: {
  env: Env;
  recovery: MeetingMinutesRecovery;
  tenantContext: TenantContextEnvelope;
  expectedScope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
}): Promise<{ outcome: "recovered" | "terminal" | "superseded" }> {
  const { env, recovery, tenantContext, expectedScope, verifier, now } = input;
  const effects = createMeetingMinutesTenantEffectGuard({
    env,
    tenant_context: tenantContext,
    expected_scope: expectedScope,
    verifier,
    now,
  });
  return effects.boundary("durable_object", async () => {
      const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        tenantContext.tenant.tenant_id, recovery.workspaceId, recovery.runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
      return withDisposableResource(() => getWorkspace(handle), async (workspace) => {
        const outcome = await recoverStaleMeetingMinutesRun(workspace.fs, recovery, {
          now: () => Date.parse(now()),
          updateStatus: (run) => meetingMinutesClients(env, effects).slack.updateRunStatus(run, "failed"),
        });
        if (outcome === "not_due") deny("queue_consumer", "UPSTREAM_UNAVAILABLE");
        await meetingMinutesDeploymentGate(env, tenantContext.tenant.tenant_id).markTerminal(recovery.runId);
        return { outcome };
      });
  });
}

async function processTenantMeetingMinutesRedo(input: {
  env: Env;
  config: ReturnType<typeof meetingMinutesRuntimeConfig>;
  command: MeetingMinutesRedo;
  tenantContext: TenantContextEnvelope;
  expectedScope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
  credentialLeaseHandle: string;
  tenantBoundaryHandle: string;
}): Promise<{ outcome: "completed" }> {
  const {
    env,
    config,
    command,
    tenantContext,
    expectedScope,
    verifier,
    now,
    credentialLeaseHandle,
    tenantBoundaryHandle,
  } = input;
  const effects = createMeetingMinutesTenantEffectGuard({
    env,
    tenant_context: tenantContext,
    expected_scope: expectedScope,
    verifier,
    now,
  });
  await effects.boundary("durable_object", async () => {
    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
      tenantContext.tenant.tenant_id, command.workspaceId, command.runId,
    ));
    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
      const clients = meetingMinutesClients(env, effects, credentialLeaseHandle, tenantBoundaryHandle);
      await processMeetingMinutesRedo(workspace.fs, command, config, clients.redo);
    });
  });
  return { outcome: "completed" };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const readiness = assessTenantRuntimeReadiness(env as unknown as Record<string, unknown>);
      return Response.json({
        ok: readiness.ready,
        tenant_runtime: readiness,
        tenant: env.TENANT_ID,
        meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
        taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED === "true",
        taskWriteEnabled: env.RUNTIME_TASK_WRITE_ENABLED === "true",
        taskBoardEnabled: env.RUNTIME_TASK_BOARD_ENABLED === "true",
        meetingMinutesEnabled: env.MEETING_MINUTES_ENABLED === "true",
      }, { status: readiness.ready ? 200 : 503 });
    }
    if (url.pathname === "/internal/slack/installations/lifecycle") {
      let clients;
      try {
        clients = tenantRuntimeClients(env);
      } catch {
        return Response.json({ error: "CONFIGURATION_INVALID" }, { status: 503 });
      }
      return handleSlackInstallationLifecycleRequest(request, {
        token: env.SLACK_INSTALLATION_LIFECYCLE_TOKEN,
        adapter: new SlackInstallationAdapter(clients.workspace_connections),
      });
    }
    if (url.pathname.startsWith("/admin/sandbox/")) {
      return handleSandboxAdminRequest(request, env, {
        createSandbox: (id) => createTechKnightSandbox(env, id),
      });
    }
    if (request.method === "GET" && url.pathname === "/admin/meeting-minutes/deploy-gate") {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(await meetingMinutesDeploymentGate(env).status());
    }
    if (request.method === "POST" && url.pathname === "/development/callback") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const callbackBoundary = await resolveDurableTenantBoundaryContext(
        env.TENANT_RUNTIME_STATE,
        request,
        ["mcp_gateway", "brainbase_proxy"],
        new Date().toISOString(),
      );
      if (callbackBoundary instanceof Response) return callbackBoundary;
      const callbackClients = tenantRuntimeClients(env);
      const callbackVerifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => callbackClients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
      });
      let callbackWorkspace: DurableObjectStub<TechKnightWorkspace> | undefined;
      return handleDevelopmentCallback(request, {
        token: env.DEVELOPMENT_CALLBACK_TOKEN, placements,
        resolve: async (event) => {
          if (event.workspaceId !== callbackBoundary.tenant_context.workspace_connection.workspace_id
            || event.channelId !== callbackBoundary.tenant_context.slack.channel_id
            || event.threadTs !== callbackBoundary.tenant_context.slack.thread_ts
            || event.userId !== callbackBoundary.tenant_context.actor.authenticated_subject_id) {
            deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
          }
          await callbackVerifier.validate({
            boundary: "worker_ingress",
            tenant_context: callbackBoundary.tenant_context,
            expected_scope: callbackBoundary.expected_scope,
            now: event.receivedAt,
          });
          return { ...event, tenantId: callbackBoundary.tenant_context.tenant.tenant_id };
        },
        claim: async (event, payload) => {
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          callbackWorkspace = env.TECHKNIGHT_WORKSPACE.get(id);
          return callbackWorkspace.claimDevelopmentCallback(event.eventId, payload);
        },
        recordDelivery: async (eventId, payload, delivery, fence) => {
          if (!callbackWorkspace) throw new Error("development_callback_workspace_missing");
          await callbackWorkspace.recordDevelopmentCallbackDelivery(eventId, payload, delivery, fence);
        },
        complete: async (eventId, payload, delivery, fence) => {
          if (!callbackWorkspace) throw new Error("development_callback_workspace_missing");
          const terminal = payload.status === "failed"
            ? { outcome: "failed" as const, failureCode: "DEVELOPMENT_RUNNER_FAILED" }
            : payload.status === "timed_out"
              ? { outcome: "timed_out" as const, failureCode: "DEVELOPMENT_RUNNER_TIMED_OUT" }
              : { outcome: "succeeded" as const, failureCode: null };
          await recordTenantRuntimeTerminalOperation({
            tenant_context: callbackBoundary.tenant_context,
            expected_scope: callbackBoundary.expected_scope,
            verifier: callbackVerifier,
            accounting: callbackClients.accounting,
            ledger: createDurableTenantAccountingClient(
              env.TENANT_RUNTIME_STATE,
              callbackBoundary.tenant_context,
            ),
            quota_decision: payload.quota_decision,
            unit: "container_seconds",
            outcome: terminal.outcome,
            failure_code: terminal.failureCode,
            ...(delivery.state === "delivered" ? { response_ts: delivery.responseTs } : { reply_state: "failed" as const }),
            now: new Date().toISOString(),
            accounting_effect_id: `development_terminal:${payload.job_id}`,
          });
          await callbackWorkspace.completeDevelopmentCallback(eventId, payload, delivery, fence);
        },
        release: async (eventId, payload, fence) => {
          if (!callbackWorkspace) return;
          await callbackWorkspace.releaseDevelopmentCallback(eventId, payload, fence);
        },
        post: (event, text) => {
          if (event.tenantId !== callbackBoundary.tenant_context.tenant.tenant_id) {
            deny("slack_delivery", "CROSS_TENANT_CANDIDATE");
          }
          const now = new Date().toISOString();
          const tenantCredentialFetch = createTenantCredentialFetch({
            envelope: callbackBoundary.tenant_context,
            expected_scope: callbackBoundary.expected_scope,
            broker: callbackClients.credential_broker,
            credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
            credential_relay: env.TENANT_RUNTIME_STATE,
            read_authoritative_snapshot: () => callbackClients.authority.read_workspace_connection(
              callbackBoundary.tenant_context.workspace_connection.connection_id),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
            now: () => new Date().toISOString(),
          });
          return postTenantSlackReply({
            tenant_context: callbackBoundary.tenant_context,
            expected_scope: callbackBoundary.expected_scope,
            ownership: createDurableTenantStateClient(
              env.TENANT_RUNTIME_STATE,
              callbackBoundary.tenant_context.tenant.tenant_id,
            ),
            read_authoritative_snapshot: () => callbackClients.authority.read_workspace_connection(
              callbackBoundary.tenant_context.workspace_connection.connection_id,
            ),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
            now,
            retention_until: tenantRetentionUntil(now),
            event,
            text,
            effect_id: `development_delivery:${event.eventId}`,
            post: () => postSlackReply(event, text, {
              slackBotToken: "tenant-credential-injected",
              fetch: tenantCredentialFetch,
            }),
          });
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      const config = meetingMinutesRuntimeConfig(env);
      return handleMeetingMinutesInteractionEntrypoint(request, env, ctx, config.operatorUserIds,
        async ({ approvalId, payloadHash, approverId, channelId }, effects) => {
          const approvalChannelId = env.TASK_WRITE_APPROVAL_CHANNEL_ID ?? env.SLACK_ALLOWED_CHANNEL_ID;
          if (channelId !== approvalChannelId) return Response.json({ error: "task_write_approval_channel_mismatch" }, { status: 403 });
          const pending = await effects.durableObject(`task-approval-peek:${approvalId}`, {},
            () => peekTaskWriteApproval(env.TASK_WRITE_APPROVALS, approvalId));
          if (pending.payloadHash !== payloadHash) return Response.json({ error: "task_write_approval_payload_mismatch" }, { status: 403 });
          const approved = await effects.brainbaseProxy(`task-approval-execute:${approvalId}`, {}, "write",
            async (tenantFetch) => serializableResponse(await createTaskWriteProxyHandler(tenantFetch)(new Request(
              "https://task-write.internal/api/task-write", {
              method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": pending.capability,
                "x-mana-task-write-approval-id": approvalId, "x-mana-task-write-approver-id": approverId },
              body: JSON.stringify(pending.body),
            }), { ...env, BRAINBASE_TASK_API_TOKEN: "tenant-credential-injected",
              SLACK_BOT_TOKEN: "tenant-credential-injected" })));
          if (!approved.ok) return restoreSerializableResponse(approved);
          return Response.json({ ok: true, approval_id: approvalId });
        }, undefined, async (payload, effects) => {
          const parsedTeamIds = (() => { try { return JSON.parse(env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON ?? "{}") as Record<string, string>; }
            catch { return {}; } })();
          const sourceTarget = (source: MeetingMinutesSourceIdentity): TenantInteractionTarget => ({
            workspace_id: source.workspaceId,
            app_id: source.appId,
            channel_id: source.channelId,
            thread_ts: source.threadTs,
          });
          const loadWorkspace = async <T>(source: MeetingMinutesSourceIdentity, runId: string, operationName: string,
            operation: (workspace: { fs: Parameters<typeof loadMeetingMinutesRun>[0] }) => Promise<T>) => {
            const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
              effects.tenant_id, source.workspaceId, runId));
            const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
            return effects.durableObject(`meeting-run:${operationName}:${runId}`, sourceTarget(source),
              () => withDisposableResource(() => getWorkspace(handle), operation));
          };
          const taskClient = (tenantFetch: typeof fetch) => new TaskApiClient({
            baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
            token: "tenant-credential-injected",
            fetchImpl: tenantFetch,
          });
          let cachedRun: MeetingMinutesRun | undefined;
          let cachedSource: MeetingMinutesSourceIdentity | undefined;
          const canonicalSource = (): MeetingMinutesSourceIdentity => {
            if (!cachedRun || !cachedSource || cachedRun.workspaceId !== cachedSource.workspaceId ||
              cachedRun.sourceAppId !== cachedSource.appId || cachedRun.sourceChannelId !== cachedSource.channelId ||
              cachedRun.sourceThreadTs !== cachedSource.threadTs) deny("brainbase_proxy", "CROSS_TENANT_CANDIDATE");
            return cachedSource;
          };
          return handleMeetingMinutesTaskAction(payload, {
            destinationTeamIds: parsedTeamIds,
            operatorUserIds: config.operatorUserIds,
            loadRun: async (runId, source) => {
              cachedRun = await loadWorkspace(source, runId, "load",
                (workspace) => loadMeetingMinutesRun(workspace.fs, runId));
              cachedSource = source;
              return cachedRun;
            },
            saveRun: (run) => loadWorkspace(canonicalSource(), run.runId, "save",
              async (workspace) => { await saveMeetingMinutesRun(workspace.fs, run); }),
            getTask: (taskId) => effects.brainbaseProxy(`task-read:${taskId}`, sourceTarget(canonicalSource()), "read",
              (tenantFetch) => taskClient(tenantFetch).getTask(taskId)),
            updateTask: (taskId, input, key) => effects.brainbaseProxy(
              `task-update:${key}`, sourceTarget(canonicalSource()), "write",
              (tenantFetch) => taskClient(tenantFetch).updateTask(taskId, input, key)),
            deleteTask: (taskId, version, key) => effects.brainbaseProxy(
              `task-delete:${key}`, sourceTarget(canonicalSource()), "write",
              (tenantFetch) => taskClient(tenantFetch).deleteTask(taskId, version, key)),
            updateCard: async (run) => {
              await effects.slackDelivery(`task-card:${run.runId}`, {
                channel_id: run.destination!.slackChannelId,
              }, { kind: "task_card", runId: run.runId },
              (tenantFetch) => new MeetingMinutesSlackClient(
                "tenant-credential-injected", tenantFetch).updateTaskCard(run));
            },
            openView: async (organizationId, triggerId, view) => {
              await effects.slackDelivery(`task-edit-view:${organizationId}`, {},
                { kind: "task_edit_view", organizationId },
                (tenantFetch) => new MeetingMinutesSlackClient(
                  "tenant-credential-injected", tenantFetch).openTaskEditView(triggerId, view));
            },
            listPeople: () => effects.brainbaseProxy(
              "task-assignee-list", sourceTarget(canonicalSource()), "read",
              (tenantFetch) => listGraphPeople(undefined, {
                baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
                token: "tenant-credential-injected",
                fetch: tenantFetch,
              })),
            repairTaskBoard: (projectCodes) => effects.durableObject(
              `task-board-repair:${[...projectCodes].sort().join(",")}`,
              sourceTarget(canonicalSource()),
              () => enqueueTaskBoardRepairsForProjects(env, projectCodes, "task_write"),
            ),
            defer: (work) => ctx.waitUntil(work),
          });
        }, async (command) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const resolved = await resolveSlackWorkerIngress({
            identity: {
              provider: "slack",
              app_id: command.appId,
              workspace_id: command.workspaceId,
              event_id: command.kind === "meeting_minutes_selection"
                ? meetingMinutesSelectionEventId(command)
                : meetingMinutesRedoEventId(command),
              channel_id: command.channelId,
              thread_ts: command.threadTs,
              requester_id: command.userId,
            },
            required_scopes: requiredScopes,
            required_authorization: {
              audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
              project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
              capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
            },
            authority: clients.authority,
            now: new Date().toISOString(),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          return command.kind === "meeting_minutes_selection"
            ? env.TECHKNIGHT_EVENTS.send({
                schema_version: "1.0",
                tenant_context: resolved.tenant_context,
                payload: command,
              })
            : env.TECHKNIGHT_EVENTS.send({
                schema_version: "1.0",
                tenant_context: resolved.tenant_context,
                payload: command,
              });
        }, createTenantInteractionEffectResolver(env));
    }
    if (request.method === "POST" && url.pathname === "/slack/commands") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const developmentPlacements = placements.filter((placement) => placement.developmentEnabled === true);
      return handleSlackCommandRequest(request, { signingSecret: env.SLACK_SIGNING_SECRET,
        placements: developmentPlacements.map((placement) => ({ channelId: placement.channelId,
          allowedUserIds: placement.audience?.allowedUserIds ?? [] })),
        send: async (event) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const resolved = await resolveSlackWorkerIngress({
            identity: {
              provider: "slack",
              app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
              workspace_id: event.workspaceId,
              event_id: event.eventId,
              channel_id: event.channelId,
              thread_ts: event.threadTs,
              requester_id: event.userId ?? "",
            },
            required_scopes: requiredScopes,
            required_authorization: {
              audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
              project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
              capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
            },
            authority: clients.authority,
            now: event.receivedAt,
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          return env.TECHKNIGHT_EVENTS.send({
            schema_version: "1.0",
            tenant_context: resolved.tenant_context,
            payload: { ...event, tenantId: resolved.tenant_context.tenant.tenant_id },
          });
        } });
    }
    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const clients = tenantRuntimeClients(env);
      const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
        .split(",").map((value) => value.trim()).filter(Boolean);
      return handleTenantSlackRequest(request, {
        signing_secret: env.SLACK_SIGNING_SECRET,
        expected_app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
        required_scopes: requiredScopes,
        required_authorization: {
          audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
          project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
          capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
        },
        authority: clients.authority,
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        send: (event) => env.TECHKNIGHT_EVENTS.send(event),
      });
    } catch (error) {
      const code = error instanceof TenantBoundaryError ? error.code : "CONFIGURATION_INVALID";
      return Response.json({ error: code }, { status: 503 });
    }
  },

  async queue(batch: MessageBatch<TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
    | TenantQueueBody<MeetingMinutesRedo>
    | TenantQueueBody<MeetingMinutesRecovery>
    | TenantQueueBody<TaskBoardRepairEvent>
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent>, env: Env): Promise<void> {
    const executeTenantContainerOperation = <T>(input: {
      tenant_context: TenantContextEnvelope;
      expected_scope: ExpectedTenantScope;
      verifier: TenantRuntimeBoundaryVerifier;
      now: string;
      release?: "on_completion" | "on_expiration";
      execute(tenantBoundaryHandle: string): Promise<T>;
    }): Promise<T> => executeTenantBoundary({
      boundary: "container_launch",
      tenant_context: input.tenant_context,
      expected_scope: input.expected_scope,
      verifier: input.verifier,
      now: input.now,
      execute: async () => {
        const registry = createDurableTenantBoundaryRegistry(env.TENANT_RUNTIME_STATE);
        const handle = await registry.register({
          tenant_context: input.tenant_context,
          expected_scope: input.expected_scope,
          now: input.now,
        });
        try {
          return await input.execute(handle);
        } finally {
          if (input.release !== "on_expiration") await registry.dispose(handle);
        }
      },
    });
    for (const message of batch.messages) {
      if (isTenantTaskBoardRepairBody(message.body)) {
        const tenantBody = message.body;
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantTaskBoardRepairScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          verifier,
          expected_scope: () => expectedScope,
          now,
          ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, runtimeTenantId),
          payload_hash: tenantPayloadHash,
          retention_until: tenantRetentionUntil,
          log: (entry) => console.log(JSON.stringify(entry)),
          log_error: (entry) => console.error(JSON.stringify(entry)),
          process: (repair: TaskBoardRepairEvent, tenantContext) => {
            const tenantCredentialFetch = createTenantCredentialFetch({
              envelope: tenantContext,
              expected_scope: expectedScope,
              broker: clients.credential_broker,
              credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
              credential_relay: env.TENANT_RUNTIME_STATE,
              read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                tenantContext.workspace_connection.connection_id),
              resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
              now,
            });
            return executeTenantRuntimeOperation({
              tenant_context: tenantContext,
              expected_scope: expectedScope,
              verifier,
              quota: clients.quota,
              accounting: clients.accounting,
              ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
              quota_unit: "task_board_refresh",
              now,
              process: () => executeTenantBoundary({
                boundary: "brainbase_proxy",
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                now: now(),
                execute: () => executeTenantBoundary({
                  boundary: "slack_delivery",
                  tenant_context: tenantContext,
                  expected_scope: expectedScope,
                  verifier,
                  now: now(),
                  execute: async () => {
                    await processTaskBoardRepair(repair, env, runtimeTenantId, tenantCredentialFetch);
                    return { outcome: "completed" as const };
                  },
                }),
              }),
            });
          },
        });
        continue;
      }
      if (isTaskBoardRepairEvent(message.body)) {
        console.error(JSON.stringify({ event: "task_board_repair_failed", code: "FALLBACK_FORBIDDEN" }));
        message.ack();
        continue;
      }
      const meetingMinutesConfig = meetingMinutesRuntimeConfig(env);
      if (isTenantMeetingMinutesRedoBody(message.body)) {
        const tenantBody = message.body;
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantMeetingMinutesRedoScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          verifier,
          expected_scope: () => expectedScope,
          now,
          ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, runtimeTenantId),
          payload_hash: tenantPayloadHash,
          retention_until: tenantRetentionUntil,
          log: (entry) => console.log(JSON.stringify(entry)),
          log_error: (entry) => console.error(JSON.stringify(entry)),
          process: async (command: MeetingMinutesRedo, tenantContext) => executeTenantRuntimeOperation({
            tenant_context: tenantContext,
            expected_scope: expectedScope,
            verifier,
            quota: clients.quota,
            accounting: clients.accounting,
            ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
            quota_unit: "model_tokens",
            now,
            process: () => withTenantCredentialLease({
              envelope: tenantContext,
              expected_scope: expectedScope,
              audience: requiredRuntimeBinding(env.MANA_CREDENTIAL_AUDIENCE),
              broker: clients.credential_broker,
              credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
              read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                tenantContext.workspace_connection.connection_id,
              ),
              resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
              now,
              run: (credentialLeaseHandle) => executeTenantContainerOperation({
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                now: now(),
                execute: (tenantBoundaryHandle) => processTenantMeetingMinutesRedo({
                  env,
                  config: meetingMinutesConfig,
                  command,
                  tenantContext,
                  expectedScope,
                  verifier,
                  now,
                  credentialLeaseHandle,
                  tenantBoundaryHandle,
                }),
              }),
            }),
          }),
        });
        continue;
      }
      if (isMeetingMinutesRedo(message.body)) {
        console.error(JSON.stringify({ event: "meeting_minutes_redo_failed", code: "FALLBACK_FORBIDDEN" }));
        message.ack();
        continue;
      }
      if (isTenantMeetingMinutesRecoveryBody(message.body)) {
        const tenantBody = message.body;
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantMeetingMinutesRecoveryScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          verifier,
          expected_scope: () => expectedScope,
          now,
          ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, runtimeTenantId),
          payload_hash: tenantPayloadHash,
          retention_until: tenantRetentionUntil,
          log: (entry) => console.log(JSON.stringify(entry)),
          log_error: (entry) => console.error(JSON.stringify(entry)),
          process: (recovery: MeetingMinutesRecovery, tenantContext: TenantContextEnvelope) =>
            processTenantMeetingMinutesRecovery({
            env,
            recovery,
            tenantContext,
            expectedScope,
            verifier,
            now,
          }),
        });
        continue;
      }
      if (isMeetingMinutesRecovery(message.body)) {
        console.error(JSON.stringify({ event: "meeting_minutes_recovery_failed", code: "FALLBACK_FORBIDDEN" }));
        message.ack();
        continue;
      }
      if (isTenantMeetingMinutesSelectionBody(message.body)) {
        const tenantBody = message.body;
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantMeetingMinutesSelectionScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          verifier,
          expected_scope: () => expectedScope,
          now,
          ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, runtimeTenantId),
          payload_hash: tenantPayloadHash,
          retention_until: tenantRetentionUntil,
          log: (entry) => console.log(JSON.stringify(entry)),
          log_error: (entry) => console.error(JSON.stringify(entry)),
          process: async (selection: MeetingMinutesSelection, tenantContext) => executeTenantRuntimeOperation({
            tenant_context: tenantContext,
            expected_scope: expectedScope,
            verifier,
            quota: clients.quota,
            accounting: clients.accounting,
            ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
            quota_unit: "model_tokens",
            now,
            process: () => withTenantCredentialLease({
              envelope: tenantContext,
              expected_scope: expectedScope,
              audience: requiredRuntimeBinding(env.MANA_CREDENTIAL_AUDIENCE),
              broker: clients.credential_broker,
              credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
              read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                tenantContext.workspace_connection.connection_id,
              ),
              resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
              now,
              run: (credentialLeaseHandle) => executeTenantContainerOperation({
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                now: now(),
                execute: (tenantBoundaryHandle) => processTenantMeetingMinutesSelection({
                  env,
                  config: meetingMinutesConfig,
                  selection,
                  tenantContext,
                  expectedScope,
                  verifier,
                  now,
                  credentialLeaseHandle,
                  tenantBoundaryHandle,
                }),
              }),
            }),
          }),
        });
        continue;
      }
      if (isMeetingMinutesSelection(message.body)) {
        console.error(JSON.stringify({ event: "meeting_minutes_selection_failed", code: "FALLBACK_FORBIDDEN" }));
        message.ack();
        continue;
      }
      if (!isTenantSlackQueueBody(message.body)) {
        console.error(JSON.stringify({ event: "tenant_queue_failed", code: "FALLBACK_FORBIDDEN" }));
        message.ack();
        continue;
      }
      const tenantBody = message.body;
      const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
      const runtimeWorkspaceId = tenantBody.tenant_context.workspace_connection.workspace_id;
      const clients = tenantRuntimeClients(env);
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
      });
      const tenantConsumerOptions = {
        verifier,
        expected_scope: (body: TenantQueueBody<SlackQueueEvent>) => expectedTenantQueueScope(env, body),
        now: () => new Date().toISOString(),
        ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, runtimeTenantId),
        payload_hash: tenantPayloadHash,
        retention_until: tenantRetentionUntil,
        log: (entry: Record<string, string>) => console.log(JSON.stringify(entry)),
        log_error: (entry: Record<string, string>) => console.error(JSON.stringify(entry)),
      };
      if (isMeetingMinutesSlackEvent(tenantBody.payload, meetingMinutesConfig)) {
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, {
          ...tenantConsumerOptions,
          process: async (event: SlackQueueEvent, tenantContext) => executeTenantRuntimeOperation({
            tenant_context: tenantContext,
            expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
            verifier,
            quota: clients.quota,
            accounting: clients.accounting,
            ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
            quota_unit: "model_tokens",
            now: tenantConsumerOptions.now,
            process: async () => {
              for (const file of event.files ?? []) {
                if (!/\.txt$/i.test(file.name)) continue;
                const childEventId = await childInteractionEventId(event.eventId, `meeting-minutes-file:${file.id}`);
                const childEvent: SlackQueueEvent = { ...event, eventId: childEventId, files: [file] };
                const childTenantContext = await resolveDerivedSlackTenantContext(env, tenantContext, {
                  app_id: tenantContext.workspace_connection.app_id,
                  workspace_id: childEvent.workspaceId,
                  event_id: childEvent.eventId,
                  channel_id: childEvent.channelId,
                  thread_ts: childEvent.threadTs,
                  requester_id: childEvent.userId ?? "",
                });
                const childBody: TenantQueueBody<SlackQueueEvent> = {
                  schema_version: "1.0",
                  tenant_context: childTenantContext,
                  payload: childEvent,
                };
                const childExpectedScope = expectedTenantQueueScope(env, childBody);
                await executeTenantRuntimeOperation({
                  tenant_context: childTenantContext,
                  expected_scope: childExpectedScope,
                  verifier,
                  quota: clients.quota,
                  accounting: clients.accounting,
                  ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, childTenantContext),
                  quota_unit: "model_tokens",
                  now: tenantConsumerOptions.now,
                  process: () => withTenantCredentialLease({
                    envelope: childTenantContext,
                    expected_scope: childExpectedScope,
                    audience: requiredRuntimeBinding(env.MANA_CREDENTIAL_AUDIENCE),
                    broker: clients.credential_broker,
                    credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
                    read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                      childTenantContext.workspace_connection.connection_id,
                    ),
                    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                    now: tenantConsumerOptions.now,
                    run: (credentialLeaseHandle) => executeTenantContainerOperation({
                      tenant_context: childTenantContext,
                      expected_scope: childExpectedScope,
                      verifier,
                      now: tenantConsumerOptions.now(),
                      execute: async (tenantBoundaryHandle) => {
                        const effects = createMeetingMinutesTenantEffectGuard({
                          env,
                          tenant_context: childTenantContext,
                          expected_scope: childExpectedScope,
                          verifier,
                          now: tenantConsumerOptions.now,
                        });
                    const runId = `${event.eventId}_${file.id}`;
                    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
                      runtimeTenantId, event.workspaceId, runId,
                    ));
                    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
                    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
                      const meetingClients = meetingMinutesClients(
                        env,
                        effects,
                        credentialLeaseHandle,
                        tenantBoundaryHandle,
                      );
                      await processMeetingMinutesSlackEvent(workspace.fs, childEvent, meetingMinutesConfig, {
                        sourceAppId: childTenantContext.workspace_connection.app_id,
                        download: (fileId) => meetingClients.slack.downloadTextFile(fileId),
                        classifyDestination: (transcript, destinations) => meetingClients.classify(transcript, destinations),
                        requestDestination: (run, destinations) => meetingClients.slack.requestDestination(run, destinations),
                      });
                    });
                        return { outcome: "awaiting_destination" };
                      },
                    }),
                  }),
                });
              }
              return { outcome: "awaiting_destination" };
            },
          }),
        });
        continue;
      }
      const ordinaryEvent = tenantBody.payload;
      const ordinaryPlacements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      let resolvedPlacement;
      try {
        resolvedPlacement = resolveRuntimePlacement(ordinaryEvent, {
          tenantId: runtimeTenantId,
          workspaceId: runtimeWorkspaceId,
          placements: ordinaryPlacements,
        });
      } catch (error) {
        console.log(JSON.stringify({ event: "techknight_slack_reply_ignored", eventId: ordinaryEvent.eventId,
          channelId: ordinaryEvent.channelId,
          reason: error instanceof RuntimeBindingError ? error.code : "placement_not_allowed" }));
        message.ack();
        continue;
      }
      await consumeTenantQueueMessage({
        body: tenantBody,
        ack: () => message.ack(),
        retry: () => message.retry(),
      }, {
        ...tenantConsumerOptions,
        process: async (event: SlackQueueEvent, tenantContext) => {
          const placement = resolvedPlacement;
          const placementClaudeRuntime = resolveClaudeRuntimeConfig(env, placement.agent?.model);
          const trace: TurnRuntimeTrace = { placementId: placement.placementId, projectCodes: placement.projectCodes,
            actorIdHash: await actorIdHash(event), workerVersion: env.CF_VERSION_METADATA?.id,
            model: placementClaudeRuntime.model, effort: placementClaudeRuntime.effort };
          emitTurnLog("log", "mana_turn_received", event, trace, { outcome: "accepted", eventType: event.eventType });
          emitTurnLog("log", "mana_placement_resolved", event, trace, { outcome: "resolved", taskWriteEnabled: placement.taskWriteEnabled });
          await upsertRuntimeSession(env.RUNTIME_SESSION_REGISTRY, {
            sessionId: workspaceName(event), placementId: placement.placementId, workspaceId: event.workspaceId,
            channelId: event.channelId, threadTs: event.threadTs, ...(event.userId ? { requesterId: event.userId } : {}),
            status: "active", updatedAt: event.receivedAt,
          });
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event));
          const workspaceStub = env.TECHKNIGHT_WORKSPACE.get(id);
          const deliveryId = runtimeDeliveryId(event);
          let deliveryClaimed = false;
          const handle = workspaceStub as unknown as WorkspaceHandle;
          try {
            const result = await withDisposableResource(
              () => getWorkspace(handle),
              async (workspace) => {
              await persistEventOnce(workspace.fs, event);
               await reconcilePermissionRevision(workspace.fs, placement.permissionRevision ?? "legacy-v1", event.receivedAt);
               const workspaceSession = await readWorkspaceSession(workspace.fs);
              const replyEligible = isReplyEligible(event, {
                expectedTenantId: runtimeTenantId,
                expectedWorkspaceId: runtimeWorkspaceId,
                allowedChannelId: placement.channelId,
                respondPolicy: placement.respondTo,
                isEngagedThread: workspaceSession.engaged === true,
              });
              // Slack may emit an ordinary message before the app_mention for the
              // same post. An ineligible variant must never claim the shared
              // message delivery id and suppress the eligible variant.
              const ambientTriageCandidate = event.eventType === "message"
                && event.channelType !== "im"
                && Boolean(event.userId)
                && !event.botId
                && event.subtype !== "bot_message";
              if (!replyEligible && !ambientTriageCandidate) return { outcome: "ignored" as const };
              if (!await workspaceStub.claimRuntimeEvent(deliveryId)) {
                return { outcome: "already_processing" as const };
              }
              deliveryClaimed = true;
              const expectedScope = tenantConsumerOptions.expected_scope(tenantBody);
              const tenantCredentialFetch = createTenantCredentialFetch({
                envelope: tenantContext,
                expected_scope: expectedScope,
                broker: clients.credential_broker,
                credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
                credential_relay: env.TENANT_RUNTIME_STATE,
                read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                  tenantContext.workspace_connection.connection_id),
                resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                now: tenantConsumerOptions.now,
              });
              const injectedCredential = "tenant-credential-injected";
              const deliveryOwnership = createDurableTenantStateClient(
                env.TENANT_RUNTIME_STATE,
                tenantContext.tenant.tenant_id,
              );
              const postTenantReply = (replyEvent: SlackQueueEvent, text: string) => {
                const deliveryNow = tenantConsumerOptions.now();
                return postTenantSlackReply({
                  tenant_context: tenantContext,
                  expected_scope: expectedScope,
                  ownership: deliveryOwnership,
                  read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                    tenantContext.workspace_connection.connection_id,
                  ),
                  resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                  now: deliveryNow,
                  retention_until: tenantRetentionUntil(deliveryNow),
                  event: replyEvent,
                  text,
                  post: () => postSlackReply(replyEvent, text, {
                    slackBotToken: injectedCredential,
                    fetch: tenantCredentialFetch,
                  }),
                });
              };
              const runTenantOperation = <R extends {
                outcome?: string;
                responseTs?: string;
                accounting?: "deferred" | "already_recorded";
              }>(
                process: (quotaDecision: QuotaDecision) => Promise<R>,
                quotaUnit = "model_tokens",
              ) => executeTenantRuntimeOperation({
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                quota: clients.quota,
                accounting: clients.accounting,
                ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
                quota_unit: quotaUnit,
                now: tenantConsumerOptions.now,
                process,
              });
              const sessionModel = workspaceSession.modelOverride;
              const claudeRuntime = resolveClaudeRuntimeConfig(
                env,
                sessionModel === "opus" || sessionModel === "sonnet"
                  ? sessionModel
                  : placementClaudeRuntime.model,
              );
              let controlCommand;
              try {
                controlCommand = parseRuntimeControlCommand(event.text);
              } catch (error) {
                if (!(error instanceof RuntimeControlCommandError)) throw error;
                return runTenantOperation(async () => {
                  const responseTs = await postTenantReply(event, renderRuntimeControlCommandError(error));
                  await persistReplyCompletion(workspace.fs, {
                    eventId: event.eventId,
                    responseTs,
                    completedAt: new Date().toISOString(),
                  });
                  await markWorkspaceEngaged(workspace.fs, new Date().toISOString());
                  return { outcome: "replied" as const, responseTs };
                });
              }
              if (controlCommand) {
                const completedReply = await readReplyCompletion(workspace.fs, event.eventId);
                if (completedReply) {
                  return runTenantOperation(async () => ({
                    outcome: "already_completed" as const,
                    responseTs: completedReply.responseTs,
                  }));
                }
                return runTenantOperation(async (quotaDecision) => {
                  const text = await executeRuntimeControlCommand({
                  fs: workspace.fs,
                  command: controlCommand,
                  commandId: event.eventId,
                  requestedAt: event.receivedAt,
                  messageTs: event.messageTs,
                  placementId: placement.placementId,
                  projectCodes: placement.projectCodes,
                  currentModel: claudeRuntime.model,
                  allowedModels: ["sonnet", "opus"],
                  taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED === "true",
                  taskWriteEnabled: placement.taskWriteEnabled,
                  doctor: () => runRuntimeDoctor(env, placement.capabilities?.mcp ?? []),
                  cron: (action, target) => executeRuntimeCron({
                    fs: workspace.fs,
                    jobs: parsePlacementCronJobs(env.RUNTIME_CRON_JOBS_JSON, placement.channelId),
                    action,
                    ...(target ? { target } : {}),
                    run: async (job) => {
                      const receivedAt = new Date().toISOString();
                      const message = await createCanonicalManualCronMessage(event, job, receivedAt,
                        async (manualEvent) => (await resolveSlackWorkerIngress({
                          identity: {
                            provider: "slack",
                            app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
                            workspace_id: manualEvent.workspaceId,
                            event_id: manualEvent.eventId,
                            channel_id: manualEvent.channelId,
                            thread_ts: manualEvent.threadTs,
                            requester_id: manualEvent.userId ?? "",
                          },
                          required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
                            .split(",").map((value) => value.trim()).filter(Boolean),
                          required_authorization: {
                            audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
                            project_id: requiredRuntimeBinding(env.MANA_REQUIRED_PROJECT_ID),
                            capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
                          },
                          authority: clients.authority,
                          now: receivedAt,
                          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                        })).tenant_context);
                      await env.TECHKNIGHT_EVENTS.send(message);
                    },
                  }),
                  develop: (request) => executeTenantContainerOperation({
                    tenant_context: tenantBody.tenant_context,
                    expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                    verifier,
                    now: tenantConsumerOptions.now(),
                    release: "on_expiration",
                    execute: async (tenantBoundaryHandle) => runCloudflareDevelopmentRequest({
                      request,
                      placementId: placement.placementId,
                      requesterId: event.userId!,
                      eventId: event.eventId,
                      workspaceId: event.workspaceId,
                      channelId: event.channelId,
                      threadTs: event.threadTs,
                      tenantId: tenantBody.tenant_context.tenant.tenant_id,
                      connectionId: tenantBody.tenant_context.workspace_connection.connection_id,
                      connectionRevision: tenantBody.tenant_context.workspace_connection.connection_revision,
                      operationId: tenantBody.tenant_context.operation_id,
                      contextHash: await developmentTenantContextHash(tenantBody.tenant_context),
                      tenantBoundaryHandle,
                      contextExpiresAt: tenantBody.tenant_context.expires_at,
                      quotaDecision: quotaDecision.decision,
                      terminalAccounting: {
                        tenant_context: tenantBody.tenant_context,
                        expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                        quota_decision: quotaDecision.decision,
                        unit: "container_seconds",
                        outcome: "timed_out",
                        failure_code: "DEVELOPMENT_RUNNER_TIMED_OUT",
                        reply_state: "unknown",
                      },
                      now: tenantConsumerOptions.now,
                      callbackBaseUrl: env.DEVELOPMENT_CALLBACK_BASE_URL,
                      registerJobOwner: async (owner) => {
                        const store = createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, owner.tenantId);
                        const claimed = await claimDevelopmentJobOwner(store, owner, tenantConsumerOptions.now());
                        const terminalOutbox = createDevelopmentTerminalOutboxClient(
                          env.TENANT_RUNTIME_STATE,
                          claimed.claim.partition_key,
                        );
                        return {
                          created: claimed.disposition === "claimed",
                          armTerminalWatchdog: async (watchdog) => {
                            if (claimed.disposition !== "claimed") return;
                            await terminalOutbox.arm({
                              ...watchdog,
                              job_id: owner.jobId,
                              tenant_boundary_handle: tenantBoundaryHandle,
                              owner,
                              owner_claim: {
                                key: claimed.claim.key,
                                partition_key: claimed.claim.partition_key,
                              },
                            });
                          },
                          cancelTerminalWatchdog: async () => {
                            if (claimed.disposition === "claimed") {
                              await terminalOutbox.cancel(owner.jobId);
                            }
                          },
                          release: async () => {
                            if (claimed.disposition === "claimed") {
                              await releaseDevelopmentJobOwner(store, owner, claimed.claim);
                            }
                          },
                        };
                      },
                      createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId, "2h"),
                    }),
                  }),
                  });
                  const responseTs = await postTenantReply(event, text);
                  await persistReplyCompletion(workspace.fs, {
                    eventId: event.eventId,
                    responseTs,
                    completedAt: new Date().toISOString(),
                  });
                  await markWorkspaceEngaged(workspace.fs, new Date().toISOString());
                  return controlCommand.name === "develop"
                    ? { outcome: "accepted" as const, responseTs, accounting: "deferred" as const }
                    : { outcome: "replied" as const, responseTs };
                }, controlCommand.name === "develop" ? "container_seconds" : "model_tokens");
              }
              const hydrateThreadContext = async (input: SlackQueueEvent) => {
                const hydrated = await hydrateSlackQueueEventThreadContext(input, {
                  botToken: injectedCredential,
                  fetch: tenantCredentialFetch,
                  contextAfterTs: workspaceSession.contextAfterTs,
                });
                const withParticipants = { ...hydrated,
                  threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext,
                    { botToken: injectedCredential, fetchImpl: tenantCredentialFetch }) };
                return hydrateSlackAttachments(withParticipants, {
                  botToken: injectedCredential,
                  fetchImpl: tenantCredentialFetch,
                });
              };
              return runTenantOperation(async () => {
                const completedReply = await readReplyCompletion(workspace.fs, event.eventId);
                if (completedReply) {
                  return { outcome: "already_completed" as const, responseTs: completedReply.responseTs };
                }
                return withTenantCredentialLease({
                envelope: tenantBody.tenant_context,
                expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                audience: requiredRuntimeBinding(env.MANA_CREDENTIAL_AUDIENCE),
                broker: clients.credential_broker,
                credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
                read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                  tenantBody.tenant_context.workspace_connection.connection_id,
                ),
                resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                now: tenantConsumerOptions.now,
                run: (credentialLeaseHandle) => executeTenantContainerOperation({
                  tenant_context: tenantBody.tenant_context,
                  expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                  verifier,
                  now: tenantConsumerOptions.now(),
                  execute: (tenantBoundaryHandle) => routeRuntimeEvent(event, {
                    meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
                    processMeetingTask: () => {
                      const binding = placement;
                      return processMeetingTaskEvent(workspace.fs, event, {
                        binding,
                        brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
                        brainbaseTaskToken: injectedCredential,
                        slackBotToken: injectedCredential,
                        fetch: tenantCredentialFetch,
                        oauthConfigured: true,
                        credentialLeaseHandle,
                        tenantBoundaryHandle,
                        claudeRuntime,
                        createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                        hydrateThreadContext,
                      });
                    },
                    processReply: async () => runWithReplyTaskSearchBinding(event, {
                    tenantId: runtimeTenantId,
                    workspaceId: runtimeWorkspaceId,
                    channelId: placement.channelId,
                    projectCodes: placement.projectCodes.join(","),
                    taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED,
                    brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
                    brainbaseTaskToken: injectedCredential,
                  }, async (taskSearch) => {
                    const profileResolution = await resolveSlackUserProfile({ userId: event.userId ?? "",
                      botToken: injectedCredential,
                      fetchImpl: tenantCredentialFetch,
                    });
                    // users.info is enrichment, not the authorization boundary. Some Slack
                    // installations intentionally omit users:read. Canonical Graph identity
                    // resolution below remains mandatory and fail-closed; a profile outage must
                    // not prevent an otherwise authorized requester from using the runtime.
                    let requesterProfile;
                    try {
                      requesterProfile = requesterProfileOrFallback(event.userId ?? "", profileResolution);
                    } catch {
                      throw new ReplyPipelineError("requester_profile_rejected");
                    }
                    const graphOptions = {
                      baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
                      token: injectedCredential,
                      fetch: tenantCredentialFetch,
                    };
                    const actorIdentityResolver = resolveActorIdentityResolverFromEnv(env);
                    const mappedActor = await actorIdentityResolver?.(event);
                    const requesterResolution = mappedActor
                      ? { status: "resolved" as const, personId: mappedActor.personId }
                      : await resolveGraphRequester(
                          event.workspaceId, event.userId ?? "", placement.projectCodes[0], graphOptions,
                        );
                    if (requesterResolution.status !== "resolved") {
                      throw new ReplyPipelineError(`requester_identity_${requesterResolution.status}`);
                    }
                    const { taskWriteEnabled, taskWriteCapability } = await issueTaskWriteRequestContext(
                      event, env, Date.now(), placement, requesterResolution.personId,
                    );
                    const graphContext = await hydrateGraphContext(event, placement.projectCodes[0], graphOptions);
                    if (graphContext.status === "unavailable") {
                      throw new ReplyPipelineError("graph_context_unavailable");
                    }
                    return processReplyEvent(workspace.fs, event, {
                    expectedTenantId: runtimeTenantId,
                    expectedWorkspaceId: runtimeWorkspaceId,
                    allowedChannelId: placement.channelId,
                    slackBotToken: injectedCredential,
                    fetch: tenantCredentialFetch,
                    oauthConfigured: true,
                    credentialLeaseHandle,
                    tenantBoundaryHandle,
                    claudeRuntime,
                    taskSearchEnabled: taskSearch.taskSearchEnabled,
                    taskWriteEnabled,
                    taskWriteCapability,
                    requesterIdentity: { slackUserId: event.userId ?? "", personId: requesterResolution.personId },
                    requesterProfile,
                    graphContext: graphContext.content,
                    runtimeContext: placement.runtimeContext ? { ...placement.runtimeContext,
                      escalationEmployee: placement.agent?.escalationEmployee } : undefined,
                    capabilities: placement.capabilities,
                    resolveActorIdentity: actorIdentityResolver,
                    trace: { ...trace, model: claudeRuntime.model, effort: claudeRuntime.effort },
                    respondPolicy: placement.respondTo,
                    isEngagedThread: workspaceSession.engaged === true,
                    triage: async (triageEvent) => {
                      const hydrated = await hydrateThreadContext(triageEvent);
                      const recentThread = (hydrated.threadContext ?? "").split("\n").filter(Boolean).slice(-10)
                        .map((text) => ({ speaker: "thread", text }));
                      const decision = await runRuntimeTriage({
                        botName: "まな",
                        persona: placement.runtimeContext?.persona,
                        speakerName: requesterProfile.displayName ?? requesterProfile.realName ?? requesterProfile.handle ?? "Slack user",
                        channelType: triageEvent.channelType ?? "channel",
                        messageText: triageEvent.text,
                        attachmentNames: triageEvent.files?.map((file) => file.name),
                        recentThread,
                      }, {
                        model: claudeRuntime.model,
                        effort: claudeRuntime.effort,
                        credentialLeaseHandle,
                        tenantBoundaryHandle,
                        createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                      });
                      emitTurnLog("log", "mana_triage_decided", triageEvent, trace, {
                        outcome: decision.action,
                        reasonCode: decision.reason,
                      });
                      return decision;
                    },
                    createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId),
                    hydrateThreadContext,
                    postReply: postTenantReply,
                    });
                    }),
                  }),
                }),
                });
              });
              },
            );
            if (deliveryClaimed) await workspaceStub.completeRuntimeEvent(deliveryId,
              "responseTs" in result && typeof result.responseTs === "string" ? result.responseTs : undefined);
            return result;
          } catch (error) {
            if (deliveryClaimed) await workspaceStub.releaseRuntimeEvent(deliveryId);
            throw error;
          }
        },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(
      env,
      new Date().toISOString(),
      (repair) => resolveTaskBoardRepairTenantContext(env, repair),
    );
  },
} satisfies ExportedHandler<Env, TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
  | TenantQueueBody<MeetingMinutesRedo>
  | TenantQueueBody<MeetingMinutesRecovery>
  | TenantQueueBody<TaskBoardRepairEvent>
  | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent>;
