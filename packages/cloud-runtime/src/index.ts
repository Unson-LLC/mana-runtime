import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";

import { handleTenantSlackRequest } from "./slack.js";
import { bootstrapUnsonSlackCredential } from "./tenant-credential-bootstrap.js";
import { ackMalformedTenantQueueMessage } from "./queue-message-validation.js";
import {
  adminJsonInputErrorResponse,
  readAdminJsonRequest,
  validateMeetingMinutesAdminTaskIds,
} from "./admin-json-input.js";
import {
  handleSandboxAdminRequest,
  isSandboxAdminAuthorized,
} from "./sandbox-admin.js";
import {
  createTechKnightSandbox,
  type SandboxRuntimeEnv,
} from "./sandbox-runtime.js";
import { destroyTenantContainer } from "./multitenancy/container-lifecycle.js";
import { deriveCorrelationId } from "./multitenancy/ids.js";
import type { SlackQueueEvent } from "./types.js";
import {
  currentMeetingMinutesActionTs,
  isMeetingMinutesSlackEvent,
  isMeetingMinutesSelection,
  isMeetingMinutesRedo,
  isMeetingMinutesRouterFileEvent,
  meetingMinutesRuntimeConfig,
  processMeetingMinutesSlackEvent,
  processMeetingMinutesRedo,
  type MeetingMinutesEnvironment,
} from "./meeting-minutes-entrypoints.js";
import type { MeetingMinutesDestination, MeetingMinutesRecovery, MeetingMinutesRecoveryAuthorization,
  MeetingMinutesRedo, MeetingMinutesRun, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import {
  handleMeetingMinutesInteractionEntrypoint,
  type TenantInteractionEffects,
  type TenantInteractionIdentity,
  type TenantInteractionTarget,
} from "./slack-interactions.js";
import { processMeetingMinutesSelectionWithStatus } from "./meeting-minutes-lifecycle.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import { meetingMinutesFailureLog } from "./meeting-minutes-diagnostics.js";
import { handleMeetingMinutesTaskAction, type MeetingMinutesSourceIdentity } from "./meeting-minutes-task-actions.js";
import {
  destinationTeamIdsForTaskActions,
  preflightMeetingMinutesDestinationSlackBindings,
  resolveMeetingMinutesDestinationSlackBinding,
  type MeetingMinutesDestinationSlackBindings,
} from "./meeting-minutes-destination-routing.js";
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
import {
  handleManaImprovementInteraction,
  openManaImprovementModal,
  postManaImprovementAcceptance,
} from "./mana-improvement-slack.js";
import { serializeManaImprovementRequest } from "./mana-improvement-request.js";
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
  enqueueMeetingMinutesTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
  processTaskBoardRepair,
  taskBoardRepairEventId,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import { actorIdHash, emitTurnLog, type TurnRuntimeTrace } from "./turn-observability.js";
import {
  claimRuntimeEvent,
  completeRuntimeEvent,
  releaseRuntimeEvent,
  runtimeClaimSettlement,
  runtimeDeliveryId,
} from "./runtime-event-claim.js";
import { runRuntimeTriage } from "./runtime-triage.js";
import { armMeetingMinutesRecovery, isMeetingMinutesRecovery,
  MEETING_MINUTES_RECOVERY_DELAY_SECONDS } from "./meeting-minutes-recovery.js";
import {
  handleMeetingMinutesRecoveryQueue,
} from "./meeting-minutes-recovery-production.js";
import { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";
import {
  gateMeetingMinutesCommandQueueMessage,
  gateMeetingMinutesRouterQueueMessage,
  handleMeetingMinutesIntakeAdminRequest,
} from "./meeting-minutes-intake-entrypoints.js";
import {
  consumeTenantQueueMessage,
  executeTenantBoundary,
  resolveSlackWorkerIngress,
  type TenantQueueBody,
  TenantRuntimeBoundaryVerifier,
} from "./multitenancy/runtime-boundaries.js";
import {
  createTenantRuntimeHttpClients,
  parseWorkspaceConnectionHints,
} from "./multitenancy/http-clients.js";
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
import { resolveCanonicalProjectScope } from "./multitenancy/project-scope.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { createTenantCredentialFetch } from "./multitenancy/tenant-credential-fetch.js";
import { createBrainbaseTrustedProviderForwarderFromEnv } from "./multitenancy/trusted-provider-forwarder.js";
import {
  createDurableTenantBoundaryRegistry,
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
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
import {
  createDurableSlackInstallationIntentClient,
  isSlackInstallationIntentRequest,
  SlackInstallationIntentHandler,
} from "./multitenancy/slack-oauth-installation-durable.js";
import {
  handleSlackOAuthCallbackRequest,
  handleSlackOAuthStartRequest,
} from "./multitenancy/slack-oauth-installation.js";
import { createSlackInstallationControlPlaneClient } from "./multitenancy/slack-installation-control-plane-client.js";
import {
  ContractLedgerStateStore,
  contractLedgerConfig,
  enqueueScheduledContractLedgerSync,
  isContractLedgerEvent,
  notifyContractLedgerDeadLetter,
  parseContractLedgerSlackAction,
  processContractLedgerApproval,
  processContractLedgerSync,
  scheduledContractLedgerEvent,
  type ContractLedgerApprovalEvent,
  type ContractLedgerEnvironment,
  type ContractLedgerSyncEvent,
} from "./contract-ledger.js";

export { ContainerProxy, TechKnightSandbox } from "./sandbox-runtime.js";
export { TaskWriteBudget } from "./task-write-budget.js";
export { TaskWriteApproval } from "./task-write-approval.js";
export { TaskBoardBinding } from "./task-board-binding.js";
export { RuntimeSessionRegistry } from "./runtime-session-registry.js";
export { MeetingMinutesDeploymentGate } from "./meeting-minutes-deployment-gate.js";
export class ContractLedgerState extends DurableObject {
  private readonly store = new ContractLedgerStateStore({ storage: this.ctx.storage });
  claimRun(key: string) { return this.store.claimRun(key); }
  completeRun(key: string, receipt: Parameters<ContractLedgerStateStore["completeRun"]>[1]) {
    return this.store.completeRun(key, receipt);
  }
  failRun(key: string, receipt: Parameters<ContractLedgerStateStore["failRun"]>[1]) {
    return this.store.failRun(key, receipt);
  }
  releaseRun(key: string) { return this.store.releaseRun(key); }
  saveCandidate(candidate: Parameters<ContractLedgerStateStore["saveCandidate"]>[0]) {
    return this.store.saveCandidate(candidate);
  }
  markCandidateNotified(envelopeId: string, messageTs: string) {
    return this.store.markCandidateNotified(envelopeId, messageTs);
  }
  candidate(envelopeId: string) { return this.store.candidate(envelopeId); }
  claimDecision(event: Parameters<ContractLedgerStateStore["claimDecision"]>[0]) {
    return this.store.claimDecision(event);
  }
  completeApproval(envelopeId: string) { return this.store.completeApproval(envelopeId); }
}

interface Env extends SandboxRuntimeEnv, MeetingMinutesEnvironment, ContractLedgerEnvironment {
  SLACK_SIGNING_SECRET: string;
  SLACK_SIGNING_SECRET_TECHKNIGHT?: string;
  SLACK_EXPECTED_TEAM_ID: string;
  SLACK_EXPECTED_APP_ID?: string;
  MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON?: string;
  MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON?: string;
  RUNTIME_CRON_JOBS_JSON?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  SLACK_ALLOWED_CHANNEL_ID: string;
  TASK_WRITE_APPROVAL_CHANNEL_ID?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
  GITHUB_TOKEN?: string;
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
  RUNTIME_AUTHORITY_PROJECT_IDS_JSON?: string;
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
  MANA_REQUIRED_CAPABILITY_ID?: string;
  MANA_REQUIRED_SLACK_SCOPES?: string;
  MANA_CREDENTIAL_AUDIENCE?: string;
  MANA_TASK_BOARD_SERVICE_ACTOR_ID?: string;
  MANA_RUNTIME_CAPABILITIES?: string;
  BRAINBASE_RUNTIME_API_TOKEN?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_WORKSPACE_CONNECTIONS_JSON?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
  BRAINBASE_TENANT_RUNTIME_ENABLED?: string;
  BRAINBASE_TENANT_RUNTIME_HOST?: string;
  BRAINBASE_TENANT_RUNTIME_PORT?: string;
  BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  SLACK_INSTALLATION_LIFECYCLE_TOKEN?: string;
  SLACK_OAUTH_APP_ID?: string;
  SLACK_OAUTH_CLIENT_ID?: string;
  SLACK_OAUTH_REDIRECT_URI?: string;
  SLACK_OAUTH_SCOPES?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_URL?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID?: string;
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY?: string;
  BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID?: string;
  SLACK_INSTALLATION_CONTROL_PLANE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  TECHKNIGHT_EVENTS: Queue<TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
    | TenantQueueBody<MeetingMinutesRedo>
    | TenantQueueBody<MeetingMinutesRecovery>
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery>;
  TASK_BOARD_REPAIRS: Queue<TenantQueueBody<TaskBoardRepairEvent> | TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS: DurableObjectNamespace;
  TASK_WRITE_APPROVALS: DurableObjectNamespace;
  TASK_BOARD_BINDINGS: DurableObjectNamespace;
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
  readonly #boundaryContext = new TenantBoundaryContextHandler(
    this.ctx.storage,
    async (input) => {
      const clients = tenantRuntimeClients(this.env, input.tenant_context);
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
  readonly #slackInstallationIntents = new SlackInstallationIntentHandler(
    this.ctx.storage as unknown as TenantStateStorage,
  );

  fetch(request: Request): Promise<Response> {
    if (isSlackInstallationIntentRequest(request)) {
      return this.#slackInstallationIntents.fetch(request);
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
  async claimRuntimeEvent(eventId: string) {
    return claimRuntimeEvent(this.ctx.storage, eventId);
  }

  async completeRuntimeEvent(eventId: string, claimToken: string, responseTs?: string): Promise<void> {
    await completeRuntimeEvent(this.ctx.storage, eventId, claimToken, responseTs);
  }

  async releaseRuntimeEvent(eventId: string, claimToken: string): Promise<void> {
    await releaseRuntimeEvent(this.ctx.storage, eventId, claimToken);
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

function meetingMinutesRecoveryAuthorization(
  tenantContext: TenantContextEnvelope,
  expectedScope: ExpectedTenantScope,
  recovery: MeetingMinutesRecovery,
): MeetingMinutesRecoveryAuthorization {
  const projectIds = [...(expectedScope.project_ids ?? tenantContext.authorization.project_ids)];
  if (projectIds.length === 0 || !projectIds.includes(expectedScope.project_id) ||
    new Set(projectIds).size !== projectIds.length || tenantContext.actor.authenticated_subject_id !== recovery.userId ||
    tenantContext.workspace_connection.workspace_id !== recovery.workspaceId ||
    tenantContext.workspace_connection.app_id !== recovery.appId ||
    tenantContext.slack.channel_id !== recovery.channelId ||
    tenantContext.slack.thread_ts !== recovery.threadTs) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    tenantId: tenantContext.tenant.tenant_id,
    tenantRevision: tenantContext.tenant.tenant_revision,
    connectionId: tenantContext.workspace_connection.connection_id,
    connectionRevision: tenantContext.workspace_connection.connection_revision,
    workspaceId: recovery.workspaceId,
    appId: recovery.appId,
    channelId: recovery.channelId,
    threadTs: recovery.threadTs,
    requesterId: recovery.userId,
    actorPrincipalId: tenantContext.actor.principal_id,
    projectIds,
    audience: expectedScope.audience,
    capabilityId: expectedScope.capability_id,
    deploymentId: tenantContext.placement.deployment_id,
    profile: tenantContext.placement.profile,
  };
}

async function reissueMeetingMinutesRecoveryTenantContext(
  env: Env,
  body: TenantQueueBody<MeetingMinutesRecovery>,
): Promise<TenantContextEnvelope> {
  const staleContext = body.tenant_context;
  const recovery = body.payload;
  const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
    staleContext.tenant.tenant_id, recovery.workspaceId, recovery.runId,
  ));
  const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
  const run = await withDisposableResource(() => getWorkspace(handle), (workspace) =>
    loadMeetingMinutesRun(workspace.fs, recovery.runId));
  const authorization = run?.recoveryAuthorization;
  if (!run || !authorization || run.workspaceId !== recovery.workspaceId ||
    run.sourceAppId !== recovery.appId || run.sourceChannelId !== recovery.channelId ||
    run.sourceThreadTs !== recovery.threadTs || run.lifecycle?.actionTs !== recovery.actionTs ||
    authorization.tenantId !== staleContext.tenant.tenant_id ||
    authorization.workspaceId !== recovery.workspaceId || authorization.appId !== recovery.appId ||
    authorization.channelId !== recovery.channelId || authorization.threadTs !== recovery.threadTs ||
    authorization.requesterId !== recovery.userId || authorization.connectionId !== staleContext.workspace_connection.connection_id ||
    staleContext.slack.event_id !== meetingMinutesRecoveryEventId(recovery)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  if (authorization.projectIds.length === 0) deny("queue_consumer", "PROJECT_SCOPE_MISMATCH");
  const clients = tenantRuntimeClients(env);
  const resolved = await resolveSlackWorkerIngress({
    identity: {
      provider: "slack",
      app_id: authorization.appId,
      workspace_id: authorization.workspaceId,
      event_id: meetingMinutesRecoveryEventId(recovery),
      channel_id: authorization.channelId,
      thread_ts: authorization.threadTs,
      requester_id: authorization.requesterId,
    },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: {
      audience: authorization.audience,
      project_id: authorization.projectIds[0]!,
      capability_id: authorization.capabilityId,
    },
    trusted_project_ids: authorization.projectIds,
    tenant_revision: authorization.tenantRevision,
    authority: clients.authority,
    now: new Date().toISOString(),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  });
  const fresh = resolved.tenant_context;
  const freshProjects = [...fresh.authorization.project_ids].sort();
  const authorizedProjects = [...authorization.projectIds].sort();
  const sameProjects = freshProjects.length === authorizedProjects.length &&
    freshProjects.every((projectId, index) => projectId === authorizedProjects[index]);
  if (fresh.tenant.tenant_id !== authorization.tenantId ||
    fresh.tenant.tenant_revision !== authorization.tenantRevision ||
    fresh.workspace_connection.connection_id !== authorization.connectionId ||
    fresh.workspace_connection.connection_revision !== authorization.connectionRevision ||
    fresh.workspace_connection.workspace_id !== authorization.workspaceId ||
    fresh.workspace_connection.app_id !== authorization.appId ||
    fresh.actor.principal_id !== authorization.actorPrincipalId ||
    !sameProjects || fresh.placement.deployment_id !== authorization.deploymentId ||
    fresh.placement.profile !== authorization.profile) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return fresh;
}

function meetingMinutesDeploymentGate(env: Env, tenantId: string): DurableObjectStub<MeetingMinutesDeploymentGate> {
  return env.MEETING_MINUTES_DEPLOYMENT_GATE.get(env.MEETING_MINUTES_DEPLOYMENT_GATE.idFromName(tenantId));
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
  const sourceProjectIds = [...sourceTenantContext.authorization.project_ids];
  if (sourceProjectIds.length === 0) deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  const resolved = await resolveSlackWorkerIngress({
    identity: { provider: "slack", ...identity },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: sourceProjectIds[0]!,
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    trusted_project_ids: sourceProjectIds,
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
  const clients = tenantRuntimeClients(env);
  const resolve = (identity: TenantInteractionIdentity) => {
    const placementAuthorization = placementAuthorizationForIdentity(env, identity);
    return resolveSlackWorkerIngress({
      identity: { provider: "slack", ...identity },
      required_scopes: requiredScopes,
      ...placementAuthorization,
      authority: clients.authority,
      now: new Date().toISOString(),
      resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
    });
  };
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
        audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
        workspace_id: identity.workspace_id,
        app_id: identity.app_id,
        channel_id: identity.channel_id,
        thread_ts: identity.thread_ts,
        actor_principal_id: tenantContext.actor.principal_id,
        project_id: tenantContext.authorization.project_ids[0]!,
        project_ids: [...tenantContext.authorization.project_ids],
        capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
        deployment_id: tenantContext.placement.deployment_id,
      };
      return { tenantContext, verifier, expectedScope, now: new Date().toISOString() };
    };
    const createCredentialFetch = (effect: Awaited<ReturnType<typeof resolveEffect>>) => createTenantCredentialFetch({
      envelope: effect.tenantContext,
      expected_scope: effect.expectedScope,
      broker: clients.credential_broker,
      trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
        env,
        tenant_context: effect.tenantContext,
      }),
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
        usage_unit: "interaction_effect",
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
          usage_unit: "interaction_effect",
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
  preflightDestinationSlack(destinations: readonly MeetingMinutesDestination[]): MeetingMinutesDestinationSlackBindings;
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
  const clients = tenantRuntimeClients(input.env, input.tenant_context);
  const trustedWorkspaceConnections = parseWorkspaceConnectionHints(input.env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON);
  const preflightDestinationSlack = (destinations: readonly MeetingMinutesDestination[]) =>
    preflightMeetingMinutesDestinationSlackBindings({
      destinations,
      destinationTeamIdsJson: input.env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON,
      trustedWorkspaceConnections,
      sourceTenantId: input.tenant_context.tenant.tenant_id,
      sourceWorkspaceId: input.tenant_context.workspace_connection.workspace_id,
      sourceAppId: input.tenant_context.workspace_connection.app_id,
      sourceDeploymentId: input.tenant_context.placement.deployment_id,
      sourceProfile: input.tenant_context.placement.profile,
    });
  const createCredentialFetch = (tenantContext: TenantContextEnvelope, expectedScope: ExpectedTenantScope) =>
    createTenantCredentialFetch({
    envelope: tenantContext,
    expected_scope: expectedScope,
    broker: clients.credential_broker,
    trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
      env: input.env,
      tenant_context: tenantContext,
    }),
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
    preflightDestinationSlack,
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
      const destinationSlackBinding = resolveMeetingMinutesDestinationSlackBinding({
        organizationId: destination.organization.id,
        destination,
        destinationTeamIdsJson: input.env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON,
        trustedWorkspaceConnections,
        sourceTenantId: input.tenant_context.tenant.tenant_id,
        sourceWorkspaceId: input.tenant_context.workspace_connection.workspace_id,
        sourceAppId: input.tenant_context.workspace_connection.app_id,
        sourceDeploymentId: input.tenant_context.placement.deployment_id,
        sourceProfile: input.tenant_context.placement.profile,
      });
      const workspaceId = destinationSlackBinding.workspace_id;
      const appId = destinationSlackBinding.app_id;
      const destinationThreadTs = requiredRuntimeBinding(threadTs ?? input.tenant_context.slack.thread_ts);
      const requesterId = requiredRuntimeBinding(input.tenant_context.slack.requester_id);
      const tenantContext = await resolveDerivedSlackTenantContext(input.env, input.tenant_context, {
        app_id: appId,
        workspace_id: workspaceId,
        event_id: await childInteractionEventId(input.tenant_context.slack.event_id, effectId),
        channel_id: destination.slackChannelId,
        thread_ts: destinationThreadTs,
        requester_id: requesterId,
      }, { workspace_policy: "same_tenant" });
      const expectedScope: ExpectedTenantScope = {
        audience: requiredRuntimeBinding(input.env.MANA_REQUIRED_AUDIENCE),
        project_id: tenantContext.authorization.project_ids[0]!,
        project_ids: [...tenantContext.authorization.project_ids],
        capability_id: requiredRuntimeBinding(input.env.MANA_REQUIRED_CAPABILITY_ID),
        workspace_id: workspaceId,
        app_id: appId,
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
  tenantContext: TenantContextEnvelope,
  tenantBoundaryHandle?: string,
) {
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const destinations = meetingMinutesRuntimeConfig(env).destinations;
  if (env.MEETING_MINUTES_ENABLED === "true") effects.preflightDestinationSlack(destinations);
  const sourceSlack = (credentialFetch: typeof fetch) => new MeetingMinutesSlackClient(
    undefined, credentialFetch);
  const destinationForChannel = (channelId: string) => {
    const destination = destinations.find((candidate) => candidate.slackChannelId === channelId);
    const ambiguous = destinations.some((candidate) => candidate !== destination
      && candidate.slackChannelId === channelId);
    if (!destination || ambiguous) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
    return destination;
  };
  const destinationSlack = (destination: MeetingMinutesDestination, credentialFetch: typeof fetch) => {
    if (!destinations.some((candidate) => candidate.id === destination.id
      && candidate.slackChannelId === destination.slackChannelId)) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
    return new MeetingMinutesSlackClient(undefined, credentialFetch);
  };
  const taskClient = (credentialFetch: typeof fetch) => new TaskApiClient({
    baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
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
      fallbackStatus: (run: MeetingMinutesRun,
        outcome: Parameters<MeetingMinutesSlackClient["updateRunStatus"]>[1]) =>
        effects.slack(`source-status-fallback:${run.runId}:${outcome}`,
          { kind: "source_status_fallback", runId: run.runId, outcome },
          (credentialFetch) => sourceSlack(credentialFetch).projectStatusFailure(run)),
      downloadTextFile: (fileId: string) => effects.boundary("slack_delivery",
        (credentialFetch) => sourceSlack(credentialFetch).downloadTextFile(fileId)),
      requestDestination: (run: MeetingMinutesRun,
        candidates: Parameters<MeetingMinutesSlackClient["requestDestination"]>[1]) =>
        effects.slack(`destination-request:${run.runId}`,
          { kind: "destination_request", runId: run.runId },
          (credentialFetch) => sourceSlack(credentialFetch).requestDestination(run, candidates)),
    },
    classify: (transcript: string, candidates: Parameters<typeof classifyMeetingMinutesDestinationInSandbox>[1]) => {
      if (!tenantBoundaryHandle) throw new Error("tenant_boundary_required");
      return effects.boundary("container_launch", () => classifyMeetingMinutesDestinationInSandbox(
        transcript, candidates, claudeRuntime,
        createTechKnightSandbox(env, `meeting-minutes-routing-${crypto.randomUUID()}`),
        tenantBoundaryHandle));
    },
    resume: {
      contextMode,
      resolveContext: (identity: Parameters<MeetingMinutesBrainbaseContextClient["resolve"]>[0], receiptId?: string,
        projectId?: string) => {
        const contextDestination = destinations.find((destination) => destination.projectId === projectId
          && destination.contextProjectCode === identity.project_code);
        if (!contextDestination) throw new Error("meeting_minutes_context_project_mismatch");
        return effects.boundary("brainbase_proxy", () => new MeetingMinutesBrainbaseContextClient(
          "https://tenant-runtime.internal", undefined,
          env.BRAINBASE_TENANT_RUNTIME_SERVICE?.fetch.bind(env.BRAINBASE_TENANT_RUNTIME_SERVICE),
          tenantContext).resolve(identity, receiptId));
      },
      postProcessingStatus: (run: MeetingMinutesRun) => effects.slack(`processing-status:${run.runId}`,
        { kind: "processing_status", runId: run.runId },
        (credentialFetch) => sourceSlack(credentialFetch).postProcessingStatus(run)),
      download: (fileId: string) => effects.boundary("slack_delivery",
        (credentialFetch) => sourceSlack(credentialFetch).downloadTextFile(fileId)),
      generate: (transcript: string, destination: MeetingMinutesDestination,
        context: Parameters<typeof generateMeetingMinutesInSandbox>[2], mode: Parameters<typeof generateMeetingMinutesInSandbox>[3],
        observe?: Parameters<typeof generateMeetingMinutesInSandbox>[7]) => {
        if (!tenantBoundaryHandle) throw new Error("tenant_boundary_required");
        return effects.boundary("container_launch", () => generateMeetingMinutesInSandbox(
          transcript, destination, context, mode, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`),
          tenantBoundaryHandle, observe));
      },
      saveGitHub: (input: Parameters<CloudflareMeetingMinutesGitHubClient["save"]>[0]) =>
        effects.boundary("mcp_gateway", () => new CloudflareMeetingMinutesGitHubClient(
          env.GITHUB_TOKEN ?? "").save(input)),
      createTask: async (input: Parameters<TaskApiClient["createTask"]>[0], idempotencyKey: string) => {
        return effects.boundary("brainbase_proxy",
          (credentialFetch) => taskClient(credentialFetch).createTask(input, idempotencyKey));
      },
      updateTask: async (taskId: string, input: Parameters<TaskApiClient["updateTask"]>[1], idempotencyKey: string) => {
        return effects.boundary("brainbase_proxy",
          (credentialFetch) => taskClient(credentialFetch).updateTask(taskId, input, idempotencyKey));
      },
      // Destination project IDs belong to the task destination contract and are
      // not Graph person scopes. Resolve globally, then let non-unique names
      // fail closed in resolveGraphPersonByName.
      resolveAssignee: (name: string, _projectId: string) => effects.boundary("brainbase_proxy", (credentialFetch) =>
        resolveGraphPersonByName(name, undefined, {
          baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
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
      repairTaskBoard: (targetId: string) =>
        effects.boundary("durable_object", () => enqueueMeetingMinutesTaskBoardRepair(
          env,
          targetId,
          "task_write",
          (repair) => resolveTaskBoardRepairTenantContext(env, repair),
        )),
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
          undefined, credentialFetch).delete(destination.github, paths)),
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
      showRedoFailure: (run: MeetingMinutesRun) => effects.slack(`redo-failure:${run.runId}`,
        { kind: "redo_failure", runId: run.runId },
        (credentialFetch) => sourceSlack(credentialFetch).showRedoFailure(run)),
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

function tenantRuntimeClients(env: Env, tenantContext?: TenantContextEnvelope) {
  return createTenantRuntimeHttpClients({
    deployment_profile: tenantDeploymentProfile(env),
    service: env.BRAINBASE_TENANT_RUNTIME_SERVICE,
    timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
    workspace_connections: parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON),
    ...(tenantContext ? { tenant_context: tenantContext } : {}),
  });
}

async function writeDevelopmentTerminalAccounting(env: Env, input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  artifact: AccountingArtifact;
}): Promise<{ result_ref: string }> {
  const clients = tenantRuntimeClients(env, input.tenant_context);
  const artifactContext = input.tenant_context;
  const snapshot = await clients.authority.read_workspace_connection(
    artifactContext.workspace_connection.connection_id,
  );
  const authorizationContext = await clients.authority.issue_tenant_context({
    workspace_connection: snapshot,
    tenant_revision: artifactContext.tenant.tenant_revision,
    actor: artifactContext.actor,
    authorization: artifactContext.authorization,
    correlation_id: artifactContext.correlation_id,
    operation_id: artifactContext.operation_id,
    billing_principal_id: artifactContext.credential.billing_principal_id,
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
    // Preserve the exact placement scope when terminal accounting reissues
    // the authority context; a singular project hint is insufficient here.
    trusted_project_ids: input.expected_scope.project_ids
      ?? artifactContext.authorization.project_ids,
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
    write: (payload) => clients.accounting.write({
      ...payload,
      tenant_context: authorizationContext,
    }),
  });
}

async function resolveTaskBoardRepairTenantContext(
  env: Env,
  repair: TaskBoardRepairEvent,
): Promise<TenantContextEnvelope> {
  const clients = tenantRuntimeClients(env);
  const placementProjectScope = placementProjectScopeForEvent(env, {
    tenantId: env.TENANT_ID,
    eventId: taskBoardRepairEventId(repair),
    workspaceId: repair.workspaceId,
    channelId: repair.channelId,
    threadTs: repair.requestedAt,
    messageTs: repair.requestedAt,
    userId: requiredRuntimeBinding(env.MANA_TASK_BOARD_SERVICE_ACTOR_ID),
    eventType: "message",
    text: "",
    receivedAt: repair.requestedAt,
  });
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
      project_id: placementProjectScope.project_id,
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    trusted_project_ids: placementProjectScope.project_ids,
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

function placementProjectScopeForEvent(
  env: Env,
  event: SlackQueueEvent,
): { project_id: string; project_ids: readonly string[] } {
  try {
    const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
    const placement = resolveRuntimePlacement(event, {
      tenantId: event.tenantId,
      workspaceId: event.workspaceId,
      placements,
    });
    if (placement.projectCodes.length === 0) throw new RuntimeBindingError("project_binding_missing");
    const configuredAuthorityIds = env.RUNTIME_AUTHORITY_PROJECT_IDS_JSON
      ? JSON.parse(env.RUNTIME_AUTHORITY_PROJECT_IDS_JSON) as Record<string, unknown>
      : {};
    const mappedAuthorityIds = configuredAuthorityIds[placement.placementId];
    if (mappedAuthorityIds !== undefined && (
      !Array.isArray(mappedAuthorityIds) ||
      mappedAuthorityIds.length !== placement.projectCodes.length ||
      mappedAuthorityIds.some((id) => typeof id !== "string" || !/^prj_[A-Za-z0-9]+$/.test(id)) ||
      new Set(mappedAuthorityIds).size !== mappedAuthorityIds.length
    )) throw new RuntimeBindingError("authority_project_ids_invalid");
    const authorityProjectIds = mappedAuthorityIds as string[] | undefined
      ?? placement.projectCodes;
    return { project_id: authorityProjectIds[0]!, project_ids: [...authorityProjectIds] };
  } catch (error) {
    deny("queue_consumer", "PROJECT_SCOPE_MISMATCH", {
      reason: error instanceof RuntimeBindingError ? error.code : "placement_resolution_failed",
    });
  }
}

function canonicalRuntimePlacements(env: Env): ReturnType<typeof parseRuntimePlacements> {
  const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
  const configured = env.RUNTIME_AUTHORITY_PROJECT_IDS_JSON
    ? JSON.parse(env.RUNTIME_AUTHORITY_PROJECT_IDS_JSON) as Record<string, unknown>
    : {};
  return placements.map((placement) => {
    const mapped = configured[placement.placementId];
    if (mapped === undefined) return placement;
    if (!Array.isArray(mapped)
      || mapped.length !== placement.projectCodes.length
      || mapped.some((id) => typeof id !== "string" || !/^prj_[A-Za-z0-9]+$/.test(id))
      || new Set(mapped).size !== mapped.length) {
      throw new RuntimeBindingError("authority_project_ids_invalid");
    }
    return { ...placement, projectCodes: [...mapped] as string[] };
  });
}

function expectedProjectScopeForEvent(
  env: Env,
  event: SlackQueueEvent,
  envelope: TenantContextEnvelope,
): { project_id: string; project_ids: readonly string[] } {
  const trusted = placementProjectScopeForEvent(env, event);
  return resolveCanonicalProjectScope(envelope.authorization, trusted.project_ids, "queue_consumer");
}

function placementAuthorizationForEvent(
  env: Env,
  event: SlackQueueEvent,
): {
  required_authorization: {
    audience: string;
    project_id: string;
    capability_id: string;
  };
  trusted_project_ids: readonly string[];
} {
  const scope = placementProjectScopeForEvent(env, event);
  return {
    required_authorization: {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: scope.project_id,
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    trusted_project_ids: scope.project_ids,
  };
}

function placementAuthorizationForIdentity(
  env: Env,
  identity: TenantInteractionIdentity,
): {
  required_authorization: {
    audience: string;
    project_id: string;
    capability_id: string;
  };
  trusted_project_ids: readonly string[];
} {
  return placementAuthorizationForEvent(env, {
    tenantId: env.TENANT_ID,
    eventId: identity.event_id,
    workspaceId: identity.workspace_id,
    channelId: identity.channel_id,
    threadTs: identity.thread_ts,
    messageTs: identity.thread_ts,
    userId: identity.requester_id,
    eventType: "message",
    text: "",
    receivedAt: new Date().toISOString(),
  });
}

function destinationAuthorizationForSelection(
  env: Env,
  destination: MeetingMinutesDestination | undefined,
): ReturnType<typeof placementAuthorizationForIdentity> | undefined {
  if (!destination?.contextProjectCode) return undefined;
  let configured: Record<string, unknown>;
  try {
    configured = env.MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON
      ? JSON.parse(env.MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON) as Record<string, unknown>
      : {};
  } catch {
    deny("worker_ingress", "PROJECT_SCOPE_MISMATCH", { scope_reason: "destination_authority_project_ids_invalid" });
  }
  const projectId = configured[destination.contextProjectCode];
  if (projectId === undefined) return undefined;
  if (typeof projectId !== "string" || !/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    deny("worker_ingress", "PROJECT_SCOPE_MISMATCH", { scope_reason: "destination_authority_project_id_missing" });
  }
  return {
    required_authorization: {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: projectId,
      capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    },
    trusted_project_ids: [projectId],
  };
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
  const placementProjectScope = expectedProjectScopeForEvent(env, {
    tenantId: envelope.tenant.tenant_id,
    eventId: meetingMinutesSelectionEventId(selection),
    workspaceId: selection.workspaceId,
    channelId: selection.channelId,
    threadTs: selection.threadTs,
    messageTs: selection.threadTs,
    userId: selection.userId,
    eventType: "message",
    text: "",
    receivedAt: selection.actionTs,
  }, envelope);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: selection.workspaceId,
    app_id: selection.appId,
    channel_id: selection.channelId,
    thread_ts: selection.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    ...placementProjectScope,
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
  const placementProjectScope = expectedProjectScopeForEvent(env, {
    tenantId: envelope.tenant.tenant_id,
    eventId: meetingMinutesRedoEventId(command),
    workspaceId: command.workspaceId,
    channelId: command.channelId,
    threadTs: command.threadTs,
    messageTs: command.threadTs,
    userId: command.userId,
    eventType: "message",
    text: "",
    receivedAt: command.actionTs,
  }, envelope);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: command.workspaceId,
    app_id: command.appId,
    channel_id: command.channelId,
    thread_ts: command.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    ...placementProjectScope,
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
  const placementProjectScope = expectedProjectScopeForEvent(env, event, envelope);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: event.workspaceId,
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
    channel_id: event.channelId,
    thread_ts: event.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    ...placementProjectScope,
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
  const placementProjectScope = expectedProjectScopeForEvent(env, {
    tenantId: envelope.tenant.tenant_id,
    eventId: taskBoardRepairEventId(repair),
    workspaceId: repair.workspaceId,
    channelId: repair.channelId,
    threadTs: repair.requestedAt,
    messageTs: repair.requestedAt,
    userId: envelope.actor.authenticated_subject_id,
    eventType: "message",
    text: "",
    receivedAt: repair.requestedAt,
  }, envelope);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: repair.workspaceId,
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
    channel_id: repair.channelId,
    thread_ts: repair.requestedAt,
    actor_principal_id: envelope.actor.principal_id,
    ...placementProjectScope,
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
  const commandGate = await gateMeetingMinutesCommandQueueMessage({
    body: selection,
    ack: () => undefined,
    retry: () => undefined,
  }, {
    enabled: config.enabled,
    isPaused: () => meetingMinutesDeploymentGate(env, tenantId).isIntakePaused(),
    notify: (command) => effects.slack(`intake-paused:${command.runId}`, command,
      (credentialFetch) => new MeetingMinutesSlackClient(undefined, credentialFetch)
        .postIntakePausedToUser(command.channelId, command.userId, command.runId)),
    logPaused: (command) => console.info(JSON.stringify({ event: "meeting_minutes_intake_paused", runId: command.runId })),
    logDisabled: (command) => console.info(JSON.stringify({ event: "meeting_minutes_intake_disabled", runId: command.runId })),
    logNotificationFailure: (command, error) => console.warn(JSON.stringify({
      event: "meeting_minutes_intake_notification_failed", runId: command.runId, code: runtimeErrorCode(error),
    })),
  });
  if (commandGate === "blocked") return { outcome: "completed" };
  await effects.boundary("durable_object", async () => {
    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
      tenantId, selection.workspaceId, selection.runId,
    ));
    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
      const clients = meetingMinutesClients(env, effects, tenantContext, tenantBoundaryHandle);
      const recoveryEvent: MeetingMinutesRecovery = {
        kind: "meeting_minutes_recovery",
        runId: selection.runId,
        workspaceId: selection.workspaceId,
        appId: selection.appId,
        channelId: selection.channelId,
        threadTs: selection.threadTs,
        userId: selection.userId,
        actionTs: selection.actionTs,
      };
      const currentRun = await loadMeetingMinutesRun(workspace.fs, selection.runId);
      if (!currentRun) throw new Error("meeting_minutes_run_not_found");
      currentRun.recoveryAuthorization = meetingMinutesRecoveryAuthorization(
        tenantContext, expectedScope, recoveryEvent,
      );
      currentRun.updatedAt = now();
      await saveMeetingMinutesRun(workspace.fs, currentRun);
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
          fallbackStatus: (run, outcome) => clients.slack.fallbackStatus(run, outcome),
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

async function processTenantMeetingMinutesRedo(input: {
  env: Env;
  config: ReturnType<typeof meetingMinutesRuntimeConfig>;
  command: MeetingMinutesRedo;
  tenantContext: TenantContextEnvelope;
  expectedScope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
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
    tenantBoundaryHandle,
  } = input;
  const effects = createMeetingMinutesTenantEffectGuard({
    env,
    tenant_context: tenantContext,
    expected_scope: expectedScope,
    verifier,
    now,
  });
  const commandGate = await gateMeetingMinutesCommandQueueMessage({
    body: command,
    ack: () => undefined,
    retry: () => undefined,
  }, {
    enabled: config.enabled,
    isPaused: () => meetingMinutesDeploymentGate(env, tenantContext.tenant.tenant_id).isIntakePaused(),
    notify: (queuedCommand) => effects.slack(`intake-paused:${queuedCommand.runId}`, queuedCommand,
      (credentialFetch) => new MeetingMinutesSlackClient(undefined, credentialFetch)
        .postIntakePausedToUser(queuedCommand.channelId, queuedCommand.userId, queuedCommand.runId)),
    logPaused: (queuedCommand) => console.info(JSON.stringify({
      event: "meeting_minutes_intake_paused", runId: queuedCommand.runId,
    })),
    logDisabled: (queuedCommand) => console.info(JSON.stringify({
      event: "meeting_minutes_intake_disabled", runId: queuedCommand.runId,
    })),
    logNotificationFailure: (queuedCommand, error) => console.warn(JSON.stringify({
      event: "meeting_minutes_intake_notification_failed", runId: queuedCommand.runId,
      code: runtimeErrorCode(error),
    })),
  });
  if (commandGate === "blocked") return { outcome: "completed" };
  await effects.boundary("durable_object", async () => {
    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
      tenantContext.tenant.tenant_id, command.workspaceId, command.runId,
    ));
    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
      const clients = meetingMinutesClients(env, effects, tenantContext, tenantBoundaryHandle);
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
    if (url.pathname === "/slack/installations/oauth/start") {
      if (!env.SLACK_INSTALLATION_CONTROL_PLANE || !env.SLACK_OAUTH_APP_ID
        || !env.SLACK_OAUTH_CLIENT_ID || !env.SLACK_OAUTH_REDIRECT_URI || !env.SLACK_OAUTH_SCOPES) {
        return Response.json({ error: "oauth_configuration_invalid" }, { status: 503 });
      }
      const controlPlane = createSlackInstallationControlPlaneClient(
        env.SLACK_INSTALLATION_CONTROL_PLANE,
        env.SLACK_OAUTH_APP_ID,
      );
      return handleSlackOAuthStartRequest(request, {
        authorizer: controlPlane,
        intents: createDurableSlackInstallationIntentClient(env.TENANT_RUNTIME_STATE),
        app_id: env.SLACK_OAUTH_APP_ID,
        client_id: env.SLACK_OAUTH_CLIENT_ID,
        redirect_uri: env.SLACK_OAUTH_REDIRECT_URI,
        scopes: env.SLACK_OAUTH_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean),
      });
    }
    if (url.pathname === "/slack/installations/oauth/callback") {
      if (!env.SLACK_INSTALLATION_CONTROL_PLANE || !env.SLACK_OAUTH_REDIRECT_URI || !env.SLACK_OAUTH_APP_ID) {
        return Response.json({ error: "oauth_configuration_invalid" }, { status: 503 });
      }
      const controlPlane = createSlackInstallationControlPlaneClient(
        env.SLACK_INSTALLATION_CONTROL_PLANE,
        env.SLACK_OAUTH_APP_ID,
      );
      return handleSlackOAuthCallbackRequest(request, {
        intents: createDurableSlackInstallationIntentClient(env.TENANT_RUNTIME_STATE),
        control_plane: controlPlane,
        redirect_uri: env.SLACK_OAUTH_REDIRECT_URI,
      });
    }
    if (url.pathname.startsWith("/admin/sandbox/")) {
      if (request.method === "POST" && url.pathname === "/admin/sandbox/meeting-minutes-probe") {
        if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const boundary = await resolveDurableTenantBoundaryContext(
          env.TENANT_RUNTIME_STATE,
          request,
          ["mcp_gateway", "brainbase_proxy"],
          new Date().toISOString(),
        );
        if (boundary instanceof Response) return boundary;
        return handleSandboxAdminRequest(request, env, {
          createSandbox: (id) => createTechKnightSandbox(env, id),
          tenantBoundaryHandle: request.headers.get(TENANT_BOUNDARY_HANDLE_HEADER)!,
        });
      }
      return handleSandboxAdminRequest(request, env, {
        createSandbox: (id) => createTechKnightSandbox(env, id),
      });
    }
    if (request.method === "GET" && url.pathname === "/admin/meeting-minutes/deploy-gate") {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(await meetingMinutesDeploymentGate(
        env, requiredRuntimeBinding(env.TENANT_ID),
      ).status());
    }
    if (request.method === "POST" && url.pathname === "/admin/tenant-credential/bootstrap-slack") {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return bootstrapUnsonSlackCredential(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/meeting-minutes/intake") {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const boundary = await resolveDurableTenantBoundaryContext(
        env.TENANT_RUNTIME_STATE, request, ["brainbase_proxy"], new Date().toISOString(),
      );
      if (boundary instanceof Response) return boundary;
      const gate = meetingMinutesDeploymentGate(env, boundary.tenant_context.tenant.tenant_id);
      return handleMeetingMinutesIntakeAdminRequest(request, {
        authorize: async () => true,
        setPaused: (paused) => gate.setIntakePaused(paused),
        status: () => gate.status(),
      });
    }
    const runAdminMatch = url.pathname.match(/^\/admin\/meeting-minutes\/runs\/([A-Za-z0-9_-]{3,260})(\/retry|\/adopt-tasks)?$/);
    if (runAdminMatch && (request.method === "GET" || request.method === "POST")) {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const adminBoundary = await resolveDurableTenantBoundaryContext(
        env.TENANT_RUNTIME_STATE, request, ["brainbase_proxy"], new Date().toISOString(),
      );
      if (adminBoundary instanceof Response) return adminBoundary;
      const runId = runAdminMatch[1]!;
      const adminTenantContext = adminBoundary.tenant_context;
      const adminTenantId = adminTenantContext.tenant.tenant_id;
      const adminWorkspaceId = adminTenantContext.workspace_connection.workspace_id;
      const workspaceId = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        adminTenantId, adminWorkspaceId, runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(workspaceId) as unknown as WorkspaceHandle;
      let run = await withDisposableResource(() => getWorkspace(handle),
        (workspace) => loadMeetingMinutesRun(workspace.fs, runId));
      if (!run) return Response.json({ error: "meeting_minutes_run_not_found" }, { status: 404 });
      if (run.workspaceId !== adminWorkspaceId
        || run.sourceAppId !== adminTenantContext.workspace_connection.app_id
        || run.sourceChannelId !== adminTenantContext.slack.channel_id
        || run.sourceThreadTs !== adminTenantContext.slack.thread_ts) {
        return Response.json({ error: "meeting_minutes_admin_tenant_context_mismatch" }, { status: 403 });
      }
      if (request.method === "POST") {
        if (!runAdminMatch[2] || !run.destination) {
          return Response.json({ error: "meeting_minutes_retry_not_available" }, { status: 409 });
        }
        let payload: { taskIds?: unknown; actionTs?: unknown } | null;
        try {
          const parsed = await readAdminJsonRequest(request);
          payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as { taskIds?: unknown; actionTs?: unknown } : null;
        } catch (error) {
          const rejected = adminJsonInputErrorResponse(error);
          if (rejected) return rejected;
          throw error;
        }
        const actionTs = typeof payload?.actionTs === "string"
          && /^\d{1,20}(?:\.\d{1,12})?$/.test(payload.actionTs)
          ? payload.actionTs : undefined;
        if (!actionTs) {
          return Response.json({ error: "meeting_minutes_admin_tenant_context_required" }, { status: 400 });
        }
        const selection = { kind: "meeting_minutes_selection", runId,
          destinationId: run.destination.id, workspaceId: adminWorkspaceId,
          appId: adminTenantContext.workspace_connection.app_id,
          channelId: adminTenantContext.slack.channel_id,
          userId: adminTenantContext.actor.authenticated_subject_id,
          threadTs: adminTenantContext.slack.thread_ts,
          actionTs } satisfies MeetingMinutesSelection;
        const tenantBody: TenantQueueBody<MeetingMinutesSelection> = {
          schema_version: "1.0",
          tenant_context: adminTenantContext,
          payload: selection,
        };
        const expectedScope = expectedTenantMeetingMinutesSelectionScope(env, tenantBody);
        const runtimeClients = tenantRuntimeClients(env);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => runtimeClients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const effects = createMeetingMinutesTenantEffectGuard({
          env, tenant_context: tenantBody.tenant_context, expected_scope: expectedScope,
          verifier, now: () => new Date().toISOString(),
        });
        if (runAdminMatch[2] === "/adopt-tasks") {
          const taskIds = validateMeetingMinutesAdminTaskIds(payload) ?? [];
          const generatedTasks = run.generated?.tasks ?? [];
          const conflictRepair = run.taskRegistration?.failure?.status === 409;
          const incompleteAdoption = run.taskRegistration?.registered.length === generatedTasks.length &&
            run.diagnostics?.stage === "task_registration";
          if ((!conflictRepair && !incompleteAdoption) ||
            taskIds.length !== generatedTasks.length) {
            return Response.json({ error: "meeting_minutes_task_adoption_invalid" }, { status: 409 });
          }
          const tasks = await effects.boundary("brainbase_proxy", (credentialFetch) => {
            const taskApi = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
              fetchImpl: credentialFetch });
            return Promise.all(taskIds.map((taskId) => taskApi.getTask(taskId)));
          });
          const projectCodes = run.destination.taskProjectCodes;
          if (tasks.some((task) => !projectCodes.every((code) => (task.project_codes ?? []).includes(code)))) {
            return Response.json({ error: "meeting_minutes_task_adoption_scope_mismatch" }, { status: 409 });
          }
          run = await effects.boundary("durable_object", () => withDisposableResource(
            () => getWorkspace(handle), async (workspace) => {
            const current = (await loadMeetingMinutesRun(workspace.fs, runId))!;
            const repairFailure = current.taskRegistration?.failure ?? { index: 0, stage: "task_registration" as const,
              message: "meeting_minutes_task_registration_failed", status: 409,
              failedAt: new Date().toISOString() };
            current.taskRegistration = { registered: tasks.map((task, index) => ({ index,
              title: task.title, taskId: task.id, status: "reused" as const,
              projectCodes: [...projectCodes] })), failure: repairFailure };
            current.updatedAt = new Date().toISOString();
            await saveMeetingMinutesRun(workspace.fs, current);
            return current;
          }));
        }
        await effects.boundary("queue_consumer", () => env.TECHKNIGHT_EVENTS.send(tenantBody));
      }
      return Response.json({ runId: run.runId, status: run.status,
        destinationId: run.destination?.id, diagnostics: run.diagnostics,
        taskRegistration: { registeredCount: run.taskRegistration?.registered.length ?? 0,
          failure: run.taskRegistration?.failure,
          failedCandidateTitle: run.taskRegistration?.failure
            ? run.generated?.tasks?.[run.taskRegistration.failure.index]?.title : undefined },
        checkpoint: { hasGitHub: Boolean(run.github), hasSlackParent: Boolean(run.slack?.parentTs),
          postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0 },
        ...(request.method === "POST" ? { enqueued: true } : {}) });
    }
    if (request.method === "POST" && url.pathname === "/internal/contract-ledger/sync") {
      const authorization = request.headers.get("authorization");
      if (!env.CONTRACT_LEDGER_TRIGGER_TOKEN || authorization !== `Bearer ${env.CONTRACT_LEDGER_TRIGGER_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const config = contractLedgerConfig(env);
      if (!config.enabled) return Response.json({ error: "contract_ledger_disabled" }, { status: 503 });
      const event = scheduledContractLedgerEvent(new Date(), config.fromDate);
      await env.CONTRACT_LEDGER_SYNCS.send(event);
      return Response.json({ ok: true, queued: true, runId: event.runId, idempotencyKey: event.idempotencyKey });
    }
    if (request.method === "POST" && url.pathname === "/development/callback") {
      const placements = canonicalRuntimePlacements(env);
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
            trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
              env,
              tenant_context: callbackBoundary.tenant_context,
            }),
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
              fetch: tenantCredentialFetch,
            }),
          });
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const developmentPlacements = placements.filter((placement) => placement.developmentEnabled === true);
      const improvementResponse = await handleManaImprovementInteraction(
        request.clone() as unknown as globalThis.Request,
        {
        signingSecret: env.SLACK_SIGNING_SECRET,
        expectedAppId: env.SLACK_EXPECTED_APP_ID,
        placements: developmentPlacements.map((placement) => ({
          channelId: placement.channelId,
          allowedUserIds: placement.audience?.allowedUserIds ?? [],
        })),
        defer: (work) => ctx.waitUntil(work),
        accept: async (submission) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const submissionIdentity: TenantInteractionIdentity = {
            app_id: submission.appId,
            workspace_id: submission.workspaceId,
            event_id: submission.eventId,
            channel_id: submission.channelId,
            thread_ts: submission.interactionThreadTs,
            requester_id: submission.requesterId,
          };
          const resolved = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...submissionIdentity },
            required_scopes: requiredScopes,
            ...placementAuthorizationForIdentity(env, submissionIdentity),
            authority: clients.authority,
            now: submission.receivedAt,
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          const expectedScope: ExpectedTenantScope = {
            audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
            workspace_id: submission.workspaceId,
            app_id: submission.appId,
            channel_id: submission.channelId,
            thread_ts: submission.interactionThreadTs,
            actor_principal_id: resolved.tenant_context.actor.principal_id,
            project_id: resolved.tenant_context.authorization.project_ids[0]!,
            project_ids: [...resolved.tenant_context.authorization.project_ids],
            capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
            deployment_id: resolved.tenant_context.placement.deployment_id,
          };
          const tenantCredentialFetch = createTenantCredentialFetch({
            envelope: resolved.tenant_context,
            expected_scope: expectedScope,
            broker: clients.credential_broker,
            trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
              env,
              tenant_context: resolved.tenant_context,
            }),
            read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
              resolved.tenant_context.workspace_connection.connection_id),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
            now: () => new Date().toISOString(),
          });
          const threadTs = await postManaImprovementAcceptance({
            fetchImpl: tenantCredentialFetch,
            channelId: submission.channelId,
            requesterId: submission.requesterId,
            request: submission.request,
          });
          const queued = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...submissionIdentity, thread_ts: threadTs },
            required_scopes: requiredScopes,
            ...placementAuthorizationForIdentity(env, { ...submissionIdentity, thread_ts: threadTs }),
            authority: clients.authority,
            now: submission.receivedAt,
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          await env.TECHKNIGHT_EVENTS.send({
            schema_version: "1.0",
            tenant_context: queued.tenant_context,
            payload: {
              eventId: submission.eventId,
              tenantId: queued.tenant_context.tenant.tenant_id,
              workspaceId: submission.workspaceId,
              channelId: submission.channelId,
              threadTs,
              messageTs: threadTs,
              userId: submission.requesterId,
              eventType: "app_mention",
              text: `/develop ${serializeManaImprovementRequest(submission.request)}`,
              receivedAt: submission.receivedAt,
            },
          });
        },
        onDeferredError: (error, submission) => {
          console.error("mana_improvement_accept_failed", {
            eventId: submission.eventId,
            error: error instanceof Error ? error.message : "unknown",
          });
        },
      });
      if (improvementResponse) return improvementResponse;
      const config = meetingMinutesRuntimeConfig(env);
      const resolveInteractionEffects = createTenantInteractionEffectResolver(env);
      let canonicalInteractionTenantId: string | undefined;
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
            }), { ...env, BRAINBASE_TASK_API_TOKEN: undefined,
              SLACK_BOT_TOKEN: undefined })));
          if (!approved.ok) return restoreSerializableResponse(approved);
          return Response.json({ ok: true, approval_id: approvalId });
        }, undefined, async (payload, effects) => {
          const parsedTeamIds = (() => {
            try { return destinationTeamIdsForTaskActions(env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON); }
            catch { return {}; }
          })();
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
            destinations: config.destinations,
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
                undefined, tenantFetch).updateTaskCard(run));
            },
            notifyScopeMismatch: async (run, userId, failure) => {
              await effects.slackDelivery(`task-scope-mismatch:${run.runId}:${userId}`, {
                channel_id: run.destination!.slackChannelId,
              }, { kind: "task_scope_mismatch", runId: run.runId, userId },
              (tenantFetch) => new MeetingMinutesSlackClient(
                undefined, tenantFetch).postTaskScopeMismatch(run, userId, failure));
            },
            notifyTaskActionFailure: async (run, userId, action, failure) => {
              await effects.slackDelivery(`task-action-failure:${run.runId}:${userId}:${action}`, {
                channel_id: run.destination!.slackChannelId,
              }, { kind: "task_action_failure", runId: run.runId, userId, action },
              (tenantFetch) => new MeetingMinutesSlackClient(
                undefined, tenantFetch).postTaskActionFailure(run, userId, action, failure));
            },
            openView: async (organizationId, triggerId, view) => {
              await effects.slackDelivery(`task-edit-view:${organizationId}`, {},
                { kind: "task_edit_view", organizationId },
                (tenantFetch) => new MeetingMinutesSlackClient(
                  undefined, tenantFetch).openTaskEditView(triggerId, view));
            },
            listPeople: () => effects.brainbaseProxy(
              "task-assignee-list", sourceTarget(canonicalSource()), "read",
              (tenantFetch) => listGraphPeople(undefined, {
                baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
                fetch: tenantFetch,
              })),
            repairTaskBoard: (targetId) => effects.durableObject(
              `task-board-repair:${targetId}`,
              sourceTarget(canonicalSource()),
              () => enqueueMeetingMinutesTaskBoardRepair(
                env,
                targetId,
                "task_write",
                (repair) => resolveTaskBoardRepairTenantContext(env, repair),
              ),
            ),
            defer: (work) => ctx.waitUntil(work),
          });
        }, async (command, destination) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const commandIdentity: TenantInteractionIdentity = {
            app_id: command.appId,
            workspace_id: command.workspaceId,
            event_id: command.kind === "meeting_minutes_selection"
              ? meetingMinutesSelectionEventId(command)
              : meetingMinutesRedoEventId(command),
            channel_id: command.channelId,
            thread_ts: command.threadTs,
            requester_id: command.userId,
          };
          const destinationAuthorization = command.kind === "meeting_minutes_selection"
            ? destinationAuthorizationForSelection(env, destination)
            : undefined;
          const resolved = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...commandIdentity },
            required_scopes: requiredScopes,
            ...(destinationAuthorization ?? placementAuthorizationForIdentity(env, commandIdentity)),
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
        }, async (identity) => {
          const effects = await resolveInteractionEffects(identity);
          canonicalInteractionTenantId = effects.tenant_id;
          return effects;
        }, () => {
          if (!canonicalInteractionTenantId) deny("worker_ingress", "TENANT_CONTEXT_MISSING");
          return meetingMinutesDeploymentGate(env, canonicalInteractionTenantId).isIntakePaused();
        }, async (payload) => {
          const event = parseContractLedgerSlackAction(payload, contractLedgerConfig(env));
          if (!event) return undefined;
          await env.CONTRACT_LEDGER_SYNCS.send(event);
          return Response.json({ ok: true, queued: true, decision: event.decision, envelope_id: event.envelopeId });
        });
    }
    if (request.method === "POST" && url.pathname === "/slack/commands") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const developmentPlacements = placements.filter((placement) => placement.developmentEnabled === true);
      return handleSlackCommandRequest(request, { signingSecret: env.SLACK_SIGNING_SECRET,
        placements: developmentPlacements.map((placement) => ({ channelId: placement.channelId,
          allowedUserIds: placement.audience?.allowedUserIds ?? [] })),
        openModal: async (input) => {
          const clients = tenantRuntimeClients(env);
          const receivedAt = new Date().toISOString();
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const modalIdentity: TenantInteractionIdentity = {
            app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
            workspace_id: input.workspaceId,
            event_id: `slash_modal_${input.triggerId}`,
            channel_id: input.channelId,
            thread_ts: input.triggerId,
            requester_id: input.requesterId,
          };
          const resolved = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...modalIdentity },
            required_scopes: requiredScopes,
            ...placementAuthorizationForIdentity(env, modalIdentity),
            authority: clients.authority,
            now: receivedAt,
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          const expectedScope: ExpectedTenantScope = {
            audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
            workspace_id: input.workspaceId,
            app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
            channel_id: input.channelId,
            thread_ts: input.triggerId,
            actor_principal_id: resolved.tenant_context.actor.principal_id,
            project_id: resolved.tenant_context.authorization.project_ids[0]!,
            project_ids: [...resolved.tenant_context.authorization.project_ids],
            capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
            deployment_id: resolved.tenant_context.placement.deployment_id,
          };
          const tenantCredentialFetch = createTenantCredentialFetch({
            envelope: resolved.tenant_context,
            expected_scope: expectedScope,
            broker: clients.credential_broker,
            trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
              env,
              tenant_context: resolved.tenant_context,
            }),
            read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
              resolved.tenant_context.workspace_connection.connection_id),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
            now: () => new Date().toISOString(),
          });
          return openManaImprovementModal({
            fetchImpl: tenantCredentialFetch,
            triggerId: input.triggerId,
            metadata: {
              workspaceId: input.workspaceId,
              channelId: input.channelId,
              requesterId: input.requesterId,
              command: input.command,
            },
            initialProblem: input.initialProblem,
          });
        },
        defer: (work) => ctx.waitUntil(work.then(() => undefined)),
        send: async (event) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const commandIdentity: TenantInteractionIdentity = {
            app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
            workspace_id: event.workspaceId,
            event_id: event.eventId,
            channel_id: event.channelId,
            thread_ts: event.threadTs,
            requester_id: event.userId ?? "",
          };
          const resolved = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...commandIdentity },
            required_scopes: requiredScopes,
            ...placementAuthorizationForIdentity(env, commandIdentity),
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
      const placements = canonicalRuntimePlacements(env);
      return handleTenantSlackRequest(request, {
        signing_secret: env.SLACK_SIGNING_SECRET,
        expected_app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
        required_scopes: requiredScopes,
        required_authorization: {
          audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
          capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
        },
        placement_config: {
          tenantId: requiredRuntimeBinding(env.TENANT_ID),
          workspaceId: requiredRuntimeBinding(env.SLACK_EXPECTED_TEAM_ID),
          placements,
        },
        authority: clients.authority,
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        send: (event) => env.TECHKNIGHT_EVENTS.send(event),
      });
    } catch (error) {
      const code = error instanceof TenantBoundaryError || error instanceof RuntimeBindingError
        ? error.code : "CONFIGURATION_INVALID";
      const stage = "runtime_configuration";
      const requestSeed = [
        request.headers.get("x-slack-request-timestamp") ?? "unknown",
        request.headers.get("x-slack-retry-num") ?? "0",
      ].join(":");
      const correlationId = deriveCorrelationId(requestSeed, stage, code);
      console.error(JSON.stringify({
        event: "slack_tenant_ingress_failed",
        stage,
        code,
        correlation_id: correlationId,
        retryable: true,
        ...(error instanceof TenantBoundaryError ? { boundary: error.boundary } : {}),
      }));
      return Response.json({
        error: code,
        stage,
        correlation_id: correlationId,
        retryable: true,
      }, {
        status: 503,
        headers: {
          "x-mana-error-code": code,
          "x-mana-failure-stage": stage,
          "x-mana-correlation-id": correlationId,
        },
      });
    }
  },

  async queue(batch: MessageBatch<TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
    | TenantQueueBody<MeetingMinutesRedo>
    | TenantQueueBody<MeetingMinutesRecovery>
    | TenantQueueBody<TaskBoardRepairEvent>
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent
    | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>, env: Env): Promise<void> {
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
      if (isContractLedgerEvent(message.body)) {
        if (batch.queue === "unson-business-contract-ledger-syncs-dlq") {
          try { await notifyContractLedgerDeadLetter(message.body, env); message.ack(); }
          catch (error) {
            console.error(JSON.stringify({ event: "contract_ledger_dlq_notification_failed", runId: message.body.runId,
              error: error instanceof Error ? error.message : "unexpected_error" }));
            message.retry();
          }
          continue;
        }
        try {
          if (message.body.kind === "contract_ledger_sync") {
            const receipt = await processContractLedgerSync(message.body, env);
            console.log(JSON.stringify({ event: "contract_ledger_sync_completed", ...receipt }));
          } else {
            const outcome = await processContractLedgerApproval(message.body, env);
            console.log(JSON.stringify({ event: "contract_ledger_approval_completed", runId: message.body.runId,
              envelopeId: message.body.envelopeId, decision: message.body.decision, outcome }));
          }
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "contract_ledger_processing_failed", kind: message.body.kind,
            runId: message.body.runId, error: error instanceof Error ? error.message : "unexpected_error" }));
          message.retry();
        }
        continue;
      }
      if (ackMalformedTenantQueueMessage(message,
        (entry) => console.error(JSON.stringify(entry)))) {
        continue;
      }
      if (isTenantTaskBoardRepairBody(message.body)) {
        const tenantBody = message.body;
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantTaskBoardRepairScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: (options) => message.retry(options),
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
              trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
                env,
                tenant_context: tenantContext,
              }),
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
              usage_unit: "task_board_refresh",
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
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantMeetingMinutesRedoScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: (options) => message.retry(options),
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
            usage_unit: "model_tokens",
            now,
            process: () => executeTenantContainerOperation({
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
                  tenantBoundaryHandle,
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
        await handleMeetingMinutesRecoveryQueue({
          body: tenantBody,
          ack: () => message.ack(),
          retry: (options) => message.retry(options),
        }, env, {
          reissueTenantContext: (runtimeEnv, body) =>
            reissueMeetingMinutesRecoveryTenantContext(runtimeEnv, body),
          readAuthoritativeSnapshot: (runtimeEnv, tenantContext, connectionId) =>
            tenantRuntimeClients(runtimeEnv, tenantContext).authority.read_workspace_connection(connectionId),
          resolveVerificationKey: (runtimeEnv, keyId) => resolveTenantVerificationKey(runtimeEnv, keyId),
          deploymentProfile: tenantDeploymentProfile,
          requiredAudience: (runtimeEnv) => requiredRuntimeBinding(runtimeEnv.MANA_REQUIRED_AUDIENCE),
          requiredCapabilityId: (runtimeEnv) => requiredRuntimeBinding(runtimeEnv.MANA_REQUIRED_CAPABILITY_ID),
          resolveProjectScope: (runtimeEnv, body) => expectedProjectScopeForEvent(runtimeEnv, {
            tenantId: body.tenant_context.tenant.tenant_id,
            eventId: meetingMinutesRecoveryEventId(body.payload),
            workspaceId: body.payload.workspaceId,
            channelId: body.payload.channelId,
            threadTs: body.payload.threadTs,
            messageTs: body.payload.threadTs,
            userId: body.payload.userId,
            eventType: "message",
            text: "",
            receivedAt: body.payload.actionTs,
          }, body.tenant_context),
          now: () => new Date().toISOString(),
          ownership: (runtimeEnv, tenantId) =>
            createDurableTenantStateClient(runtimeEnv.TENANT_RUNTIME_STATE, tenantId),
          payloadHash: tenantPayloadHash,
          retentionUntil: tenantRetentionUntil,
          executeBoundary: ({ env: runtimeEnv, boundary, tenantContext, expectedScope, verifier, now, execute }) =>
            createMeetingMinutesTenantEffectGuard({ env: runtimeEnv, tenant_context: tenantContext,
              expected_scope: expectedScope, verifier, now }).boundary(boundary, execute),
          executeSlack: ({ env: runtimeEnv, effectId, event, tenantContext, expectedScope, verifier, now, execute }) =>
            createMeetingMinutesTenantEffectGuard({ env: runtimeEnv, tenant_context: tenantContext,
              expected_scope: expectedScope, verifier, now }).slack(effectId, event, execute),
          withWorkspace: ({ env: runtimeEnv, tenantContext, recovery, execute }) => {
            const id = runtimeEnv.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
              tenantContext.tenant.tenant_id, recovery.workspaceId, recovery.runId,
            ));
            const handle = runtimeEnv.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
            return withDisposableResource(() => getWorkspace(handle), (workspace) => execute(workspace.fs));
          },
          markTerminal: (runtimeEnv, tenantId, runId) =>
            meetingMinutesDeploymentGate(runtimeEnv, tenantId).markTerminal(runId),
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
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context);
        const verifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const expectedScope = expectedTenantMeetingMinutesSelectionScope(env, tenantBody);
        const now = () => new Date().toISOString();
        await consumeTenantQueueMessage({
          body: tenantBody,
          ack: () => message.ack(),
          retry: (options) => message.retry(options),
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
            usage_unit: "model_tokens",
            now,
            process: () => executeTenantContainerOperation({
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
                  tenantBoundaryHandle,
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
      const clients = tenantRuntimeClients(env, tenantBody.tenant_context);
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
          retry: (options) => message.retry(options),
        }, {
          ...tenantConsumerOptions,
          process: async (event: SlackQueueEvent, tenantContext) => executeTenantRuntimeOperation({
            tenant_context: tenantContext,
            expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
            verifier,
            quota: clients.quota,
            accounting: clients.accounting,
            ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
            usage_unit: "model_tokens",
            now: tenantConsumerOptions.now,
            process: async () => {
              const expectedScope = tenantConsumerOptions.expected_scope(tenantBody);
              const intakeEffects = createMeetingMinutesTenantEffectGuard({
                env,
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                now: tenantConsumerOptions.now,
              });
              const routerGate = await gateMeetingMinutesRouterQueueMessage({
                body: event,
                ack: () => undefined,
                retry: () => undefined,
              }, {
                enabled: meetingMinutesConfig.enabled,
                routerChannelId: meetingMinutesConfig.routerChannelId,
                isPaused: () => meetingMinutesDeploymentGate(env, runtimeTenantId).isIntakePaused(),
                notify: (channelId, threadTs, eventId) => intakeEffects.slack(
                  `intake-paused:${event.eventId}`,
                  event,
                  (credentialFetch) => new MeetingMinutesSlackClient(undefined, credentialFetch)
                    .postIntakePaused(channelId, threadTs, eventId),
                ),
                logPaused: (eventId) => console.info(JSON.stringify({
                  event: "meeting_minutes_intake_paused", eventId,
                })),
                logDisabled: (eventId) => console.info(JSON.stringify({
                  event: "meeting_minutes_intake_disabled", eventId,
                })),
                logNotificationFailure: (eventId, error) => console.warn(JSON.stringify({
                  event: "meeting_minutes_intake_notification_failed", eventId, code: runtimeErrorCode(error),
                })),
              });
              if (routerGate === "blocked") return { outcome: "awaiting_destination" };
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
                  usage_unit: "model_tokens",
                  now: tenantConsumerOptions.now,
                  process: () => executeTenantContainerOperation({
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
                    const runId = `${childEvent.eventId}_${file.id}`;
                    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
                      runtimeTenantId, event.workspaceId, runId,
                    ));
                    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
                    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
                      const meetingClients = meetingMinutesClients(
                        env,
                        effects,
                        childTenantContext,
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
        retry: (options) => message.retry(options),
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
          let deliveryClaimToken: string | undefined;
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
                botAttributedAppMentionUserIds: placement.audience?.allowedUserIds,
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
              const runtimeClaim = await workspaceStub.claimRuntimeEvent(deliveryId);
              if (runtimeClaim.disposition === "completed") {
                return {
                  outcome: "already_completed" as const,
                  ...(runtimeClaim.responseTs ? { responseTs: runtimeClaim.responseTs } : {}),
                };
              }
              if (runtimeClaim.disposition === "in_progress") {
                // Another delivery still owns this canonical Slack message. Do
                // not complete the outer Queue claim: retry until the owner
                // completes or its runtime lease can be reclaimed.
                throw new TenantBoundaryError("idempotency", "UPSTREAM_UNAVAILABLE");
              }
              deliveryClaimToken = runtimeClaim.claimToken;
              const expectedScope = tenantConsumerOptions.expected_scope(tenantBody);
              const tenantCredentialFetch = createTenantCredentialFetch({
                envelope: tenantContext,
                expected_scope: expectedScope,
                broker: clients.credential_broker,
                trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
                  env,
                  tenant_context: tenantContext,
                }),
                read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                  tenantContext.workspace_connection.connection_id),
                resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
                now: tenantConsumerOptions.now,
              });
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
                usage_unit: quotaUnit,
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
                  doctor: () => runRuntimeDoctor(env, placement.capabilities?.mcp ?? [], tenantCredentialFetch),
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
                          ...placementAuthorizationForEvent(env, manualEvent),
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
                              owner,
                              owner_claim: {
                                key: claimed.claim.key,
                                partition_key: claimed.claim.partition_key,
                              },
                            });
                          },
                          recordContainerDestroyed: async ({ now, receipt }) => {
                            if (claimed.disposition === "claimed") {
                              await terminalOutbox.recordContainerDestroyed(now, receipt);
                            }
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
                  fetch: tenantCredentialFetch,
                  contextAfterTs: workspaceSession.contextAfterTs,
                });
                const withParticipants = { ...hydrated,
                  threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext,
                    { fetchImpl: tenantCredentialFetch }) };
                return hydrateSlackAttachments(withParticipants, {
                  fetchImpl: tenantCredentialFetch,
                });
              };
              return runTenantOperation(async () => {
                const completedReply = await readReplyCompletion(workspace.fs, event.eventId);
                if (completedReply) {
                  return { outcome: "already_completed" as const, responseTs: completedReply.responseTs };
                }
                return executeTenantContainerOperation({
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
                        fetch: tenantCredentialFetch,
                        oauthConfigured: true,
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
                    tenantCredentialFetchConfigured: true,
                  }, async (taskSearch) => {
                    const profileResolution = await resolveSlackUserProfile({ userId: event.userId ?? "",
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
                    fetch: tenantCredentialFetch,
                    oauthConfigured: true,
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
                    botAttributedAppMentionUserIds: placement.audience?.allowedUserIds,
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
                });
              });
              },
            );
            if (deliveryClaimToken) {
              const responseTs = "responseTs" in result && typeof result.responseTs === "string"
                ? result.responseTs
                : undefined;
              if (runtimeClaimSettlement({ outcome: result.outcome, responseTs }) === "complete") {
                await workspaceStub.completeRuntimeEvent(deliveryId, deliveryClaimToken, responseTs);
              } else {
                await workspaceStub.releaseRuntimeEvent(deliveryId, deliveryClaimToken);
              }
            }
            return result;
          } catch (error) {
            if (deliveryClaimToken) await workspaceStub.releaseRuntimeEvent(deliveryId, deliveryClaimToken);
            throw error;
          }
        },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await enqueueScheduledTaskBoardRepair(
      env,
      new Date().toISOString(),
      (repair) => resolveTaskBoardRepairTenantContext(env, repair),
    );
    await enqueueScheduledContractLedgerSync(controller, env);
  },
} satisfies ExportedHandler<Env, TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
  | TenantQueueBody<MeetingMinutesRedo>
  | TenantQueueBody<MeetingMinutesRecovery>
  | TenantQueueBody<TaskBoardRepairEvent>
  | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent
  | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>;
