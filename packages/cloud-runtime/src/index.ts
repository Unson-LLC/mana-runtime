import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceHandle,
} from "@cloudflare/computer";
import { DurableObject } from "./multitenancy/cloudflare-worker-runtime.js";

import { handleTenantSlackRequest } from "./slack.js";
import { bootstrapUnsonSlackCredential } from "./tenant-credential-bootstrap.js";
import { ackMalformedTenantQueueMessage } from "./queue-message-validation.js";
import {
  adminJsonInputErrorResponse,
  readAdminJsonRequest,
  validateMeetingMinutesAdminTaskIds,
} from "./admin-json-input.js";
import { meetingMinutesCompletedProjectionRepair } from "./meeting-minutes-lifecycle.js";
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
import {
  consumeCompanyAuthorityQueueMessage,
  diagnoseCompanyAuthorityRuntimeEnvelope,
  executeCompanyAuthorityRuntimeBoundary,
  isCompanyAuthorityRuntimeEnvelopeCandidate,
  isCompanyAuthorityRuntimeEnvelope,
  type CompanyAuthorityRuntimeEnvelope,
} from "./multitenancy/company-authority-runtime-adapter.js";
import {
  companyAuthorityIngressConfiguration,
  parseCompanyAuthorityRuntimeConfiguration,
} from "./multitenancy/company-authority-runtime-config.js";
import {
  processCompanyAuthorityAutoQueueRoute,
  resolveCompanyAuthoritySlackQueueScope,
  type CompanyAuthorityCapabilityProviderRegistry,
} from "./multitenancy/company-authority-queue-runtime.js";
import { createCompanyAuthoritySelectedContainerProviderRoute } from "./multitenancy/company-authority-selected-container-operation.js";
import {
  companyAuthorityHumanHandoffIdentity,
  processCompanyAuthorityHumanHandoff,
} from "./multitenancy/company-authority-human-handoff.js";
import type { CompanyAuthorityDesiredEffect } from "./multitenancy/company-authority-runtime-adapter.js";
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
import {
  meetingMinutesSelectionDestination,
  resolveMeetingMinutesDestinationAuthorization,
  resolveMeetingMinutesDestinationProjectScope,
} from "./meeting-minutes-selection-scope.js";
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
import { resolveCrossWorkspaceMeetingMinutesSlackToken } from "./meeting-minutes-slack-routing.js";
import { CloudflareMeetingMinutesGitHubClient } from "./meeting-minutes-github.js";
import { classifyMeetingMinutesDestinationInSandbox,
  generateMeetingMinutesInSandbox } from "./meeting-minutes-generator.js";
import { MeetingMinutesBrainbaseContextClient, resolveMeetingMinutesContextMode } from "./meeting-minutes-brainbase-context.js";
import { TaskApiClient } from "@openryoko/task-runtime-core";
import { createMeetingMinutesTaskDeleter } from "./meeting-minutes-task-deletion.js";
import { hasStableMeetingMinutesRecoveryAuthority, isMeetingMinutesAdminRecoveryEligible,
  meetingMinutesRecoveryAuthorityMismatches } from "./meeting-minutes-recovery-authority.js";
import { isReplyEligible, postSlackReply, ReplyPipelineError, type ReplyProcessResult } from "./reply-pipeline.js";
import { executeReplyRuntime } from "./reply-runtime-execution.js";
import { readReplyJudgmentEpisode } from "./reply-judgment.js";
import { resolveActorIdentityResolverFromEnv } from "./slack-actor-identity.js";
import {
  isMeetingTaskRequest,
  processMeetingTaskEvent,
} from "./meeting-task-pipeline.js";
import {
  parseRuntimePlacements,
  RuntimeBindingError,
  resolveRuntimePlacement,
  type ResolvedRuntimePlacement,
} from "./runtime-config.js";
import { routeRuntimeEvent } from "./runtime-event-router.js";
import { persistEventOnce, persistReplyCompletion, readReplyCompletion, type WorkspaceFs } from "./workspace-store.js";
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
  taskBoardRepairCapabilityId,
  taskBoardRepairEventId,
  taskBoardTargets,
} from "./task-runtime-entrypoints.js";
import {
  isTaskBoardRepairEvent,
  type TaskBoardRepairEvent,
} from "./task-board.js";
import { actorIdHash, emitTurnLog, type TurnRuntimeTrace } from "./turn-observability.js";
import {
  claimRuntimeEvent,
  completeRuntimeEvent,
  readRuntimeEventClaim,
  releaseRuntimeEvent,
  runtimeClaimSettlement,
  runtimeDeliveryId,
  shouldAckRuntimeEventInProgress,
} from "./runtime-event-claim.js";
import { runRuntimeTriage } from "./runtime-triage.js";
import { armMeetingMinutesRecovery, isMeetingMinutesRecovery,
  MEETING_MINUTES_RECOVERY_DELAY_SECONDS } from "./meeting-minutes-recovery.js";
import {
  handleMeetingMinutesRecoveryQueue,
  meetingMinutesRecoveryProjectScope,
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
  createDurableCompanyAuthorityHumanHandoffClient,
  createDurableExternalEffectReconciliationQueueClient,
  createDurableExternalEffectOutboxClient,
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
  settleTenantAccountingContinuation,
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
import type { AcceptedCompanyAuthorityContext } from "./multitenancy/company-authority-runtime-adapter.js";
import {
  assertValidExternalEffectReconciliationJob,
  hasVerifiedPendingExternalEffectReconciliation,
  reconcileCompanyAuthorityExternalEffectFromQueue,
  type ExternalEffectProviderResult,
  type ExternalEffectReconciliationJob,
  type ExternalEffectReconciliationQueue,
  type ExternalEffectReconciliationSettlementState,
  type ExternalEffectRecoveryRecord,
} from "./multitenancy/company-authority-external-effect-outbox.js";
import { deny, TenantBoundaryError } from "./multitenancy/errors.js";
import { resolveCanonicalProjectScope } from "./multitenancy/project-scope.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { createTenantCredentialFetch } from "./multitenancy/tenant-credential-fetch.js";
import { readSlackDeliveryReadback } from "./multitenancy/slack-delivery-readback.js";
import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";
import { createBrainbaseTrustedProviderForwarderFromEnv } from "./multitenancy/trusted-provider-forwarder.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  TenantBoundaryContextHandler,
} from "./multitenancy/durable-tenant-boundary.js";
import { executeTenantContainerOperation as executeTenantContainerOperationWithRegistry }
  from "./multitenancy/tenant-container-operation.js";
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
  BRAINBASE_COMPANY_AUTHORITY_BASE_URL?: string;
  BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID?: string;
  BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON?: string;
  MANA_COMPANY_AUTHORITY_OPERATIONS_JSON?: string;
  MANA_COMPANY_AUTHORITY_SLACK_ROLLOUT_JSON?: string;
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
    | CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>
    | ExternalEffectReconciliationJob
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

