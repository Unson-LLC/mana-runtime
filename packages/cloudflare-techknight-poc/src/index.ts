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
import { handleMeetingMinutesInteractionEntrypoint } from "./slack-interactions.js";
import { processMeetingMinutesSelectionWithStatus } from "./meeting-minutes-lifecycle.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "./meeting-minutes-state.js";
import { handleMeetingMinutesTaskAction } from "./meeting-minutes-task-actions.js";
import { handleTaskWriteProxyRequest } from "./task-write-proxy.js";
import { peekTaskWriteApproval } from "./task-write-approval.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import { resolveMeetingMinutesDestinationSlackToken } from "./meeting-minutes-slack-routing.js";
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
import { handleDevelopmentCallback } from "./development-callback.js";
import { appendSlackThreadParticipantProfiles } from "./slack-thread-participants.js";
import { hydrateSlackAttachments } from "./slack-attachments.js";
import { hydrateGraphContext, listGraphPeople, resolveGraphPersonByName, resolveGraphRequester } from "./brainbase-graph-runtime.js";
import { RuntimeSessionRegistry, upsertRuntimeSession } from "./runtime-session-registry.js";
import {
  consumeTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
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
} from "./multitenancy/production-consumer.js";
import {
  REQUIRED_TENANT_CAPABILITIES,
  type DeploymentProfileName,
  type ExpectedTenantScope,
  type TenantContextEnvelope,
} from "./multitenancy/contracts.js";
import { deny, TenantBoundaryError } from "./multitenancy/errors.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { withTenantCredentialLease } from "./multitenancy/credential-injector.js";
import {
  createDurableTenantCredentialRegistry,
  TenantCredentialRelayHandler,
} from "./multitenancy/durable-credential-relay.js";
import {
  createDurableTenantBoundaryRegistry,
  TenantBoundaryContextHandler,
} from "./multitenancy/durable-tenant-boundary.js";
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
  TASK_BOARD_REPAIRS: Queue<TaskBoardRepairEvent>;
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

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "tenant-credential-relay.internal") {
      return this.#credentialRelay.fetch(request);
    }
    if (new URL(request.url).hostname === "tenant-boundary-context.internal") {
      return this.#boundaryContext.fetch(request);
    }
    return this.#handler.fetch(request);
  }

  alarm(): Promise<void> {
    return this.#boundaryContext.alarm();
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

  async claimDevelopmentCallback(eventId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(eventId)) throw new Error("event_id_invalid");
    const key = `development-callback:${eventId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(key)) return false;
      await transaction.put(key, { status: "pending", claimedAt: new Date().toISOString() });
      return true;
    });
  }

  async completeDevelopmentCallback(eventId: string, responseTs: string): Promise<void> {
    const key = `development-callback:${eventId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<{ status?: string }>(key);
      if (current?.status !== "pending") throw new Error("development_callback_claim_missing");
      await transaction.put(key, { status: "completed", responseTs, completedAt: new Date().toISOString() });
    });
  }

  async releaseDevelopmentCallback(eventId: string): Promise<void> {
    const key = `development-callback:${eventId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<{ status?: string }>(key);
      if (current?.status === "pending") await transaction.delete(key);
    });
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
  const results = await Promise.allSettled(targets.map((target) => env.TASK_BOARD_REPAIRS.send({
    eventType: "task_board_repair", targetId: target.targetId, tenantId: env.TENANT_ID,
    workspaceId: target.workspaceId, channelId: target.channelId, reason,
    requestedAt: new Date().toISOString(),
  })));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error("task_board_repair_enqueue_failed", {
      targetId: targets[index]?.targetId, reason, error: result.reason,
    });
  });
}

function meetingMinutesClients(
  env: Env,
  credentialLeaseHandle?: string,
  tenantBoundaryHandle?: string,
) {
  const slack = new MeetingMinutesSlackClient(env.SLACK_BOT_TOKEN ?? "");
  const github = new CloudflareMeetingMinutesGitHubClient(env.GITHUB_TOKEN ?? "");
  const claudeRuntime = resolveClaudeRuntimeConfig(env);
  const destinations = meetingMinutesRuntimeConfig(env).destinations;
  const destinationSlack = (channelId: string) => {
    const organizationId = destinations.find((destination) => destination.slackChannelId === channelId)
      ?.organization.id ?? "unson-business";
    return new MeetingMinutesSlackClient(resolveMeetingMinutesDestinationSlackToken(env, organizationId));
  };
  const taskClient = () => new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
    token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
  const contextMode = resolveMeetingMinutesContextMode(env.MEETING_MINUTES_CONTEXT_MODE);
  const contextClient = new MeetingMinutesBrainbaseContextClient(env.BRAINBASE_TASK_API_BASE_URL ?? "",
    env.BRAINBASE_TASK_API_TOKEN ?? "");
  return {
    slack,
    classify: (transcript: string, candidates: Parameters<typeof classifyMeetingMinutesDestinationInSandbox>[1]) => {
      if (!credentialLeaseHandle) throw new Error("credential_lease_required");
      return classifyMeetingMinutesDestinationInSandbox(transcript, candidates, claudeRuntime,
        createTechKnightSandbox(env, `meeting-minutes-routing-${crypto.randomUUID()}`),
        credentialLeaseHandle, tenantBoundaryHandle);
    },
    resume: {
      contextMode,
      resolveContext: (identity: Parameters<MeetingMinutesBrainbaseContextClient["resolve"]>[0], receiptId?: string) =>
        contextClient.resolve(identity, receiptId),
      postProcessingStatus: (run: MeetingMinutesRun) => slack.postProcessingStatus(run),
      download: (fileId: string) => slack.downloadTextFile(fileId),
      generate: (transcript: string, destination: MeetingMinutesDestination,
        context: Parameters<typeof generateMeetingMinutesInSandbox>[2], mode: Parameters<typeof generateMeetingMinutesInSandbox>[3]) => {
        if (!credentialLeaseHandle) throw new Error("credential_lease_required");
        return generateMeetingMinutesInSandbox(transcript, destination, context, mode, claudeRuntime,
          createTechKnightSandbox(env, `meeting-minutes-${crypto.randomUUID()}`),
          credentialLeaseHandle, tenantBoundaryHandle);
      },
      saveGitHub: (input: Parameters<typeof github.save>[0]) => github.save(input),
      createTask: async (input: Parameters<TaskApiClient["createTask"]>[0], idempotencyKey: string) => {
        return taskClient().createTask(input, idempotencyKey);
      },
      // Destination project IDs belong to the task destination contract and are
      // not Graph person scopes. Resolve globally, then let non-unique names
      // fail closed in resolveGraphPersonByName.
      resolveAssignee: (name: string, _projectId: string) => resolveGraphPersonByName(name, undefined, {
        baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
        token: env.BRAINBASE_GRAPH_API_TOKEN,
      }),
      postParent: (channelId: string, fileName: string, summary: string, clientMsgId: string) =>
        destinationSlack(channelId).postParent(channelId, fileName, summary, clientMsgId),
      postTaskCard: (run: MeetingMinutesRun) => destinationSlack(run.destination!.slackChannelId).postTaskCard(run),
      repairTaskBoard: (projectCodes: readonly string[]) =>
        enqueueTaskBoardRepairsForProjects(env, projectCodes, "task_write"),
      postThreadChunk: (channelId: string, threadTs: string, fileName: string, text: string,
        index: number, total: number, clientMsgId: string) =>
        destinationSlack(channelId).postThreadChunk(channelId, threadTs, fileName, text, index, total, clientMsgId),
    },
    redo: {
      deleteGitHub: (destination: MeetingMinutesDestination, paths: readonly string[]) =>
        github.delete(destination.github, paths),
      deleteTask: async (taskId: string, idempotencyKey: string) => {
        const client = taskClient();
        try {
          const task = await client.getTask(taskId);
          await client.deleteTask(taskId, task.version, idempotencyKey);
        } catch (error) {
          if (error instanceof TaskApiError && error.status === 404) return;
          throw error;
        }
      },
      retractSharedMinutes: (destination: MeetingMinutesDestination,
        parentTs: string, fileName: string) =>
        destinationSlack(destination.slackChannelId).retractSharedMinutes(destination.slackChannelId, parentTs, fileName),
      showDestinationSelection: (run: MeetingMinutesRun, destinations: Parameters<typeof slack.showDestinationSelection>[1]) =>
        slack.showDestinationSelection(run, destinations),
    },
  };
}

function requiredRuntimeBinding(value: string | undefined): string {
  if (!value?.trim()) deny("runtime_configuration", "CONFIGURATION_INVALID");
  return value;
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
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
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
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
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
    app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
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
  tenantId: string;
  credentialLeaseHandle: string;
  tenantBoundaryHandle: string;
}): Promise<{ outcome: "completed" }> {
  const { env, config, selection, tenantId, credentialLeaseHandle, tenantBoundaryHandle } = input;
  const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
    tenantId, selection.workspaceId, selection.runId,
  ));
  const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
  await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
    const clients = meetingMinutesClients(env, credentialLeaseHandle, tenantBoundaryHandle);
    const armed = await armMeetingMinutesRecovery(workspace.fs, selection);
    if (!armed.terminal) {
      await meetingMinutesDeploymentGate(env, tenantId).markActive({ runId: selection.runId,
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + armed.delaySeconds * 1_000).toISOString() });
      await env.TECHKNIGHT_EVENTS.send(armed.event, {
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
  return executeTenantBoundary({
    boundary: "durable_object",
    tenant_context: tenantContext,
    expected_scope: expectedScope,
    verifier,
    now: now(),
    execute: async () => {
      const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
        tenantContext.tenant.tenant_id, recovery.workspaceId, recovery.runId,
      ));
      const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
      return withDisposableResource(() => getWorkspace(handle), async (workspace) => {
        const outcome = await recoverStaleMeetingMinutesRun(workspace.fs, recovery, {
          now: () => Date.parse(now()),
          updateStatus: async (run) => executeTenantBoundary({
            boundary: "slack_delivery",
            tenant_context: tenantContext,
            expected_scope: expectedScope,
            verifier,
            now: now(),
            execute: () => meetingMinutesClients(env).slack.updateRunStatus(run, "failed"),
          }),
        });
        if (outcome === "not_due") deny("queue_consumer", "UPSTREAM_UNAVAILABLE");
        await meetingMinutesDeploymentGate(env, tenantContext.tenant.tenant_id).markTerminal(recovery.runId);
        return { outcome };
      });
    },
  });
}

async function processTenantMeetingMinutesRedo(input: {
  env: Env;
  config: ReturnType<typeof meetingMinutesRuntimeConfig>;
  command: MeetingMinutesRedo;
  tenantId: string;
  credentialLeaseHandle: string;
  tenantBoundaryHandle: string;
}): Promise<{ outcome: "completed" }> {
  const { env, config, command, tenantId, credentialLeaseHandle, tenantBoundaryHandle } = input;
  const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
    tenantId, command.workspaceId, command.runId,
  ));
  const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
  await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
    const clients = meetingMinutesClients(env, credentialLeaseHandle, tenantBoundaryHandle);
    await processMeetingMinutesRedo(workspace.fs, command, config, clients.redo);
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
      let callbackWorkspace: DurableObjectStub<TechKnightWorkspace> | undefined;
      return handleDevelopmentCallback(request, {
        token: env.DEVELOPMENT_CALLBACK_TOKEN, tenantId: env.TENANT_ID,
        workspaceId: env.SLACK_EXPECTED_TEAM_ID, placements,
        claim: async (eventId, payload) => {
          const callbackEvent: SlackQueueEvent = { tenantId: env.TENANT_ID, eventId, workspaceId: payload.workspace_id,
            channelId: payload.channel_id, threadTs: payload.thread_ts, messageTs: payload.thread_ts,
            userId: payload.requester_id, eventType: "development_result", text: "", receivedAt: new Date().toISOString() };
          const id = env.TECHKNIGHT_WORKSPACE.idFromName(workspaceName(callbackEvent));
          callbackWorkspace = env.TECHKNIGHT_WORKSPACE.get(id);
          return callbackWorkspace.claimDevelopmentCallback(eventId);
        },
        complete: async (eventId, responseTs) => {
          if (!callbackWorkspace) throw new Error("development_callback_workspace_missing");
          await callbackWorkspace.completeDevelopmentCallback(eventId, responseTs);
        },
        release: async (eventId) => {
          if (!callbackWorkspace) return;
          await callbackWorkspace.releaseDevelopmentCallback(eventId);
        },
        post: (event, text) => postSlackReply(event, text, { slackBotToken: env.SLACK_BOT_TOKEN }),
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      const config = meetingMinutesRuntimeConfig(env);
      return handleMeetingMinutesInteractionEntrypoint(request, env, ctx, config.operatorUserIds,
        async ({ approvalId, payloadHash, approverId, channelId }) => {
          const approvalChannelId = env.TASK_WRITE_APPROVAL_CHANNEL_ID ?? env.SLACK_ALLOWED_CHANNEL_ID;
          if (channelId !== approvalChannelId) return Response.json({ error: "task_write_approval_channel_mismatch" }, { status: 403 });
          const pending = await peekTaskWriteApproval(env.TASK_WRITE_APPROVALS, approvalId);
          if (pending.payloadHash !== payloadHash) return Response.json({ error: "task_write_approval_payload_mismatch" }, { status: 403 });
          const approved = await handleTaskWriteProxyRequest(new Request("https://task-write.internal/api/task-write", {
            method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": pending.capability,
              "x-mana-task-write-approval-id": approvalId, "x-mana-task-write-approver-id": approverId },
            body: JSON.stringify(pending.body),
          }), env);
          if (!approved.ok) return approved;
          return Response.json({ ok: true, approval_id: approvalId });
        }, undefined, async (payload) => {
          const parsedTeamIds = (() => { try { return JSON.parse(env.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON ?? "{}") as Record<string, string>; }
            catch { return {}; } })();
          const loadWorkspace = async <T>(runId: string, operation: (workspace: { fs: Parameters<typeof loadMeetingMinutesRun>[0] }) => Promise<T>) => {
            const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
              env.TENANT_ID, env.SLACK_EXPECTED_TEAM_ID, runId));
            const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
            return withDisposableResource(() => getWorkspace(handle), operation);
          };
          const taskClient = new TaskApiClient({ baseUrl: env.BRAINBASE_TASK_API_BASE_URL ?? "",
            token: env.BRAINBASE_TASK_API_TOKEN ?? "", fetchImpl: async (request, init) =>
              fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }) });
          let cachedRun: MeetingMinutesRun | undefined;
          return handleMeetingMinutesTaskAction(payload, { sourceTeamId: env.SLACK_EXPECTED_TEAM_ID,
            destinationTeamIds: parsedTeamIds,
            operatorUserIds: config.operatorUserIds,
            loadRun: async (runId) => { cachedRun = await loadWorkspace(runId, (workspace) => loadMeetingMinutesRun(workspace.fs, runId)); return cachedRun; },
            saveRun: (run) => loadWorkspace(run.runId, async (workspace) => { await saveMeetingMinutesRun(workspace.fs, run); }),
            getTask: (taskId) => taskClient.getTask(taskId),
            updateTask: (taskId, input, key) => taskClient.updateTask(taskId, input, key),
            deleteTask: (taskId, version, key) => taskClient.deleteTask(taskId, version, key),
            updateCard: async (run) => {
              const token = resolveMeetingMinutesDestinationSlackToken(env, run.destination!.organization.id);
              const client = new MeetingMinutesSlackClient(token);
              await client.updateTaskCard(run); },
            openView: async (organizationId, triggerId, view) => {
              const token = resolveMeetingMinutesDestinationSlackToken(env, organizationId);
              await new MeetingMinutesSlackClient(token).openTaskEditView(triggerId, view);
            }, listPeople: () => listGraphPeople(undefined, {
              baseUrl: env.BRAINBASE_GRAPH_API_BASE_URL ?? env.BRAINBASE_TASK_API_BASE_URL,
              token: env.BRAINBASE_GRAPH_API_TOKEN,
            }), repairTaskBoard: (projectCodes) => enqueueTaskBoardRepairsForProjects(
              env, projectCodes, "task_write",
            ), defer: (work) => ctx.waitUntil(work),
          });
        }, async (command) => {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const resolved = await resolveSlackWorkerIngress({
            identity: {
              provider: "slack",
              app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
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
        });
    }
    if (request.method === "POST" && url.pathname === "/slack/commands") {
      const placements = parseRuntimePlacements(env.RUNTIME_PLACEMENTS_JSON);
      const developmentPlacements = placements.filter((placement) => placement.developmentEnabled === true);
      return handleSlackCommandRequest(request, { signingSecret: env.SLACK_SIGNING_SECRET,
        expectedTeamId: env.SLACK_EXPECTED_TEAM_ID,
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
    | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent>, env: Env): Promise<void> {
    const executeTenantContainerOperation = <T>(input: {
      tenant_context: TenantContextEnvelope;
      expected_scope: ExpectedTenantScope;
      verifier: TenantRuntimeBoundaryVerifier;
      now: string;
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
          await registry.dispose(handle);
        }
      },
    });
    for (const message of batch.messages) {
      if (isTaskBoardRepairEvent(message.body)) {
        await consumeTaskBoardRepair({
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry(),
        }, env);
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
                  tenantId: runtimeTenantId,
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
        const recovery = message.body;
        try {
          const clients = tenantRuntimeClients(env);
          const requiredScopes = requiredRuntimeBinding(env.MANA_REQUIRED_SLACK_SCOPES)
            .split(",").map((value) => value.trim()).filter(Boolean);
          const resolved = await resolveSlackWorkerIngress({
            identity: {
              provider: "slack",
              app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID),
              workspace_id: recovery.workspaceId,
              event_id: meetingMinutesRecoveryEventId(recovery),
              channel_id: recovery.channelId,
              thread_ts: recovery.threadTs,
              requester_id: recovery.userId,
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
          await env.TECHKNIGHT_EVENTS.send({
            schema_version: "1.0",
            tenant_context: resolved.tenant_context,
            payload: recovery,
          });
          message.ack();
        } catch (error) {
          const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
          console.error(JSON.stringify({ event: "meeting_minutes_recovery_trigger_failed", code }));
          if (code === "WORKSPACE_CONNECTION_UNAVAILABLE" || code === "UPSTREAM_UNAVAILABLE") {
            message.retry();
          } else {
            message.ack();
          }
        }
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
                  tenantId: runtimeTenantId,
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
            process: () => withTenantCredentialLease({
              envelope: tenantContext,
              expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
              audience: requiredRuntimeBinding(env.MANA_CREDENTIAL_AUDIENCE),
              broker: clients.credential_broker,
              credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
              read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
                tenantContext.workspace_connection.connection_id,
              ),
              resolve_verification_key: (keyId) => resolveTenantVerificationKey(env, keyId),
              now: tenantConsumerOptions.now,
              run: (credentialLeaseHandle) => executeTenantContainerOperation({
                tenant_context: tenantContext,
                expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                verifier,
                now: tenantConsumerOptions.now(),
                execute: async (tenantBoundaryHandle) => {
                  for (const file of event.files ?? []) {
                    if (!/\.txt$/i.test(file.name)) continue;
                    const runId = `${event.eventId}_${file.id}`;
                    const id = env.MEETING_MINUTES_WORKSPACE.idFromName(meetingMinutesWorkspaceName(
                      runtimeTenantId, event.workspaceId, runId,
                    ));
                    const handle = env.MEETING_MINUTES_WORKSPACE.get(id) as unknown as WorkspaceHandle;
                    await withDisposableResource(() => getWorkspace(handle), async (workspace) => {
                      const meetingClients = meetingMinutesClients(
                        env,
                        credentialLeaseHandle,
                        tenantBoundaryHandle,
                      );
                      await processMeetingMinutesSlackEvent(workspace.fs, { ...event, files: [file] }, meetingMinutesConfig, {
                        download: (fileId) => meetingClients.slack.downloadTextFile(fileId),
                        classifyDestination: (transcript, destinations) => meetingClients.classify(transcript, destinations),
                        requestDestination: (run, destinations) => meetingClients.slack.requestDestination(run, destinations),
                      });
                    });
                  }
                  return { outcome: "awaiting_destination" };
                },
              }),
            }),
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
                  post: () => postSlackReply(replyEvent, text, { slackBotToken: env.SLACK_BOT_TOKEN }),
                });
              };
              const runTenantOperation = <R extends { outcome?: string; responseTs?: string }>(
                process: () => Promise<R>,
              ) => executeTenantRuntimeOperation({
                tenant_context: tenantContext,
                expected_scope: expectedScope,
                verifier,
                quota: clients.quota,
                accounting: clients.accounting,
                ledger: createDurableTenantAccountingClient(env.TENANT_RUNTIME_STATE, tenantContext),
                quota_unit: "model_tokens",
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
                return runTenantOperation(async () => {
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
                  develop: (request) => withTenantCredentialLease({
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
                    release: "on_consumption",
                    run: (credentialLeaseHandle) => executeTenantContainerOperation({
                      tenant_context: tenantBody.tenant_context,
                      expected_scope: tenantConsumerOptions.expected_scope(tenantBody),
                      verifier,
                      now: tenantConsumerOptions.now(),
                      execute: (tenantBoundaryHandle) => runCloudflareDevelopmentRequest({
                        request,
                        placementId: placement.placementId,
                        requesterId: event.userId!,
                        eventId: event.eventId,
                        workspaceId: event.workspaceId,
                        channelId: event.channelId,
                        threadTs: event.threadTs,
                        credentialLeaseHandle,
                        tenantBoundaryHandle,
                        callbackBaseUrl: env.DEVELOPMENT_CALLBACK_BASE_URL,
                        createSandbox: (sandboxId) => createTechKnightSandbox(env, sandboxId, "2h"),
                      }),
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
                  return { outcome: "replied" as const, responseTs };
                });
              }
              const hydrateThreadContext = async (input: SlackQueueEvent) => {
                const hydrated = await hydrateSlackQueueEventThreadContext(input, { botToken: env.SLACK_BOT_TOKEN,
                  contextAfterTs: workspaceSession.contextAfterTs });
                const withParticipants = { ...hydrated,
                  threadContext: await appendSlackThreadParticipantProfiles(hydrated.threadContext,
                    { botToken: env.SLACK_BOT_TOKEN }) };
                return hydrateSlackAttachments(withParticipants, { botToken: env.SLACK_BOT_TOKEN });
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
                        brainbaseTaskToken: env.BRAINBASE_TASK_API_TOKEN,
                        slackBotToken: env.SLACK_BOT_TOKEN,
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
                    brainbaseTaskToken: env.BRAINBASE_TASK_API_TOKEN,
                  }, async (taskSearch) => {
                    const profileResolution = await resolveSlackUserProfile({ userId: event.userId ?? "",
                      botToken: env.SLACK_BOT_TOKEN,
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
                      token: env.BRAINBASE_GRAPH_API_TOKEN,
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
                    slackBotToken: env.SLACK_BOT_TOKEN,
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
    await enqueueScheduledTaskBoardRepair(env);
  },
} satisfies ExportedHandler<Env, TenantQueueBody<SlackQueueEvent> | TenantQueueBody<MeetingMinutesSelection>
  | TenantQueueBody<MeetingMinutesRedo>
  | TenantQueueBody<MeetingMinutesRecovery>
  | SlackQueueEvent | MeetingMinutesSelection | MeetingMinutesRedo | MeetingMinutesRecovery | TaskBoardRepairEvent>;