function companyAuthorityExternalEffectScope(
  context: AcceptedCompanyAuthorityContext,
): { tenant_id: string; effect_id: string } {
  const tenantContext = context.tenant_context as {
    idempotency_key?: unknown;
    tenant?: { tenant_id?: unknown };
  };
  if (typeof tenantContext.idempotency_key !== "string"
    || !tenantContext.idempotency_key.trim()
    || typeof tenantContext.tenant?.tenant_id !== "string"
    || !tenantContext.tenant.tenant_id.trim()) {
    deny("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  return {
    tenant_id: tenantContext.tenant.tenant_id,
    effect_id: tenantContext.idempotency_key,
  };
}

function createCompanyAuthorityProviderRoutes(
  env: Env,
  runtimeConfig: ReturnType<typeof parseCompanyAuthorityRuntimeConfiguration>,
): CompanyAuthorityCapabilityProviderRegistry<SlackQueueEvent> {
  // A0 is deliberately opt-in and capability-specific. Do not route a read or
  // write operation to the external-effect executor, and do not infer a route
  // for capabilities that have no explicit provider implementation.
  if (runtimeConfig.state !== "enabled"
    || env.MANA_REQUIRED_CAPABILITY_ID?.trim() !== "runtime.execute"
    || runtimeConfig.desired_effect_by_capability["runtime.execute"] !== "external_side_effect") {
    return {};
  }
  return {
    "runtime.execute": createCompanyAuthoritySelectedContainerProviderRoute({
      expected_audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      desired_effect_by_capability: runtimeConfig.desired_effect_by_capability,
      create_outbox: (context: AcceptedCompanyAuthorityContext) => {
        return createDurableExternalEffectOutboxClient(
          env.TENANT_RUNTIME_STATE,
          companyAuthorityExternalEffectScope(context),
        );
      },
      create_reconciliation_queue: (context: AcceptedCompanyAuthorityContext): ExternalEffectReconciliationQueue => {
        const durable = createDurableExternalEffectReconciliationQueueClient(
          env.TENANT_RUNTIME_STATE,
          companyAuthorityExternalEffectScope(context),
        );
        // Persist the recovery job before dispatching an internal direct queue
        // message. The worker has no provider-send capability; if dispatch is
        // unavailable the durable job remains available to a later scanner.
        return {
          ...durable,
          enqueue: async (job) => {
            const result = await durable.enqueue(job);
            await env.TECHKNIGHT_EVENTS.send(result.job);
            return result;
          },
        };
      },
      execute_container: (operation) => executeCompanyAuthorityReplyOperation(env, operation),
    }),
  };
}

export class TenantRuntimeState extends DurableObject<Env> {
  readonly #handler = new TenantRuntimeStateHandler(
    this.ctx.storage as unknown as TenantStateStorage,
    this.ctx.id.name,
  );
  readonly #boundaryContext = new TenantBoundaryContextHandler(
    this.ctx.storage,
    async (input) => {
      const clients = tenantRuntimeClients(this.env, input.tenant_context,
        tenantConfiguredDesiredEffectByCapability(this.env));
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(this.env, keyId),
      });
      if (input.company_authority_envelope !== undefined) {
        if (!isCompanyAuthorityRuntimeEnvelope(input.company_authority_envelope)) {
          throw new TenantBoundaryError(input.boundary, "AUTHORITY_ENVELOPE_INVALID");
        }
        const runtimeConfig = parseCompanyAuthorityRuntimeConfiguration(this.env);
        if (runtimeConfig.state !== "enabled") {
          throw new TenantBoundaryError(input.boundary, "AUTHORITY_UNAVAILABLE");
        }
        await executeCompanyAuthorityRuntimeBoundary<SlackQueueEvent, void>({
          boundary: input.boundary,
          // The outer envelope guard validates the protocol carrier. The
          // Slack payload shape and binding are validated below before any
          // boundary effect can run.
          envelope: input.company_authority_envelope as CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>,
          acceptance: { ...runtimeConfig.acceptance, now: input.now },
          tenant_verifier: verifier,
          expected_tenant_scope: input.expected_scope,
          validate_payload_binding: async (context, request, payload) => {
            await resolveCompanyAuthoritySlackQueueScope({
              context,
              request,
              payload,
              expected_audience: requiredRuntimeBinding(this.env.MANA_REQUIRED_AUDIENCE),
              desired_effect_by_capability: runtimeConfig.desired_effect_by_capability,
            });
          },
          require_auto: true,
          execute_auto: async () => undefined,
        });
        return;
      }
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
  async claimRuntimeEvent(eventId: string, preserveUntilReconciled = false) {
    return claimRuntimeEvent(this.ctx.storage, eventId, Date.now(), preserveUntilReconciled);
  }

  async completeRuntimeEvent(eventId: string, claimToken: string, responseTs?: string): Promise<void> {
    await completeRuntimeEvent(this.ctx.storage, eventId, claimToken, responseTs);
  }

  async readRuntimeEventClaim(eventId: string) {
    return readRuntimeEventClaim(this.ctx.storage, eventId);
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

function meetingMinutesAdminRunStatus(run: MeetingMinutesRun) {
  return { runId: run.runId, status: run.status, updatedAt: run.updatedAt,
    destinationId: run.destination?.id, diagnostics: run.diagnostics,
    taskRegistration: { registeredCount: run.taskRegistration?.registered.length ?? 0,
      pendingPresent: Boolean(run.taskRegistration?.pending),
      failure: run.taskRegistration?.failure,
      failedCandidateTitle: run.taskRegistration?.failure
        ? run.generated?.tasks?.[run.taskRegistration.failure.index]?.title : undefined },
    checkpoint: { hasGitHub: Boolean(run.github), hasSlackParent: Boolean(run.slack?.parentTs),
      postedChunkCount: run.slack?.postedChunkIndexes.length ?? 0,
      hasTaskCard: Boolean(run.slack?.taskCardTs) } };
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
  const clients = tenantRuntimeClients(env, undefined,
    tenantConfiguredDesiredEffectByCapability(env));
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
  if (!hasStableMeetingMinutesRecoveryAuthority(fresh, authorization)) {
    console.error(JSON.stringify({ event: "meeting_minutes_recovery_authority_mismatch",
      boundary: "queue_consumer",
      mismatches: meetingMinutesRecoveryAuthorityMismatches(fresh, authorization) }));
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return fresh;
}

async function reissueMeetingMinutesAdminSelectionTenantContext(
  env: Env,
  run: MeetingMinutesRun,
  selection: MeetingMinutesSelection,
): Promise<TenantContextEnvelope> {
  const authorization = run.recoveryAuthorization;
  if (!authorization || !isMeetingMinutesAdminRecoveryEligible(run) || run.runId !== selection.runId || run.workspaceId !== selection.workspaceId ||
    run.sourceAppId !== selection.appId || run.sourceChannelId !== selection.channelId ||
    run.sourceThreadTs !== selection.threadTs || authorization.tenantId.length === 0 ||
    authorization.workspaceId !== selection.workspaceId || authorization.appId !== selection.appId ||
    authorization.channelId !== selection.channelId || authorization.threadTs !== selection.threadTs ||
    authorization.requesterId !== selection.userId || authorization.projectIds.length === 0) {
    deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
  }
  const clients = tenantRuntimeClients(env, undefined,
    tenantConfiguredDesiredEffectByCapability(env));
  const fresh = (await resolveSlackWorkerIngress({
    identity: {
      provider: "slack",
      app_id: authorization.appId,
      workspace_id: authorization.workspaceId,
      event_id: meetingMinutesSelectionEventId(selection),
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
  })).tenant_context;
  if (!hasStableMeetingMinutesRecoveryAuthority(fresh, authorization)) {
    console.error(JSON.stringify({ event: "meeting_minutes_recovery_authority_mismatch",
      boundary: "worker_ingress",
      mismatches: meetingMinutesRecoveryAuthorityMismatches(fresh, authorization) }));
    deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
  }
  return fresh;
}

async function reissueLongRunningTenantContext(
  env: Env,
  accepted: TenantContextEnvelope,
  expectedScope: ExpectedTenantScope,
): Promise<TenantContextEnvelope> {
  const projectIds = [...(expectedScope.project_ids ?? accepted.authorization.project_ids)];
  if (projectIds.length === 0 || !projectIds.includes(expectedScope.project_id)
    || accepted.slack.thread_ts !== expectedScope.thread_ts || !accepted.slack.requester_id) {
    deny("container_launch", "PROJECT_SCOPE_MISMATCH");
  }
  const clients = tenantRuntimeClients(env, undefined,
    tenantConfiguredDesiredEffectByCapability(env));
  const fresh = (await resolveSlackWorkerIngress({
    identity: {
      provider: "slack",
      app_id: accepted.workspace_connection.app_id,
      workspace_id: accepted.workspace_connection.workspace_id,
      event_id: accepted.slack.event_id,
      channel_id: accepted.slack.channel_id,
      thread_ts: accepted.slack.thread_ts,
      requester_id: accepted.slack.requester_id,
    },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: {
      audience: expectedScope.audience,
      project_id: expectedScope.project_id,
      capability_id: expectedScope.capability_id,
    },
    trusted_project_ids: projectIds,
    tenant_revision: accepted.tenant.tenant_revision,
    authority: clients.authority,
    now: new Date().toISOString(),
    resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
  })).tenant_context;
  const sameProjects = [...fresh.authorization.project_ids].sort().join("\0") ===
    [...projectIds].sort().join("\0");
  if (fresh.tenant.tenant_id !== accepted.tenant.tenant_id ||
    fresh.tenant.tenant_revision !== accepted.tenant.tenant_revision ||
    fresh.workspace_connection.connection_id !== accepted.workspace_connection.connection_id ||
    fresh.workspace_connection.connection_revision !== accepted.workspace_connection.connection_revision ||
    fresh.workspace_connection.workspace_id !== expectedScope.workspace_id ||
    fresh.workspace_connection.app_id !== expectedScope.app_id ||
    fresh.actor.principal_id !== expectedScope.actor_principal_id || !sameProjects ||
    fresh.placement.deployment_id !== expectedScope.deployment_id ||
    fresh.placement.profile !== accepted.placement.profile) {
    deny("container_launch", "CROSS_TENANT_CANDIDATE");
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
  options: { workspace_policy?: "same_workspace" | "same_tenant";
    destination?: MeetingMinutesDestination } = {},
  desiredEffectByCapability?: Readonly<Record<string, CompanyAuthorityDesiredEffect>>
    | (() => Readonly<Record<string, CompanyAuthorityDesiredEffect>> | undefined),
): Promise<TenantContextEnvelope> {
  const destinationAuthorization = destinationAuthorizationForSelection(env, options.destination);
  if (options.destination && !destinationAuthorization) deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  const sourceProjectIds = [...(destinationAuthorization?.trusted_project_ids
    ?? sourceTenantContext.authorization.project_ids)];
  if (sourceProjectIds.length === 0) deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  // Keep destination scope validation ahead of runtime configuration parsing.
  // Callers pass a lazy provider so a malformed effect map cannot mask a
  // destination mismatch.
  const resolvedDesiredEffectByCapability = typeof desiredEffectByCapability === "function"
    ? desiredEffectByCapability()
    : desiredEffectByCapability;
  const clients = tenantRuntimeClients(env, undefined, resolvedDesiredEffectByCapability);
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
  let cachedClients: ReturnType<typeof tenantRuntimeClients> | undefined;
  const getClients = (): ReturnType<typeof tenantRuntimeClients> => cachedClients ??= tenantRuntimeClients(
    env, undefined, tenantInteractionDesiredEffectByCapability(env));
  const resolve = (identity: TenantInteractionIdentity,
    destinationAuthorization?: ReturnType<typeof placementAuthorizationForIdentity>) => {
    const placementAuthorization = destinationAuthorization ?? placementAuthorizationForIdentity(env, identity);
    const clients = getClients();
    return resolveSlackWorkerIngress({
      identity: { provider: "slack", ...identity },
      required_scopes: requiredScopes,
      ...placementAuthorization,
      authority: clients.authority,
      now: new Date().toISOString(),
      resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
    });
  };
  return async (source: TenantInteractionIdentity, destination?: MeetingMinutesDestination): Promise<TenantInteractionEffects> => {
    const destinationAuthorization = destinationAuthorizationForSelection(env, destination);
    const sourceResolved = await resolve(source, destinationAuthorization);
    const clients = getClients();
    const sourceTenantContext = sourceResolved.tenant_context;
    const resolveEffect = async (effectId: string, target: TenantInteractionTarget) => {
      const identity: TenantInteractionIdentity = {
        ...source,
        ...target,
        event_id: await childInteractionEventId(source.event_id, effectId),
      };
      const resolved = await resolve(identity, destinationAuthorization);
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
        execute: (tenantContext: TenantContextEnvelope) => Promise<T>): Promise<T> {
        const effect = await resolveEffect(effectId, target);
        return executeTenantBoundary({ boundary: "durable_object", tenant_context: effect.tenantContext,
          expected_scope: effect.expectedScope, verifier: effect.verifier,
          now: new Date().toISOString(), execute: () => execute(effect.tenantContext) });
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
    event: unknown, execute: (credentialFetch: typeof fetch, destinationToken?: string) => Promise<T>): Promise<T>;
}

function createMeetingMinutesTenantEffectGuard(input: {
  env: Env;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
}): MeetingMinutesTenantEffectGuard {
  let clients: ReturnType<typeof tenantRuntimeClients> | undefined;
  const getClients = (): ReturnType<typeof tenantRuntimeClients> => clients ??= tenantRuntimeClients(
    input.env, input.tenant_context, tenantConfiguredDesiredEffectByCapability(input.env));
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
    broker: getClients().credential_broker,
    trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
      env: input.env,
      tenant_context: tenantContext,
    }),
    read_authoritative_snapshot: () => getClients().authority.read_workspace_connection(
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
      read_authoritative_snapshot: () => getClients().authority.read_workspace_connection(
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
      event: unknown, execute: (credentialFetch: typeof fetch, destinationToken?: string) => Promise<T>): Promise<T> {
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
      const destinationToken = resolveCrossWorkspaceMeetingMinutesSlackToken(
        input.env,
        destination.organization.id,
        input.tenant_context.workspace_connection.workspace_id,
        destinationSlackBinding,
      );
      if (destinationToken) {
        return runSlack(effectId, event, input.tenant_context, input.expected_scope, input.verifier,
          (credentialFetch) => execute(credentialFetch, destinationToken));
      }
      const tenantContext = await resolveDerivedSlackTenantContext(input.env, input.tenant_context, {
        app_id: appId,
        workspace_id: workspaceId,
        event_id: await childInteractionEventId(input.tenant_context.slack.event_id, effectId),
        channel_id: destination.slackChannelId,
        thread_ts: destinationThreadTs,
        requester_id: requesterId,
      }, { workspace_policy: "same_tenant" },
        () => tenantConfiguredDesiredEffectByCapability(input.env));
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
        read_authoritative_snapshot: (connectionId) => getClients().authority.read_workspace_connection(connectionId),
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
  const destinationSlack = (destination: MeetingMinutesDestination, credentialFetch: typeof fetch,
    destinationToken?: string) => {
    if (!destinations.some((candidate) => candidate.id === destination.id
      && candidate.slackChannelId === destination.slackChannelId)) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
    return destinationToken
      ? new MeetingMinutesSlackClient(destinationToken)
      : new MeetingMinutesSlackClient(undefined, credentialFetch);
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
        effects.slack(`source-status:${run.runId}:${outcome}:${run.updatedAt}`,
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
          (credentialFetch, destinationToken) => destinationSlack(
            destinationForChannel(channelId), credentialFetch, destinationToken).postParent(
            channelId, fileName, summary, clientMsgId)),
      postTaskCard: (run: MeetingMinutesRun) => effects.destinationSlack(`task-card:${run.runId}`,
        run.destination!, run.slack?.parentTs,
        { kind: "task_card", runId: run.runId, channelId: run.destination!.slackChannelId },
        (credentialFetch, destinationToken) => destinationSlack(
          run.destination!, credentialFetch, destinationToken).postTaskCard(run)),
      repairTaskBoard: async (targetId: string) => {
        const target = taskBoardTargets(env).find((candidate) => candidate.targetId === targetId);
        if (!target) throw new Error(`meeting_minutes_task_board_target_not_found:${targetId}`);
        const destination = destinations.find((candidate) => candidate.taskBoardTargetId === targetId
          && candidate.organization.id === target.organizationId);
        const ambiguousDestination = destinations.some((candidate) => candidate !== destination
          && candidate.taskBoardTargetId === targetId);
        if (!destination || ambiguousDestination) {
          throw new Error(`meeting_minutes_task_board_destination_not_found:${targetId}`);
        }
        const destinationSlackBinding = resolveMeetingMinutesDestinationSlackBinding({
          organizationId: destination.organization.id,
          destination,
          destinationTeamIdsJson: env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON,
          trustedWorkspaceConnections: parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON),
          sourceTenantId: tenantContext.tenant.tenant_id,
          sourceWorkspaceId: tenantContext.workspace_connection.workspace_id,
          sourceAppId: tenantContext.workspace_connection.app_id,
          sourceDeploymentId: tenantContext.placement.deployment_id,
          sourceProfile: tenantContext.placement.profile,
        });
        const repair: TaskBoardRepairEvent = {
          eventType: "task_board_repair",
          tenantId: tenantContext.tenant.tenant_id,
          targetId: target.targetId,
          workspaceId: target.workspaceId,
          channelId: target.channelId,
          manaCanvasId: target.manaCanvasId,
          bindingRevision: target.bindingRevision!,
          reason: "task_write",
          requestedAt: new Date().toISOString(),
        };
        const destinationToken = resolveCrossWorkspaceMeetingMinutesSlackToken(
          env,
          destination.organization.id,
          tenantContext.workspace_connection.workspace_id,
          destinationSlackBinding,
        );
        if (destinationToken) {
          await effects.boundary("slack_delivery", (credentialFetch) => processTaskBoardRepair(
            repair, env, repair.tenantId, globalThis.fetch,
            undefined, undefined, repair.workspaceId, credentialFetch,
            destination.taskProjectCodes, destinationToken,
          ));
          return;
        }
        const repairTenantContext = await resolveTaskBoardRepairTenantContext(env, repair, {
          appId: destinationSlackBinding.app_id,
          destination,
          capabilityId: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
        });
        if (repairTenantContext.tenant.tenant_id !== tenantContext.tenant.tenant_id
          || repairTenantContext.placement.deployment_id !== tenantContext.placement.deployment_id
          || repairTenantContext.placement.profile !== tenantContext.placement.profile) {
          deny("worker_ingress", "CROSS_TENANT_CANDIDATE");
        }
        repair.tenantId = repairTenantContext.tenant.tenant_id;
        const repairBody: TenantQueueBody<TaskBoardRepairEvent> = {
          schema_version: "1.0",
          tenant_context: repairTenantContext,
          payload: repair,
        };
        const repairExpectedScope = expectedTenantTaskBoardRepairScope(env, repairBody);
        const repairClients = tenantRuntimeClients(env, repairTenantContext,
          tenantConfiguredDesiredEffectByCapability(env));
        const repairVerifier = new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: (connectionId) => repairClients.authority.read_workspace_connection(connectionId),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        });
        const repairCredentialFetch = createTenantCredentialFetch({
          envelope: repairTenantContext,
          expected_scope: repairExpectedScope,
          broker: repairClients.credential_broker,
          trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
            env,
            tenant_context: repairTenantContext,
          }),
          read_authoritative_snapshot: () => repairClients.authority.read_workspace_connection(
            repairTenantContext.workspace_connection.connection_id),
          resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          now: () => new Date().toISOString(),
        });
        await executeTenantBoundary({
          boundary: "slack_delivery",
          tenant_context: repairTenantContext,
          expected_scope: repairExpectedScope,
          verifier: repairVerifier,
          now: new Date().toISOString(),
          execute: () => processTaskBoardRepair(repair, env, repair.tenantId, repairCredentialFetch,
            undefined, undefined, repair.workspaceId, repairCredentialFetch, destination.taskProjectCodes),
        });
      },
      postThreadChunk: (channelId: string, threadTs: string, fileName: string, text: string,
        index: number, total: number, clientMsgId: string) =>
        effects.destinationSlack(`destination-thread:${clientMsgId}:${index}`, destinationForChannel(channelId), threadTs,
          { kind: "destination_thread", channelId, threadTs, clientMsgId, index, total },
          (credentialFetch, destinationToken) => destinationSlack(
            destinationForChannel(channelId), credentialFetch, destinationToken).postThreadChunk(
            channelId, threadTs, fileName, text, index, total, clientMsgId)),
    },
    redo: {
      deleteGitHub: (destination: MeetingMinutesDestination, paths: readonly string[]) =>
        effects.boundary("mcp_gateway", () => new CloudflareMeetingMinutesGitHubClient(
          env.GITHUB_TOKEN ?? "").delete(destination.github, paths)),
      deleteTask: createMeetingMinutesTaskDeleter({
        baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
        boundary: effects.boundary,
      }),
      retractSharedMinutes: (destination: MeetingMinutesDestination,
        parentTs: string, fileName: string) =>
        effects.destinationSlack(`retract:${parentTs}`, destination, parentTs,
          { kind: "minutes_retract", channelId: destination.slackChannelId, parentTs },
          (credentialFetch, destinationToken) => destinationSlack(
            destination, credentialFetch, destinationToken).retractSharedMinutes(
            destination.slackChannelId, parentTs, fileName)),
      showDestinationSelection: (run: MeetingMinutesRun,
        destinations: Parameters<MeetingMinutesSlackClient["showDestinationSelection"]>[1]) =>
        effects.slack(`destination-selection:${run.runId}:revision-${run.redo?.revision ?? run.revision ?? 0}`,
          { kind: "destination_selection", runId: run.runId, revision: run.redo?.revision ?? run.revision ?? 0 },
          (credentialFetch) => sourceSlack(credentialFetch).showDestinationSelection(run, destinations)),
      showRedoFailure: (run: MeetingMinutesRun) => effects.slack(
        `redo-failure:${run.runId}:revision-${run.redo?.revision ?? run.revision ?? 0}`,
        { kind: "redo_failure", runId: run.runId, revision: run.redo?.revision ?? run.revision ?? 0 },
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

function tenantRuntimeClients(
  env: Env,
  tenantContext?: TenantContextEnvelope,
  desiredEffectByCapability?: Readonly<Record<string, CompanyAuthorityDesiredEffect>>,
) {
  return createTenantRuntimeHttpClients({
    deployment_profile: tenantDeploymentProfile(env),
    service: env.BRAINBASE_TENANT_RUNTIME_SERVICE,
    timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
    workspace_connections: parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON),
    ...(tenantContext ? { tenant_context: tenantContext } : {}),
    ...(desiredEffectByCapability ? { desired_effect_by_capability: desiredEffectByCapability } : {}),
  });
}

function tenantInteractionDesiredEffectByCapability(
  env: Env,
): Readonly<Record<string, CompanyAuthorityDesiredEffect>> {
  const desiredEffectByCapability = tenantConfiguredDesiredEffectByCapability(env);
  if (!desiredEffectByCapability) {
    deny("runtime_configuration", "CONFIGURATION_INVALID", {
      binding: "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON",
    });
  }
  const capabilityId = requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID);
  const desiredEffect = desiredEffectByCapability[capabilityId];
  if (!desiredEffect) {
    deny("runtime_configuration", "CONFIGURATION_INVALID", {
      binding: "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON",
      capability_id: capabilityId,
    });
  }
  return desiredEffectByCapability;
}

function tenantConfiguredDesiredEffectByCapability(
  env: Env,
): Readonly<Record<string, CompanyAuthorityDesiredEffect>> | undefined {
  const configuration = parseCompanyAuthorityRuntimeConfiguration(env);
  return configuration.state === "enabled"
    ? configuration.desired_effect_by_capability
    : undefined;
}

async function writeDevelopmentTerminalAccounting(env: Env, input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  artifact: AccountingArtifact;
}): Promise<{ result_ref: string }> {
  const clients = tenantRuntimeClients(env, input.tenant_context,
    tenantConfiguredDesiredEffectByCapability(env));
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

export async function resolveTaskBoardRepairTenantContext(
  env: Env,
  repair: TaskBoardRepairEvent,
  options: {
    appId?: string;
    destination?: MeetingMinutesDestination;
    capabilityId?: string;
  } = {},
): Promise<TenantContextEnvelope> {
  const clients = tenantRuntimeClients(env, undefined,
    tenantConfiguredDesiredEffectByCapability(env));
  const serviceActorId = requiredRuntimeBinding(env.MANA_TASK_BOARD_SERVICE_ACTOR_ID);
  const destinationAuthorization = destinationAuthorizationForSelection(env, options.destination);
  if (options.destination && !destinationAuthorization) deny("worker_ingress", "PROJECT_SCOPE_MISMATCH");
  const capabilityId = options.capabilityId ?? taskBoardRepairCapabilityId(
    repair,
    requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
  );
  const placementProjectScope = destinationAuthorization ? undefined : placementProjectScopeForEvent(env, {
    tenantId: env.TENANT_ID,
    eventId: taskBoardRepairEventId(repair),
    workspaceId: repair.workspaceId,
    channelId: repair.channelId,
    threadTs: repair.requestedAt,
    messageTs: repair.requestedAt,
    userId: serviceActorId,
    eventType: "message",
    text: "",
    receivedAt: repair.requestedAt,
  });
  const requiredAuthorization = {
    ...(destinationAuthorization?.required_authorization ?? {
      audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
      project_id: placementProjectScope!.project_id,
    }),
    capability_id: capabilityId,
  };
  const appId = requiredRuntimeBinding(options.appId ?? env.SLACK_EXPECTED_APP_ID);
  const resolved = await resolveSlackWorkerIngress({
    identity: {
      provider: "slack",
      app_id: appId,
      workspace_id: repair.workspaceId,
      event_id: taskBoardRepairEventId(repair),
      channel_id: repair.channelId,
      thread_ts: repair.requestedAt,
      requester_id: serviceActorId,
    },
    required_scopes: requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
      .split(",").map((value) => value.trim()).filter(Boolean),
    required_authorization: requiredAuthorization,
    provider_identity: {
      provider: "service",
      authenticated_subject_id: serviceActorId,
      workspace_id: repair.workspaceId,
      app_id: appId,
    },
    // A destination authorization carries a canonical Brainbase project ID.
    // Do not pass it through the legacy project-code exact-match field: the
    // authority may sign that required destination together with other
    // projects already authorized for the tenant. The required project is
    // checked by required_authorization here, and the exact returned signed
    // set is preserved and verified at the queue boundary.
    ...(destinationAuthorization
      ? {}
      : { trusted_project_ids: placementProjectScope!.project_ids }),
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
    && typeof payload.channelId === "string" && typeof payload.requestedAt === "string"
    && (payload.reason === "task_write" || payload.reason === "scheduled" || payload.reason === "manual");
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

/**
 * Reconciliation jobs are internal queue records, not tenant-context queue
 * bodies. Keep malformed candidates on the reconciliation path so a bad job
 * cannot fall through to the generic malformed-message ACK branch.
 */
function isExternalEffectReconciliationQueueCandidate(
  value: unknown,
): value is ExternalEffectReconciliationJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(body, "tenant_context")
    && (Object.prototype.hasOwnProperty.call(body, "recovery")
      || Object.prototype.hasOwnProperty.call(body, "provider_key")
      || (Object.prototype.hasOwnProperty.call(body, "effect_id")
        && Object.prototype.hasOwnProperty.call(body, "payload_hash")));
}

type ExternalEffectReconciliationProcessor = (
  env: Env,
  job: ExternalEffectReconciliationJob,
) => Promise<"succeeded" | "retry">;

/**
 * Dispatch only the internal readback/settlement worker for a reconciliation
 * candidate. The caller owns the queue message; this function ACKs only after
 * the worker has durably completed every settlement stage.
 */
export async function handleExternalEffectReconciliationQueueMessage(
  input: {
    body: unknown;
    ack(): void;
    retry(): void;
  },
  env: Env,
  reconcile: ExternalEffectReconciliationProcessor = reconcileCompanyAuthorityReplyOperation,
): Promise<boolean> {
  if (!isExternalEffectReconciliationQueueCandidate(input.body)) return false;
  try {
    const job = input.body;
    assertValidExternalEffectReconciliationJob(job);
    const outcome = await reconcile(env, job);
    if (outcome === "succeeded") {
      console.log(JSON.stringify({
        event: "company_authority_external_effect_reconciled",
        tenant_id: job.tenant_id,
        effect_id: job.effect_id,
      }));
      input.ack();
    } else {
      input.retry();
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "company_authority_external_effect_reconciliation_failed",
      code: error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE",
    }));
    input.retry();
  }
  return true;
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
  boundary: BoundaryName = "worker_ingress",
): ReturnType<typeof placementAuthorizationForIdentity> | undefined {
  if (!destination) return undefined;
  return resolveMeetingMinutesDestinationAuthorization(
    destination,
    env.MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON,
    requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    boundary,
  );
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
  const selectionEvent = {
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
  };
  const destination = meetingMinutesSelectionDestination(
    selection,
    meetingMinutesRuntimeConfig(env).destinations,
  );
  const destinationAuthorization = destinationAuthorizationForSelection(env, destination, "queue_consumer");
  const placementProjectScope = destinationAuthorization
    ? resolveMeetingMinutesDestinationProjectScope(
      envelope.authorization,
      destination,
      destinationAuthorization.required_authorization.project_id,
      "queue_consumer",
    )
    : resolveCanonicalProjectScope(
      envelope.authorization,
      placementProjectScopeForEvent(env, selectionEvent).project_ids,
      "queue_consumer",
    );
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
    || envelope.actor.authenticated_subject_id !== requiredRuntimeBinding(envelope.slack.requester_id)
    || envelope.placement.profile !== tenantDeploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  const repairEvent = {
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
  } as const;
  const destination = tenantTaskBoardRepairDestination(env, repair);
  const destinationAuthorization = destinationAuthorizationForSelection(env, destination, "queue_consumer");
  const projectScope = destination && destinationAuthorization
    ? resolveMeetingMinutesDestinationProjectScope(
      envelope.authorization,
      destination,
      destinationAuthorization.required_authorization.project_id,
      "queue_consumer",
    )
    : expectedProjectScopeForEvent(env, repairEvent, envelope);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: repair.workspaceId,
    app_id: envelope.workspace_connection.app_id,
    channel_id: repair.channelId,
    thread_ts: repair.requestedAt,
    actor_principal_id: envelope.actor.principal_id,
    ...projectScope,
    capability_id: taskBoardRepairCapabilityId(
      repair,
      requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    ),
    deployment_id: envelope.placement.deployment_id,
  };
}

function tenantTaskBoardRepairDestination(env: Env, repair: TaskBoardRepairEvent) {
  const target = taskBoardTargets(env).find((candidate) => candidate.targetId === repair.targetId
    && candidate.workspaceId === repair.workspaceId && candidate.channelId === repair.channelId);
  if (!target) deny("queue_consumer", "PROJECT_SCOPE_MISMATCH", {
    scope_reason: "task_board_target_missing",
  });
  const destinations = meetingMinutesRuntimeConfig(env).destinations.filter(
    (candidate) => candidate.taskBoardTargetId === repair.targetId
      && candidate.organization.id === target.organizationId,
  );
  if (destinations.length !== 1) deny("queue_consumer", "PROJECT_SCOPE_MISMATCH", {
    scope_reason: destinations.length === 0
      ? "task_board_destination_missing"
      : "task_board_destination_ambiguous",
  });
  return destinations[0];
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

type CompanyAuthorityReplyOperation = Parameters<
  Parameters<typeof createCompanyAuthoritySelectedContainerProviderRoute>[0]["execute_container"]
>[0];

/** The first A0 provider is deliberately limited to one ordinary Slack reply. */
export async function executeCompanyAuthorityReplyOperation(
  env: Env,
  operation: CompanyAuthorityReplyOperation,
): Promise<ExternalEffectProviderResult> {
  const { tenant_context: tenantContext, expected_scope: expectedScope,
    company_authority_envelope: envelope, payload: event, provider_key: providerKey,
    capture_recovery: captureRecovery } = operation;
  const request = envelope.company_authority_request;
  if (request.requested_action.capability_id !== "runtime.execute"
    || request.requested_action.desired_effect !== "external_side_effect"
    || typeof operation.canonical_person_id !== "string" || !operation.canonical_person_id.trim()
    || tenantContext.authorization.project_ids.length !== 1
    || tenantContext.authorization.project_ids[0] !== expectedScope.project_id
    || !providerKey || parseRuntimeControlCommand(event.text)) {
    deny("container_launch", "AUTHORITY_SCOPE_MISMATCH");
  }
  const config = parseCompanyAuthorityRuntimeConfiguration(env);
  if (config.state !== "enabled") deny("container_launch", "AUTHORITY_UNAVAILABLE");
  const clients = tenantRuntimeClients(env, tenantContext,
    config.desired_effect_by_capability);
  const now = () => new Date().toISOString();
  const readSnapshot = () => clients.authority.read_workspace_connection(
    tenantContext.workspace_connection.connection_id);
  const resolveKey = (keyId: string) => resolveTenantVerificationKey(env, keyId);
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: () => readSnapshot(), resolve_verification_key: resolveKey,
  });
  const boundary = async <T>(name: BoundaryName, execute: () => Promise<T>): Promise<T> => {
    const accepted = await executeCompanyAuthorityRuntimeBoundary({
      boundary: name, envelope, acceptance: { ...config.acceptance, now: now() },
      tenant_verifier: verifier, expected_tenant_scope: expectedScope, require_auto: true,
      validate_payload_binding: async (context, observed, payload) => {
        await resolveCompanyAuthoritySlackQueueScope({ context, request: observed, payload,
          expected_audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
          desired_effect_by_capability: config.desired_effect_by_capability });
        if (context.actor.canonical_person_id !== operation.canonical_person_id
          || jcsCanonicalize(context.tenant_context) !== jcsCanonicalize(tenantContext)
          || jcsCanonicalize(payload) !== jcsCanonicalize(event)) {
          deny(name, "AUTHORITY_SCOPE_MISMATCH");
        }
      },
      execute_auto: execute,
    });
    return accepted.result as T;
  };
  return boundary("container_launch", async () => {
    const placement = resolveRuntimePlacement(event, {
      tenantId: tenantContext.tenant.tenant_id,
      workspaceId: tenantContext.workspace_connection.workspace_id,
      placements: canonicalRuntimePlacements(env),
    });
    if (placement.projectCodes.length !== 1 || placement.projectCodes[0] !== expectedScope.project_id) {
      deny("container_launch", "AUTHORITY_SCOPE_MISMATCH");
    }
    const brokerFetch = createTenantCredentialFetch({ envelope: tenantContext,
      expected_scope: expectedScope, broker: clients.credential_broker,
      trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({ env, tenant_context: tenantContext }),
      read_authoritative_snapshot: readSnapshot, resolve_verification_key: resolveKey, now });
    // The shared pipeline's cosmetic status/reaction requests are not part of
    // this single-effect authority. Only postReply below can send Slack writes.
    const credentialFetch: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const target = new URL(req.url);
      if (target.hostname === "slack.com" && req.method !== "GET") {
        deny("slack_delivery", "AUTHORITY_SCOPE_MISMATCH");
      }
      return boundary("brainbase_proxy", () => brokerFetch(req));
    };
    const stub = env.TECHKNIGHT_WORKSPACE.get(env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(event)));
    return withDisposableResource(() => getWorkspace(stub as unknown as WorkspaceHandle), async (workspace) => {
      const workspaceSession = await readWorkspaceSession(workspace.fs);
      if (!isReplyEligible(event, { expectedTenantId: tenantContext.tenant.tenant_id,
        expectedWorkspaceId: tenantContext.workspace_connection.workspace_id,
        allowedChannelId: placement.channelId, respondPolicy: placement.respondTo,
        isEngagedThread: workspaceSession.engaged === true,
        botAttributedAppMentionUserIds: placement.audience?.allowedUserIds })) {
        return { applied: false, response_observed: true, failure_code: "REPLY_NOT_ELIGIBLE" };
      }
      const claim = await stub.claimRuntimeEvent(runtimeDeliveryId(event), true);
      // A prior/ambiguous execution is never turned into a second provider send.
      if (claim.disposition !== "claimed") return { applied: true, response_observed: false };
      await persistEventOnce(workspace.fs, event);
      await reconcilePermissionRevision(workspace.fs, placement.permissionRevision ?? "legacy-v1", event.receivedAt);
      const model = workspaceSession.modelOverride === "opus" || workspaceSession.modelOverride === "sonnet"
        ? workspaceSession.modelOverride : placement.agent?.model;
      const claudeRuntime = resolveClaudeRuntimeConfig(env, model);
      const trace: TurnRuntimeTrace = { placementId: placement.placementId,
        projectCodes: [expectedScope.project_id], actorIdHash: await actorIdHash(event),
        workerVersion: env.CF_VERSION_METADATA?.id, model: claudeRuntime.model, effort: claudeRuntime.effort };
      let observedTs: string | undefined;
      let deliveryBodyHash: string | undefined;
      let authBotId: string | undefined;
      let deliveryAttempted = false;
      const result = await executeTenantRuntimeOperation({ tenant_context: tenantContext,
        expected_scope: expectedScope, verifier, quota: clients.quota, accounting: clients.accounting,
        ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
        usage_unit: "model_tokens", accounting_effect_id: providerKey, now,
        process: async () => {
          const processed = await executeTenantContainerOperationWithRegistry({ namespace: env.TENANT_RUNTIME_STATE,
            tenant_context: tenantContext, expected_scope: expectedScope, verifier, now: now(),
            company_authority_envelope: envelope,
            execute: (tenantBoundaryHandle) => executeSharedReplyRuntime({ env, fs: workspace.fs, event,
              placement, runtimeTenantId: tenantContext.tenant.tenant_id,
              runtimeWorkspaceId: tenantContext.workspace_connection.workspace_id,
              workspaceSession, tenantCredentialFetch: credentialFetch, claudeRuntime, tenantBoundaryHandle,
              tenantBoundaryExpiresAt: tenantContext.expires_at, trace,
              canonicalPersonId: operation.canonical_person_id as string,
              canonicalProjectId: expectedScope.project_id,
              postReply: async (replyEvent, text, effectId = providerKey) => {
                if (observedTs !== undefined) deny("slack_delivery", "REPLY_OWNERSHIP_CONFLICT");
                // Hydration may add prompt context, but cannot redirect the
                // signed request to another tenant, actor, message, or thread.
                if (replyEvent.tenantId !== event.tenantId
                  || replyEvent.workspaceId !== event.workspaceId
                  || replyEvent.channelId !== event.channelId
                  || replyEvent.userId !== event.userId
                  || replyEvent.eventId !== event.eventId
                  || replyEvent.messageTs !== event.messageTs
                  || replyEvent.threadTs !== event.threadTs) {
                  deny("slack_delivery", "AUTHORITY_SCOPE_MISMATCH");
                }
                // Resolve the bot identity using the same tenant-bound credential
                // that will send and read back the message, never a global token.
                const authResponse = await credentialFetch("https://slack.com/api/auth.test");
                const auth = await authResponse.json() as { ok?: unknown; team_id?: unknown; bot_id?: unknown };
                if (!authResponse.ok || auth.ok !== true
                  || auth.team_id !== tenantContext.workspace_connection.workspace_id
                  || typeof auth.bot_id !== "string" || !auth.bot_id) {
                  deny("slack_delivery", "AUTHORITY_SCOPE_MISMATCH");
                }
                authBotId = auth.bot_id;
                const deliveryNow = now();
                const ts = await boundary("slack_delivery", () => postTenantSlackReply({
                  tenant_context: tenantContext, expected_scope: expectedScope,
                  ownership: createDurableTenantStateClient(env.TENANT_RUNTIME_STATE, tenantContext.tenant.tenant_id),
                  read_authoritative_snapshot: readSnapshot, resolve_verification_key: resolveKey,
                  now: deliveryNow, retention_until: tenantRetentionUntil(deliveryNow),
                  event: replyEvent, text, effect_id: effectId, release_on_failure: false,
                  post: () => {
                    deliveryAttempted = true;
                    return postSlackReply(replyEvent, text, { fetch: brokerFetch, provider_key: providerKey });
                  },
                }));
                observedTs = ts;
                const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(escapeUntrustedSlackMrkdwn(text)));
                const bodyHash = `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
                deliveryBodyHash = bodyHash;
                const readback = await readSlackDeliveryReadback({ observed: { channel: replyEvent.channelId, ts },
                  expected: { workspaceId: tenantContext.workspace_connection.workspace_id,
                    appId: tenantContext.workspace_connection.app_id, botId: auth.bot_id },
                  threadTs: replyEvent.threadTs, bodyHash, window: { oldest: ts, latest: ts },
                  expiresAt: Math.min(Date.now() + 30_000, Date.parse(tenantContext.expires_at)),
                }, credentialFetch);
                console.log(JSON.stringify({ event: "company_authority_slack_readback",
                  correlation_id: tenantContext.correlation_id, operation_id: tenantContext.operation_id,
                  provider_key: providerKey, state: readback.state, receipt: readback.receipt,
                  ...(readback.state === "unknown" ? { reason: readback.reason } : {}) }));
                if (readback.state !== "confirmed") throw new Error(`SLACK_READBACK_${readback.reason}`);
                return ts;
              },
            }),
          });
          // Complete the runtime claim inside the guarded operation. If the
          // claim readback fails, defer_unknown_accounting persists recovery so
          // reconciliation can retry the idempotent completion without posting.
          if (observedTs !== undefined && processed.responseTs === observedTs) {
            await stub.completeRuntimeEvent(runtimeDeliveryId(event), claim.claimToken, observedTs);
            const completedClaim = await stub.readRuntimeEventClaim(runtimeDeliveryId(event));
            if (!completedClaim || completedClaim.status !== "completed"
              || completedClaim.responseTs !== observedTs) {
              throw new TenantBoundaryError("slack_delivery", "UPSTREAM_UNAVAILABLE");
            }
          }
          return processed;
        },
        process_failure_reply_state: () => deliveryAttempted ? "unknown" : "not_attempted",
        defer_unknown_accounting: captureRecovery === undefined ? undefined : async ({ artifact }) => {
          await captureRecovery({
            runtime_event_id: runtimeDeliveryId(event),
            runtime_claim_token: claim.claimToken,
            operation_id: tenantContext.operation_id,
            correlation_id: tenantContext.correlation_id,
            accounting_context: tenantContext,
            accounting_artifact: artifact,
            delivery_identity: {
              provider: "slack",
              workspace_id: tenantContext.workspace_connection.workspace_id,
              app_id: tenantContext.workspace_connection.app_id,
              channel_id: event.channelId,
              thread_ts: event.threadTs,
              event_id: event.eventId,
              delivery_id: runtimeDeliveryId(event),
              message_ts: event.messageTs,
              workspace_name: workspaceName(event),
              ...(observedTs === undefined ? {} : { response_ts: observedTs }),
              ...(deliveryBodyHash === undefined ? {} : { body_hash: deliveryBodyHash }),
              ...(authBotId === undefined ? {} : { bot_id: authBotId }),
            },
          });
        },
      });
      if (!observedTs || result.responseTs !== observedTs) return { applied: true, response_observed: false };
      return { applied: true, response_observed: true, result_ref: `slack:${event.channelId}:${observedTs}` };
    });
  });
}

function expectedExternalEffectReconciliationScope(
  env: Env,
  job: ExternalEffectReconciliationJob,
): ExpectedTenantScope {
  const context = job.recovery.accounting_context;
  const delivery = job.recovery.delivery_identity;
  if (context.tenant.tenant_id !== job.tenant_id
    || context.idempotency_key !== job.effect_id
    || context.workspace_connection.workspace_id !== delivery.workspace_id
    || context.workspace_connection.app_id !== delivery.app_id
    || delivery.app_id !== requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID)
    || context.slack.channel_id !== delivery.channel_id
    || context.slack.thread_ts !== delivery.thread_ts
    || context.slack.event_id !== delivery.event_id
    || context.placement.profile !== tenantDeploymentProfile(env)
    || context.authorization.project_ids.length !== 1
    || typeof delivery.message_ts !== "string" || !delivery.message_ts
    || typeof delivery.workspace_name !== "string" || !delivery.workspace_name
    || typeof delivery.response_ts !== "string" || !delivery.response_ts
    || typeof delivery.body_hash !== "string" || !delivery.body_hash
    || typeof delivery.bot_id !== "string" || !delivery.bot_id) {
    deny("external_effect", "CROSS_TENANT_CANDIDATE");
  }
  const projectScope = expectedProjectScopeForEvent(env, {
    tenantId: context.tenant.tenant_id,
    eventId: delivery.event_id,
    workspaceId: delivery.workspace_id,
    channelId: delivery.channel_id,
    threadTs: delivery.thread_ts,
    messageTs: delivery.message_ts,
    userId: context.actor.authenticated_subject_id,
    eventType: "message",
    text: "",
    receivedAt: context.issued_at,
  }, context);
  return {
    audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
    workspace_id: delivery.workspace_id,
    app_id: delivery.app_id,
    channel_id: delivery.channel_id,
    thread_ts: delivery.thread_ts,
    actor_principal_id: context.actor.principal_id,
    ...projectScope,
    capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
    deployment_id: context.placement.deployment_id,
  };
}

/** Read back and settle one ambiguous A0 Slack effect without any provider-send capability. */
export async function reconcileCompanyAuthorityReplyOperation(
  env: Env,
  queuedJob: ExternalEffectReconciliationJob,
): Promise<"succeeded" | "retry"> {
  assertValidExternalEffectReconciliationJob(queuedJob);
  const scope = { tenant_id: queuedJob.tenant_id, effect_id: queuedJob.effect_id };
  const outbox = createDurableExternalEffectOutboxClient(env.TENANT_RUNTIME_STATE, scope);
  const reconciliationQueue = createDurableExternalEffectReconciliationQueueClient(
    env.TENANT_RUNTIME_STATE,
    scope,
  );
  const persistedJob = await reconciliationQueue.read(queuedJob.tenant_id, queuedJob.effect_id);
  if (!persistedJob) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_RECONCILIATION_MISSING");
  }
  assertValidExternalEffectReconciliationJob(persistedJob);
  if (persistedJob.provider_key !== queuedJob.provider_key
    || persistedJob.payload_hash !== queuedJob.payload_hash
    || jcsCanonicalize(persistedJob.recovery) !== jcsCanonicalize(queuedJob.recovery)) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
  }

  let prepared: {
    authorizationContext: TenantContextEnvelope;
    expectedScope: ExpectedTenantScope;
    clients: ReturnType<typeof tenantRuntimeClients>;
    verifier: TenantRuntimeBoundaryVerifier;
    credentialFetch: typeof fetch;
  } | undefined;
  const originalContext = persistedJob.recovery.accounting_context;
  const result = await reconcileCompanyAuthorityExternalEffectFromQueue({
    job: persistedJob,
    outbox,
    reconciliation_queue: reconciliationQueue,
    verify_context: async (context) => {
      if (jcsCanonicalize(context) !== jcsCanonicalize(originalContext)) {
        deny("external_effect", "CROSS_TENANT_CANDIDATE");
      }
      const expectedScope = expectedExternalEffectReconciliationScope(env, persistedJob);
      const desiredEffectByCapability = tenantConfiguredDesiredEffectByCapability(env);
      const authorityClients = tenantRuntimeClients(env, undefined, desiredEffectByCapability);
      const snapshot = await authorityClients.authority.read_workspace_connection(
        context.workspace_connection.connection_id,
      );
      const authorizationContext = await authorityClients.authority.issue_tenant_context({
        workspace_connection: snapshot,
        tenant_revision: context.tenant.tenant_revision,
        actor: context.actor,
        authorization: context.authorization,
        correlation_id: context.correlation_id,
        operation_id: context.operation_id,
        billing_principal_id: context.credential.billing_principal_id,
        slack: {
          event_id: context.slack.event_id,
          channel_id: context.slack.channel_id,
          thread_ts: context.slack.thread_ts ?? "",
          requester_id: context.slack.requester_id ?? context.actor.authenticated_subject_id,
          ...(context.slack.enterprise_id ? { enterprise_id: context.slack.enterprise_id } : {}),
        },
        required_authorization: {
          audience: expectedScope.audience,
          project_id: expectedScope.project_id,
          capability_id: expectedScope.capability_id,
        },
        trusted_project_ids: expectedScope.project_ids ?? [expectedScope.project_id],
      });
      const clients = tenantRuntimeClients(env, authorizationContext, desiredEffectByCapability);
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) =>
          clients.authority.read_workspace_connection(connectionId),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
      });
      await verifier.validate({
        boundary: "queue_consumer",
        tenant_context: authorizationContext,
        expected_scope: expectedScope,
        now: new Date().toISOString(),
      });
      const credentialFetch = createTenantCredentialFetch({
        envelope: authorizationContext,
        expected_scope: expectedScope,
        broker: clients.credential_broker,
        trusted_forwarder: createBrainbaseTrustedProviderForwarderFromEnv({
          env,
          tenant_context: authorizationContext,
        }),
        read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
          authorizationContext.workspace_connection.connection_id,
        ),
        resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
        now: () => new Date().toISOString(),
      });
      prepared = { authorizationContext, expectedScope, clients, verifier, credentialFetch };
    },
    provider_reconcile: async () => {
      if (!prepared) throw new TenantBoundaryError("external_effect", "AUTHORITY_UNAVAILABLE");
      const delivery = persistedJob.recovery.delivery_identity;
      const readback = await readSlackDeliveryReadback({
        observed: { channel: delivery.channel_id, ts: delivery.response_ts! },
        expected: {
          workspaceId: delivery.workspace_id,
          appId: delivery.app_id,
          botId: delivery.bot_id!,
        },
        threadTs: delivery.thread_ts,
        bodyHash: delivery.body_hash!,
        window: { oldest: delivery.response_ts!, latest: delivery.response_ts! },
        expiresAt: Date.now() + 30_000,
      }, prepared.credentialFetch);
      return readback.state === "confirmed"
        ? { state: "succeeded" as const, result_ref: `slack:${delivery.channel_id}:${delivery.response_ts}` }
        : { state: "unknown" as const };
    },
    settle_confirmed: async ({ recovery, result_ref, mark_stage: markStage, settlement_state: stage }) => {
      if (!prepared) throw new TenantBoundaryError("external_effect", "AUTHORITY_UNAVAILABLE");
      if (stage !== "accounting_completed" && stage !== "runtime_claim_completed" && stage !== "settled") {
        await settleTenantAccountingContinuation({
          authorization_context: prepared.authorizationContext,
          artifact_context: recovery.accounting_context,
          expected_scope: prepared.expectedScope,
          now: new Date().toISOString(),
          verifier: prepared.verifier,
          ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, recovery.accounting_context),
          artifact: recovery.accounting_artifact,
          write: (artifact) => prepared!.clients.accounting.write({
            ...artifact,
            tenant_context: prepared!.authorizationContext,
          }),
        });
        await markStage?.("accounting_completed");
      }
      if (stage !== "runtime_claim_completed" && stage !== "settled") {
        const delivery = recovery.delivery_identity;
        const stub = env.TECHKNIGHT_WORKSPACE.get(
          env.TECHKNIGHT_WORKSPACE.idFromName(delivery.workspace_name!),
        );
        await stub.completeRuntimeEvent(
          recovery.runtime_event_id,
          recovery.runtime_claim_token,
          delivery.response_ts,
        );
        const completed = await stub.readRuntimeEventClaim(recovery.runtime_event_id);
        if (!completed || completed.status !== "completed"
          || completed.claimToken !== recovery.runtime_claim_token
          || completed.responseTs !== delivery.response_ts) {
          throw new TenantBoundaryError("external_effect", "UPSTREAM_UNAVAILABLE");
        }
        await markStage?.("runtime_claim_completed");
      }
      if (!result_ref.startsWith(`slack:${recovery.delivery_identity.channel_id}:`)) {
        throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
      }
    },
  });
  return result?.state === "succeeded" ? "succeeded" : "retry";
}

interface SharedReplyRuntimeInput {
  env: Env;
  fs: WorkspaceFs;
  event: SlackQueueEvent;
  placement: ResolvedRuntimePlacement;
  runtimeTenantId: string;
  runtimeWorkspaceId: string;
  workspaceSession: Awaited<ReturnType<typeof readWorkspaceSession>>;
  tenantCredentialFetch: typeof fetch;
  claudeRuntime: ReturnType<typeof resolveClaudeRuntimeConfig>;
  tenantBoundaryHandle: string;
  tenantBoundaryExpiresAt: string;
  trace: TurnRuntimeTrace;
  postReply(event: SlackQueueEvent, text: string, effectId?: string): Promise<string>;
  /** Set only for an already accepted Company Authority actor. */
  canonicalPersonId?: string;
  /** Set only for an already accepted Company Authority project scope. */
  canonicalProjectId?: string;
}

/**
 * Shared ordinary reply executor for the legacy T0 queue and A0's selected
 * runtime.execute provider. The caller owns queue/idempotency and container
 * admission; this function owns the real reply pipeline and its existing task,
 * graph, triage, sandbox, and Slack delivery dependencies.
 */
function executeSharedReplyRuntime(input: SharedReplyRuntimeInput): Promise<ReplyProcessResult> {
  const {
    env,
    fs,
    event,
    placement,
    runtimeTenantId,
    runtimeWorkspaceId,
    workspaceSession,
    tenantCredentialFetch,
    claudeRuntime,
    tenantBoundaryHandle,
    tenantBoundaryExpiresAt,
    trace,
    postReply,
  } = input;
  const canonicalProjectId = input.canonicalProjectId ?? placement.projectCodes[0];
  const canonicalPersonId = input.canonicalPersonId;
  // A0's accepted actor is already canonical. Only the ordinary T0 caller
  // constructs the legacy resolver; A0 must never regenerate identity here.
  const actorIdentityResolver = canonicalPersonId === undefined
    ? resolveActorIdentityResolverFromEnv(env)
    : undefined;
  return executeReplyRuntime({
    fs,
    event,
    taskSearch: {
      tenantId: runtimeTenantId,
      workspaceId: runtimeWorkspaceId,
      channelId: placement.channelId,
      projectCodes: input.canonicalProjectId ?? placement.projectCodes.join(","),
      taskSearchEnabled: env.RUNTIME_TASK_SEARCH_ENABLED,
      brainbaseApiBaseUrl: env.BRAINBASE_TASK_API_BASE_URL,
      tenantCredentialFetchConfigured: true,
    },
    prepareRequester: async () => {
      const profileResolution = await resolveSlackUserProfile({
        userId: event.userId ?? "",
        fetchImpl: tenantCredentialFetch,
      });
      // users.info is enrichment, not the authorization boundary. Some Slack
      // installations intentionally omit users:read. Canonical Graph identity
      // resolution remains mandatory for ordinary T0 callers; A0 uses only its
      // accepted canonical person id.
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
      const mappedActor = await actorIdentityResolver?.(event);
      const requesterResolution = canonicalPersonId !== undefined
        ? { status: "resolved" as const, personId: canonicalPersonId }
        : mappedActor
          ? { status: "resolved" as const, personId: mappedActor.personId }
          : await resolveGraphRequester(
            event.workspaceId,
            event.userId ?? "",
            placement.projectCodes[0],
            graphOptions,
          );
      if (requesterResolution.status !== "resolved") {
        throw new ReplyPipelineError(`requester_identity_${requesterResolution.status}`);
      }
      const { taskWriteEnabled, taskWriteCapability } = canonicalPersonId !== undefined
        ? { taskWriteEnabled: false, taskWriteCapability: undefined }
        : await issueTaskWriteRequestContext(
        event,
        env,
        Date.now(),
        placement,
        requesterResolution.personId,
      );
      const graphContext = await hydrateGraphContext(event, canonicalProjectId, graphOptions);
      if (graphContext.status === "unavailable") {
        throw new ReplyPipelineError("graph_context_unavailable");
      }
      return {
        requesterIdentity: {
          slackUserId: event.userId ?? "",
          personId: requesterResolution.personId,
        },
        requesterProfile,
        graphContext: graphContext.content,
        taskWriteEnabled,
        taskWriteCapability,
      };
    },
    options: {
      expectedTenantId: runtimeTenantId,
      expectedWorkspaceId: runtimeWorkspaceId,
      allowedChannelId: placement.channelId,
      fetch: tenantCredentialFetch,
      oauthConfigured: true,
      tenantBoundaryHandle,
      tenantBoundaryExpiresAt,
      claudeRuntime,
      brainbaseProjectCode: canonicalProjectId,
      runtimeContext: placement.runtimeContext
        ? { ...placement.runtimeContext, escalationEmployee: placement.agent?.escalationEmployee }
        : undefined,
      capabilities: canonicalPersonId !== undefined ? { mcp: [], gatewayTools: [] } : placement.capabilities,
      resolveActorIdentity: actorIdentityResolver,
      trace: { ...trace, model: claudeRuntime.model, effort: claudeRuntime.effort },
      respondPolicy: placement.respondTo,
      isEngagedThread: workspaceSession.engaged === true,
      botAttributedAppMentionUserIds: placement.audience?.allowedUserIds,
      createSandbox: (sandboxId: string) => createTechKnightSandbox(env, sandboxId),
      hydrateThreadContext: async (inputEvent: SlackQueueEvent) => {
        const hydrated = await hydrateSlackQueueEventThreadContext(inputEvent, {
          fetch: tenantCredentialFetch,
          contextAfterTs: workspaceSession.contextAfterTs,
        });
        const withParticipants = {
          ...hydrated,
          threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext, {
            fetchImpl: tenantCredentialFetch,
          }),
        };
        return hydrateSlackAttachments(withParticipants, { fetchImpl: tenantCredentialFetch });
      },
      postReply,
    },
    triage: async (triageEvent, requester) => {
      const hydrated = await hydrateSlackQueueEventThreadContext(triageEvent, {
        fetch: tenantCredentialFetch,
        contextAfterTs: workspaceSession.contextAfterTs,
      });
      const withParticipants = {
        ...hydrated,
        threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext, {
          fetchImpl: tenantCredentialFetch,
        }),
      };
      const hydratedWithAttachments = await hydrateSlackAttachments(withParticipants, {
        fetchImpl: tenantCredentialFetch,
      });
      const recentThread = (hydratedWithAttachments.threadContext ?? "")
        .split("\n")
        .filter(Boolean)
        .slice(-10)
        .map((text) => ({ speaker: "thread", text }));
      const decision = await runRuntimeTriage({
        botName: "まな",
        persona: placement.runtimeContext?.persona,
        speakerName: requester.requesterProfile.displayName
          ?? requester.requesterProfile.realName
          ?? requester.requesterProfile.handle
          ?? "Slack user",
        channelType: triageEvent.channelType ?? "channel",
        messageText: triageEvent.text,
        attachmentNames: triageEvent.files?.map((file) => file.name),
        recentThread,
      }, {
        model: claudeRuntime.model,
        effort: claudeRuntime.effort,
        tenantBoundaryHandle,
        createSandbox: (sandboxId: string) => createTechKnightSandbox(env, sandboxId),
      });
      emitTurnLog("log", "mana_triage_decided", triageEvent, trace, {
        outcome: decision.action,
        reasonCode: decision.reason,
      });
      return decision;
    },
  });
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
        }, undefined, () => tenantConfiguredDesiredEffectByCapability(env));
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
      // The queue belongs to the source router, but task removal belongs to the
      // persisted destination. Resolve its authorization afresh; never reuse the
      // router's project scope or accept a project from a Slack button payload.
      await processMeetingMinutesRedo(workspace.fs, command, config, {
        ...clients.redo,
        deleteTask: async (taskId, idempotencyKey) => {
          const run = await loadMeetingMinutesRun(workspace.fs, command.runId);
          const destination = config.destinations.find((candidate) => candidate.id === run?.destination?.id);
          if (!destination || destination.contextProjectCode !== run?.destination?.contextProjectCode) {
            deny("brainbase_proxy", "PROJECT_SCOPE_MISMATCH");
          }
          const taskContext = await resolveDerivedSlackTenantContext(env, tenantContext, {
            app_id: command.appId,
            workspace_id: command.workspaceId,
            event_id: await childInteractionEventId(meetingMinutesRedoEventId(command), `delete-task:${taskId}`),
            channel_id: command.channelId,
            thread_ts: command.threadTs,
            requester_id: command.userId,
          }, { destination }, () => tenantConfiguredDesiredEffectByCapability(env));
          const destinationAuthorization = destinationAuthorizationForSelection(env, destination);
          if (!destinationAuthorization) deny("brainbase_proxy", "PROJECT_SCOPE_MISMATCH");
          const taskScope: ExpectedTenantScope = {
            ...expectedScope,
            actor_principal_id: taskContext.actor.principal_id,
            ...resolveMeetingMinutesDestinationProjectScope(taskContext.authorization, destination,
              destinationAuthorization.required_authorization.project_id, "brainbase_proxy"),
          };
          const taskEffects = createMeetingMinutesTenantEffectGuard({ env,
            tenant_context: taskContext, expected_scope: taskScope, verifier, now });
          await createMeetingMinutesTaskDeleter({
            expectedProjectCodes: destination.taskProjectCodes,
            baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "", boundary: taskEffects.boundary,
          })(taskId, idempotencyKey);
        },
      });
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
        clients = tenantRuntimeClients(env, undefined,
          tenantConfiguredDesiredEffectByCapability(env));
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
    const replyJudgmentMatch = url.pathname.match(
      /^\/admin\/reply-judgment\/episodes\/([A-Za-z0-9_-]{1,128})$/,
    );
    if (request.method === "GET" && replyJudgmentMatch) {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const adminBoundary = await resolveDurableTenantBoundaryContext(
        env.TENANT_RUNTIME_STATE, request, ["brainbase_proxy"], new Date().toISOString(),
      );
      if (adminBoundary instanceof Response) return adminBoundary;
      const tenantId = url.searchParams.get("tenant_id");
      const workspaceId = url.searchParams.get("workspace_id");
      const channelId = url.searchParams.get("channel_id");
      const threadTs = url.searchParams.get("thread_ts");
      if (!tenantId || !/^[A-Za-z0-9_-]{3,128}$/.test(tenantId)
        || !workspaceId || !/^[A-Z0-9]{3,32}$/.test(workspaceId)
        || !channelId || !/^[A-Z0-9]{3,32}$/.test(channelId)
        || !threadTs || !/^\d{1,20}(?:\.\d{1,12})?$/.test(threadTs)) {
        return Response.json({ error: "reply_judgment_scope_invalid" }, { status: 400 });
      }
      const tenantContext = adminBoundary.tenant_context;
      if (tenantId !== tenantContext.tenant.tenant_id
        || workspaceId !== tenantContext.workspace_connection.workspace_id
        || channelId !== tenantContext.slack.channel_id
        || threadTs !== tenantContext.slack.thread_ts) {
        return Response.json({ error: "reply_judgment_scope_mismatch" }, { status: 403 });
      }
      const id = env.TECHKNIGHT_WORKSPACE.idFromName(runtimeWorkspaceName({
        tenantId, workspaceId, channelId, threadTs,
      }));
      const handle = env.TECHKNIGHT_WORKSPACE.get(id) as unknown as WorkspaceHandle;
      const episode = await withDisposableResource(
        () => getWorkspace(handle),
        (workspace) => readReplyJudgmentEpisode(workspace.fs, replyJudgmentMatch[1]!),
      );
      if (!episode) return Response.json({ error: "reply_judgment_episode_not_found" }, { status: 404 });
      if (episode.tenantId !== tenantId || episode.workspaceId !== workspaceId
        || episode.channelId !== channelId || episode.threadTs !== threadTs) {
        return Response.json({ error: "reply_judgment_scope_mismatch" }, { status: 403 });
      }
      return Response.json(episode);
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
    const authorizedRetryMatch = url.pathname.match(
      /^\/admin\/meeting-minutes\/runs\/([A-Za-z0-9_-]{3,260})\/authorized-retry$/,
    );
    if (request.method === "POST" && authorizedRetryMatch) {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let payload: { tenantId?: unknown; workspaceId?: unknown; actionTs?: unknown } | null;
      try {
        const parsed = await readAdminJsonRequest(request);
        payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as { tenantId?: unknown; workspaceId?: unknown; actionTs?: unknown } : null;
      } catch (error) {
        const rejected = adminJsonInputErrorResponse(error);
        if (rejected) return rejected;
        throw error;
      }
      const tenantId = typeof payload?.tenantId === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(payload.tenantId)
        ? payload.tenantId : undefined;
      const workspaceId = typeof payload?.workspaceId === "string" && /^[A-Z0-9]{3,32}$/.test(payload.workspaceId)
        ? payload.workspaceId : undefined;
      const actionTs = typeof payload?.actionTs === "string" && /^\d{1,20}(?:\.\d{1,12})?$/.test(payload.actionTs)
        ? payload.actionTs : undefined;
      if (!tenantId || !workspaceId || !actionTs) {
        return Response.json({ error: "meeting_minutes_admin_retry_scope_invalid" }, { status: 400 });
      }
      const runId = authorizedRetryMatch[1]!;
      const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        tenantId, workspaceId, runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
      const run = await withDisposableResource(() => getWorkspace(handle),
        (workspace) => loadMeetingMinutesRun(workspace.fs, runId));
      if (!run) return Response.json({ error: "meeting_minutes_run_not_found" }, { status: 404 });
      const authorization = run.recoveryAuthorization;
      if (!authorization || authorization.tenantId !== tenantId ||
        authorization.workspaceId !== workspaceId || !run.destination || !run.sourceAppId) {
        return Response.json({ error: "meeting_minutes_admin_retry_not_authorized" }, { status: 409 });
      }
      const selection: MeetingMinutesSelection = {
        kind: "meeting_minutes_selection",
        runId,
        destinationId: run.destination.id,
        workspaceId,
        appId: run.sourceAppId,
        channelId: run.sourceChannelId,
        threadTs: run.sourceThreadTs,
        userId: authorization.requesterId,
        actionTs,
      };
      const tenantContext = await reissueMeetingMinutesAdminSelectionTenantContext(env, run, selection);
      await env.TECHKNIGHT_EVENTS.send({ schema_version: "1.0", tenant_context: tenantContext, payload: selection });
      return Response.json({ runId, status: run.status, destinationId: run.destination.id, enqueued: true });
    }
    const authorizedStatusMatch = url.pathname.match(
      /^\/admin\/meeting-minutes\/runs\/([A-Za-z0-9_-]{3,260})\/authorized-status$/,
    );
    if (request.method === "GET" && authorizedStatusMatch) {
      if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const tenantId = url.searchParams.get("tenant_id") ?? "";
      const workspaceId = url.searchParams.get("workspace_id") ?? "";
      if (!/^[A-Za-z0-9_-]{3,128}$/.test(tenantId) || !/^[A-Z0-9]{3,32}$/.test(workspaceId)) {
        return Response.json({ error: "meeting_minutes_admin_status_scope_invalid" }, { status: 400 });
      }
      const runId = authorizedStatusMatch[1]!;
      const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        tenantId, workspaceId, runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
      const run = await withDisposableResource(() => getWorkspace(handle),
        (workspace) => loadMeetingMinutesRun(workspace.fs, runId));
      if (!run) return Response.json({ error: "meeting_minutes_run_not_found" }, { status: 404 });
      const authorization = run.recoveryAuthorization;
      if (!authorization || authorization.tenantId !== tenantId || authorization.workspaceId !== workspaceId) {
        return Response.json({ error: "meeting_minutes_admin_status_not_authorized" }, { status: 409 });
      }
      return Response.json(meetingMinutesAdminRunStatus(run));
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
        const runtimeClients = tenantRuntimeClients(env, undefined,
          tenantConfiguredDesiredEffectByCapability(env));
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
      return Response.json({ ...meetingMinutesAdminRunStatus(run),
        redo: run.redo ? { revision: run.redo.revision, githubDeleted: Boolean(run.redo.githubDeletedAt),
          deletedTaskCount: run.redo.deletedTaskIds.length, sharedRetracted: Boolean(run.redo.sharedRetractedAt),
          failure: run.redo.failure ? { stage: run.redo.failure.stage, code: run.redo.failure.code,
            retryable: run.redo.failure.retryable, failedAt: run.redo.failure.failedAt } : undefined } : undefined,
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
      const callbackClients = tenantRuntimeClients(env, undefined,
        tenantConfiguredDesiredEffectByCapability(env));
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
          const clients = tenantRuntimeClients(env, undefined, tenantInteractionDesiredEffectByCapability(env));
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
            repairTaskBoard: (targetId) => {
              const source = canonicalSource();
              const run = cachedRun;
              if (!run) deny("brainbase_proxy", "CROSS_TENANT_CANDIDATE");
              const target = taskBoardTargets(env).find((candidate) => candidate.targetId === targetId);
              if (!target) throw new Error(`meeting_minutes_task_board_target_not_found:${targetId}`);
              const destinationSlackBinding = resolveMeetingMinutesDestinationSlackBinding({
                organizationId: run.destination!.organization.id,
                destination: run.destination!,
                destinationTeamIdsJson: env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON,
                trustedWorkspaceConnections: parseWorkspaceConnectionHints(env.BRAINBASE_WORKSPACE_CONNECTIONS_JSON),
                sourceTenantId: effects.tenant_id,
                sourceWorkspaceId: effects.source.workspace_id,
                sourceAppId: effects.source.app_id,
              });
              const destinationToken = resolveCrossWorkspaceMeetingMinutesSlackToken(
                env,
                run.destination!.organization.id,
                effects.source.workspace_id,
                destinationSlackBinding,
              );
              if (destinationToken) {
                const repair: TaskBoardRepairEvent = {
                  eventType: "task_board_repair",
                  tenantId: effects.tenant_id,
                  targetId: target.targetId,
                  workspaceId: target.workspaceId,
                  channelId: target.channelId,
                  manaCanvasId: target.manaCanvasId,
                  bindingRevision: target.bindingRevision!,
                  reason: "task_write",
                  requestedAt: new Date().toISOString(),
                };
                return effects.slackDelivery(
                  `task-board-repair:${targetId}:${run.runId}:${run.updatedAt}`,
                  sourceTarget(source),
                  { kind: "task_board_repair", targetId, runId: run.runId },
                  (credentialFetch) => processTaskBoardRepair(
                    repair, env, repair.tenantId, globalThis.fetch,
                    undefined, undefined, repair.workspaceId, credentialFetch,
                    run.destination!.taskProjectCodes, destinationToken,
                  ),
                );
              }
              return effects.durableObject(
                `task-board-repair:${targetId}:${run.runId}:${run.updatedAt}`,
                { app_id: destinationSlackBinding.app_id,
                  workspace_id: target.workspaceId, channel_id: target.channelId,
                  thread_ts: run.slack?.parentTs ?? source.threadTs },
                (taskBoardTenantContext) => enqueueMeetingMinutesTaskBoardRepair(
                  env,
                  targetId,
                  "task_write",
                  (repair) => resolveDerivedSlackTenantContext(env, taskBoardTenantContext, {
                    app_id: taskBoardTenantContext.workspace_connection.app_id,
                    workspace_id: repair.workspaceId,
                    event_id: taskBoardRepairEventId(repair),
                    channel_id: repair.channelId,
                    thread_ts: repair.requestedAt,
                    requester_id: requiredRuntimeBinding(taskBoardTenantContext.slack.requester_id),
                  }, undefined, () => tenantConfiguredDesiredEffectByCapability(env)),
                ),
              );
            },
            defer: (work) => ctx.waitUntil(work),
          });
        }, async (command, destination) => {
          const clients = tenantRuntimeClients(env, undefined, tenantInteractionDesiredEffectByCapability(env));
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
        }, async (identity, destination) => {
          const effects = await resolveInteractionEffects(identity, destination);
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
        repairPlacements: [{ channelId: requiredRuntimeBinding(env.MEETING_MINUTES_ROUTER_CHANNEL_ID),
          allowedUserIds: [...meetingMinutesRuntimeConfig(env).operatorUserIds] }],
        repairMeetingMinutes: async (input) => {
          const clients = tenantRuntimeClients(env);
          const receivedAt = new Date().toISOString();
          const appId = requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID);
          const identity: TenantInteractionIdentity = {
            app_id: appId,
            workspace_id: input.workspaceId,
            event_id: `minutes_repair_${input.runId}`,
            channel_id: input.channelId,
            thread_ts: input.sourceThreadTs,
            requester_id: input.requesterId,
          };
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const resolved = await resolveSlackWorkerIngress({
            identity: { provider: "slack", ...identity },
            required_scopes: requiredScopes,
            ...placementAuthorizationForIdentity(env, identity),
            authority: clients.authority,
            now: receivedAt,
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          const tenantContext = resolved.tenant_context;
          const expectedScope: ExpectedTenantScope = {
            audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
            workspace_id: input.workspaceId,
            app_id: appId,
            channel_id: input.channelId,
            thread_ts: input.sourceThreadTs,
            actor_principal_id: tenantContext.actor.principal_id,
            project_id: tenantContext.authorization.project_ids[0]!,
            project_ids: [...tenantContext.authorization.project_ids],
            capability_id: requiredRuntimeBinding(env.MANA_REQUIRED_CAPABILITY_ID),
            deployment_id: tenantContext.placement.deployment_id,
          };
          const verifier = new TenantRuntimeBoundaryVerifier({
            read_authoritative_snapshot: (connectionId) => clients.authority.read_workspace_connection(connectionId),
            resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
          });
          const effects = createMeetingMinutesTenantEffectGuard({ env, tenant_context: tenantContext,
            expected_scope: expectedScope, verifier, now: () => new Date().toISOString() });
          const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
            tenantContext.tenant.tenant_id, input.workspaceId, input.runId,
          ));
          const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
          const storedRun = await withDisposableResource(() => getWorkspace(handle),
            (workspace) => loadMeetingMinutesRun(workspace.fs, input.runId));
          const run = meetingMinutesCompletedProjectionRepair(storedRun,
            { channelId: input.channelId, threadTs: input.sourceThreadTs });
          if (!run) {
            console.warn(JSON.stringify({ event: "meeting_minutes_projection_repair_rejected", runId: input.runId,
              found: Boolean(storedRun), status: storedRun?.status, failureStage: storedRun?.failure?.stage,
              diagnosticStage: storedRun?.diagnostics?.stage, diagnosticCode: storedRun?.diagnostics?.code,
              hasGenerated: Boolean(storedRun?.generated), hasGitHub: Boolean(storedRun?.github),
              hasSlackParent: Boolean(storedRun?.slack?.parentTs), hasProcessingStatus: Boolean(storedRun?.slack?.processingTs),
              sourceMatches: storedRun?.sourceChannelId === input.channelId
                && storedRun?.sourceThreadTs === input.sourceThreadTs }));
            throw new Error("meeting_minutes_completed_run_not_found");
          }
          await meetingMinutesClients(env, effects, tenantContext).slack.updateRunStatus(run, "completed");
        },
        openModal: async (input) => {
          const clients = tenantRuntimeClients(env, undefined,
            tenantConfiguredDesiredEffectByCapability(env));
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
          const clients = tenantRuntimeClients(env, undefined,
            tenantConfiguredDesiredEffectByCapability(env));
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
      const runtimeConfiguration = parseCompanyAuthorityRuntimeConfiguration(env);
      const desiredEffectByCapability = runtimeConfiguration.state === "enabled"
        ? runtimeConfiguration.desired_effect_by_capability
        : undefined;
      const clients = tenantRuntimeClients(env, undefined, desiredEffectByCapability);
      const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
        .split(",").map((value) => value.trim()).filter(Boolean);
      const placements = canonicalRuntimePlacements(env);
      const companyAuthorityIngress = companyAuthorityIngressConfiguration(
        runtimeConfiguration,
        clients.company_authority,
      );
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
        ...(companyAuthorityIngress ? {
          company_authority: {
            ...companyAuthorityIngress,
            send: (event) => env.TECHKNIGHT_EVENTS.send(event),
          },
        } : {}),
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
    | CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>
    | ExternalEffectReconciliationJob
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent
    | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>, env: Env): Promise<void> {
    const executeTenantContainerOperation = <T>(input: {
      tenant_context: TenantContextEnvelope;
      expected_scope: ExpectedTenantScope;
      verifier: TenantRuntimeBoundaryVerifier;
      now: string;
      release?: "on_completion" | "on_expiration";
      company_authority_envelope?: CompanyAuthorityRuntimeEnvelope<unknown>;
      refresh?: {
        issue(): Promise<TenantContextEnvelope>;
        now(): string;
        before_expiry_ms?: number;
      };
      execute(tenantBoundaryHandle: string): Promise<T>;
    }): Promise<T> => executeTenantContainerOperationWithRegistry({
      ...input,
      namespace: env.TENANT_RUNTIME_STATE,
    });
    for (const message of batch.messages) {
      if (isExternalEffectReconciliationQueueCandidate(message.body)) {
        await handleExternalEffectReconciliationQueueMessage({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, env);
        continue;
      }
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
      if (isCompanyAuthorityRuntimeEnvelopeCandidate(message.body)) {
        if (!isCompanyAuthorityRuntimeEnvelope<SlackQueueEvent>(message.body)) {
          const diagnostic = diagnoseCompanyAuthorityRuntimeEnvelope(message.body);
          console.error(JSON.stringify({
            event: "company_authority_queue_failed",
            code: diagnostic.code,
            correlation_id: diagnostic.correlation_id,
            stage: diagnostic.stage,
            reason: diagnostic.reason,
          }));
          message.retry();
          continue;
        }
        const companyAuthorityEnvelope = message.body;
        let runtimeConfig: ReturnType<typeof parseCompanyAuthorityRuntimeConfiguration>;
        try {
          runtimeConfig = parseCompanyAuthorityRuntimeConfiguration(env);
        } catch (error) {
          console.error(JSON.stringify({
            event: "company_authority_queue_failed",
            code: error instanceof TenantBoundaryError ? error.code : "CONFIGURATION_INVALID",
            correlation_id: companyAuthorityEnvelope.correlation_id,
            stage: "company_authority_runtime_configuration",
          }));
          message.retry();
          continue;
        }
        if (runtimeConfig.state === "disabled") {
          console.error(JSON.stringify({
            event: "company_authority_queue_failed",
            code: "UPSTREAM_UNAVAILABLE",
            correlation_id: companyAuthorityEnvelope.correlation_id,
            stage: "company_authority_runtime_disabled",
          }));
          message.retry();
          continue;
        }
        const companyAuthorityProviderRoutes = createCompanyAuthorityProviderRoutes(env, runtimeConfig);
        await consumeCompanyAuthorityQueueMessage({
          body: companyAuthorityEnvelope,
          ack: () => message.ack(),
          retry: (options) => message.retry(options),
        }, {
          acceptance: runtimeConfig.acceptance,
          resolve_runtime: async ({ context, request, payload }) => {
            const tenantContext = context.tenant_context as unknown as TenantContextEnvelope;
            const expectedScope = await resolveCompanyAuthoritySlackQueueScope({
              context,
              request,
              payload,
              expected_audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
              desired_effect_by_capability: runtimeConfig.desired_effect_by_capability,
            });
            const clients = tenantRuntimeClients(env, tenantContext,
              runtimeConfig.desired_effect_by_capability);
            return {
              tenant_verifier: new TenantRuntimeBoundaryVerifier({
                read_authoritative_snapshot: (connectionId) =>
                  clients.authority.read_workspace_connection(connectionId),
                resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
              }),
              expected_tenant_scope: expectedScope,
              ownership: createDurableTenantStateClient(
                env.TENANT_RUNTIME_STATE,
                tenantContext.tenant.tenant_id,
              ),
            };
          },
          validate_payload_binding: async (context, request, payload) => {
            await resolveCompanyAuthoritySlackQueueScope({
              context,
              request,
              payload,
              expected_audience: requiredRuntimeBinding(env.MANA_REQUIRED_AUDIENCE),
              desired_effect_by_capability: runtimeConfig.desired_effect_by_capability,
            });
          },
          process_auto: (context, payload, snapshot) => processCompanyAuthorityAutoQueueRoute({
            context,
            request: snapshot.request,
            envelope: snapshot.envelope,
            payload,
            registry: companyAuthorityProviderRoutes,
          }),
          route_approval: (context, payload, snapshot) => {
            const scope = companyAuthorityHumanHandoffIdentity(context);
            return processCompanyAuthorityHumanHandoff({
              context,
              request: snapshot.request,
              payload,
              execution_hash: snapshot.execution_hash,
              store: createDurableCompanyAuthorityHumanHandoffClient(env.TENANT_RUNTIME_STATE, scope),
              now: () => new Date().toISOString(),
            });
          },
          route_human_action: (context, payload, snapshot) => {
            const scope = companyAuthorityHumanHandoffIdentity(context);
            return processCompanyAuthorityHumanHandoff({
              context,
              request: snapshot.request,
              payload,
              execution_hash: snapshot.execution_hash,
              store: createDurableCompanyAuthorityHumanHandoffClient(env.TENANT_RUNTIME_STATE, scope),
              now: () => new Date().toISOString(),
            });
          },
          execution_hash: tenantPayloadHash,
          retention_until: tenantRetentionUntil,
          now: () => new Date().toISOString(),
          log: (entry) => console.log(JSON.stringify(entry)),
          log_error: (entry) => console.error(JSON.stringify(entry)),
        });
        continue;
      }
      if (ackMalformedTenantQueueMessage(message,
        (entry) => console.error(JSON.stringify(entry)))) {
        continue;
      }
      if (isTenantTaskBoardRepairBody(message.body)) {
        const tenantBody = message.body;
        const repairDestination = tenantTaskBoardRepairDestination(env, tenantBody.payload);
        const runtimeTenantId = tenantBody.tenant_context.tenant.tenant_id;
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context,
          tenantConfiguredDesiredEffectByCapability(env));
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
                    await processTaskBoardRepair(repair, env, runtimeTenantId, tenantCredentialFetch,
                      undefined, undefined, tenantContext.workspace_connection.workspace_id,
                      tenantCredentialFetch, repairDestination.taskProjectCodes);
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
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context,
          tenantConfiguredDesiredEffectByCapability(env));
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
                refresh: {
                  issue: () => reissueLongRunningTenantContext(env, tenantContext, expectedScope),
                  now,
                },
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
            tenantRuntimeClients(runtimeEnv, tenantContext,
              tenantConfiguredDesiredEffectByCapability(runtimeEnv)).authority.read_workspace_connection(connectionId),
          resolveVerificationKey: (runtimeEnv, keyId) => resolveTenantVerificationKey(runtimeEnv, keyId),
          deploymentProfile: tenantDeploymentProfile,
          requiredAudience: (runtimeEnv) => requiredRuntimeBinding(runtimeEnv.MANA_REQUIRED_AUDIENCE),
          requiredCapabilityId: (runtimeEnv) => requiredRuntimeBinding(runtimeEnv.MANA_REQUIRED_CAPABILITY_ID),
          resolveProjectScope: (_runtimeEnv, body) =>
            meetingMinutesRecoveryProjectScope(body.tenant_context),
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
        const clients = tenantRuntimeClients(env, tenantBody.tenant_context,
          tenantConfiguredDesiredEffectByCapability(env));
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
                refresh: {
                  issue: () => reissueLongRunningTenantContext(env, tenantContext, expectedScope),
                  now,
                },
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
      const clients = tenantRuntimeClients(env, tenantBody.tenant_context,
        tenantConfiguredDesiredEffectByCapability(env));
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
                }, undefined, () => tenantConfiguredDesiredEffectByCapability(env));
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
                if (shouldAckRuntimeEventInProgress(runtimeClaim)) {
                  const reconciliationQueue = createDurableExternalEffectReconciliationQueueClient(
                    env.TENANT_RUNTIME_STATE,
                    { tenant_id: tenantContext.tenant.tenant_id, effect_id: tenantContext.idempotency_key },
                  );
                  const reconcilesThisClaim = await hasVerifiedPendingExternalEffectReconciliation({
                    reconciliation_queue: reconciliationQueue,
                    tenant_context: tenantContext,
                    runtime_event_id: deliveryId,
                    runtime_claim_token: runtimeClaim.claimToken,
                    delivery_identity: {
                      provider: "slack",
                      workspace_id: event.workspaceId,
                      app_id: tenantContext.workspace_connection.app_id,
                      channel_id: event.channelId,
                      thread_ts: event.threadTs,
                      event_id: event.eventId,
                      delivery_id: deliveryId,
                      message_ts: event.messageTs,
                      workspace_name: workspaceName(event),
                    },
                  });
                  if (reconcilesThisClaim) {
                    // A0 owns this exact durable reconciliation. T0 observes
                    // the claim token solely for equality; it cannot settle or
                    // send the external effect.
                    return { outcome: "reconciliation_in_progress" as const };
                  }
                }
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
              const postTenantReply = (replyEvent: SlackQueueEvent, text: string, effectId = "reply") => {
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
                  effect_id: effectId,
                  post: () => postSlackReply(replyEvent, text, {
                    fetch: tenantCredentialFetch,
                  }),
                });
              };
              const runTenantOperation = <R extends {
                outcome?: string;
                responseTs?: string;
                accounting?: "deferred" | "already_recorded";
                failureCode?: string;
                replyState?: "not_attempted" | "delivered" | "failed" | "unknown";
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
                  return {
                    outcome: completedReply.outcome ?? "already_completed" as const,
                    responseTs: completedReply.responseTs,
                  };
                }
                return executeTenantContainerOperation({
                  tenant_context: tenantBody.tenant_context,
                  expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                  verifier,
                  now: tenantConsumerOptions.now(),
                  execute: (tenantBoundaryHandle) => routeRuntimeEvent(event, {
                    meetingTasksEnabled: env.RUNTIME_EXECUTION_MODE === "meeting_tasks",
                    processDisabledMeetingTask: async () => {
                      const responseTs = await postTenantReply(event,
                        "この環境では、議事録からのタスク登録はまだ利用できません。管理者に利用開始の設定を確認してください。");
                      const completedAt = new Date().toISOString();
                      await persistReplyCompletion(workspace.fs, {
                        eventId: event.eventId,
                        responseTs,
                        completedAt,
                        outcome: "meeting_tasks_disabled",
                      });
                      await markWorkspaceEngaged(workspace.fs, completedAt);
                      return { outcome: "meeting_tasks_disabled", responseTs };
                    },
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
                    processReply: () => executeSharedReplyRuntime({
                      env,
                      fs: workspace.fs,
                      event,
                      placement,
                      runtimeTenantId,
                      runtimeWorkspaceId,
                      workspaceSession,
                      tenantCredentialFetch,
                      claudeRuntime,
                      tenantBoundaryHandle,
                      tenantBoundaryExpiresAt: tenantBody.tenant_context.expires_at,
                      trace,
                      postReply: postTenantReply,
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
  | CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>
  | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent
  | ContractLedgerSyncEvent | ContractLedgerApprovalEvent>;
