import type { MeetingMinutesRecovery } from "./meeting-minutes-contracts.js";
import { processMeetingMinutesRecoveryQueue, type MeetingMinutesRecoveryEffects,
  type MeetingMinutesRecoveryRuntimeDependencies } from "./meeting-minutes-recovery-runtime.js";
import { MeetingMinutesSlackClient } from "./meeting-minutes-slack.js";
import type { BoundaryName, DeploymentProfileName, ExpectedTenantScope, TenantContextEnvelope,
  WorkspaceConnectionSnapshot } from "./multitenancy/contracts.js";
import { deny } from "./multitenancy/errors.js";
import type { IdempotencyStore } from "./multitenancy/idempotency.js";
import { TenantRuntimeBoundaryVerifier, type TenantQueueBody,
  type TenantQueueMessageLike } from "./multitenancy/runtime-boundaries.js";
import type { WorkspaceFs } from "./workspace-store.js";

/** Platform primitives below the production recovery composition contract. */
export interface MeetingMinutesRecoveryPlatform<Env> {
  reissueTenantContext(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>): Promise<TenantContextEnvelope>;
  readAuthoritativeSnapshot(env: Env, tenantContext: TenantContextEnvelope,
    connectionId: string): Promise<WorkspaceConnectionSnapshot>;
  resolveVerificationKey(env: Env, keyId: string): Promise<CryptoKey | undefined>;
  deploymentProfile(env: Env): DeploymentProfileName;
  requiredAudience(env: Env): string;
  requiredCapabilityId(env: Env): string;
  resolveProjectScope(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>): {
    project_id: string; project_ids: readonly string[];
  };
  now(env: Env): string;
  ownership(env: Env, tenantId: string): IdempotencyStore;
  payloadHash(payload: MeetingMinutesRecovery): string | Promise<string>;
  retentionUntil(now: string): string;
  executeBoundary<T>(input: { env: Env; boundary: BoundaryName; tenantContext: TenantContextEnvelope;
    expectedScope: ExpectedTenantScope; verifier: TenantRuntimeBoundaryVerifier; now(): string;
    execute(credentialFetch: typeof fetch): Promise<T> }): Promise<T>;
  executeSlack<T>(input: { env: Env; effectId: string; event: unknown;
    tenantContext: TenantContextEnvelope; expectedScope: ExpectedTenantScope;
    verifier: TenantRuntimeBoundaryVerifier; now(): string;
    execute(credentialFetch: typeof fetch): Promise<T> }): Promise<T>;
  withWorkspace<T>(input: { env: Env; tenantContext: TenantContextEnvelope;
    recovery: MeetingMinutesRecovery; execute(fs: WorkspaceFs): Promise<T> }): Promise<T>;
  markTerminal(env: Env, tenantId: string, runId: string): Promise<void>;
}

function recoveryEventId(recovery: MeetingMinutesRecovery): string {
  return `meeting_minutes_recovery:${recovery.runId}:${recovery.actionTs}`;
}

function expectedRecoveryScope<Env>(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>,
  platform: MeetingMinutesRecoveryPlatform<Env>): ExpectedTenantScope {
  const recovery = body.payload;
  const envelope = body.tenant_context;
  if (recovery.workspaceId !== envelope.workspace_connection.workspace_id
    || recovery.appId !== envelope.workspace_connection.app_id
    || recovery.channelId !== envelope.slack.channel_id
    || recovery.threadTs !== envelope.slack.thread_ts
    || recoveryEventId(recovery) !== envelope.slack.event_id
    || recovery.userId !== envelope.actor.authenticated_subject_id
    || envelope.placement.profile !== platform.deploymentProfile(env)) {
    deny("queue_consumer", "CROSS_TENANT_CANDIDATE");
  }
  return {
    audience: platform.requiredAudience(env), workspace_id: recovery.workspaceId,
    app_id: recovery.appId, channel_id: recovery.channelId, thread_ts: recovery.threadTs,
    actor_principal_id: envelope.actor.principal_id,
    ...platform.resolveProjectScope(env, body),
    capability_id: platform.requiredCapabilityId(env),
    deployment_id: envelope.placement.deployment_id,
  };
}

/** The sole production dependency composition used by the Worker and tests. */
export function composeMeetingMinutesRecoveryProduction<Env>(
  platform: MeetingMinutesRecoveryPlatform<Env>,
): MeetingMinutesRecoveryRuntimeDependencies<Env> {
  return {
    refreshTenantContext: (env, body) => platform.reissueTenantContext(env, body),
    prepareQueue: (env, body) => {
      const tenantContext = body.tenant_context;
      const verifier = new TenantRuntimeBoundaryVerifier({
        read_authoritative_snapshot: (connectionId) =>
          platform.readAuthoritativeSnapshot(env, tenantContext, connectionId),
        resolve_verification_key: (keyId) => platform.resolveVerificationKey(env, keyId),
      });
      return { runtimeTenantId: tenantContext.tenant.tenant_id, verifier,
        expectedScope: expectedRecoveryScope(env, body, platform), now: () => platform.now(env),
        ownership: platform.ownership(env, tenantContext.tenant.tenant_id),
        payloadHash: platform.payloadHash, retentionUntil: platform.retentionUntil };
    },
    createEffects: ({ env, tenantContext, expectedScope, verifier, now }): MeetingMinutesRecoveryEffects => ({
      boundary: (boundary, execute) => platform.executeBoundary({
        env, boundary, tenantContext, expectedScope, verifier, now, execute }),
      slack: (effectId, event, execute) => platform.executeSlack({
        env, effectId, event, tenantContext, expectedScope, verifier, now, execute }),
    }),
    createClients: (_env, effects) => {
      const sourceSlack = (credentialFetch: typeof fetch) =>
        new MeetingMinutesSlackClient(undefined, credentialFetch);
      return { slack: {
        updateRunStatus: (run, outcome) => effects.slack(`source-status:${run.runId}:${outcome}:${run.updatedAt}`,
          { kind: "source_status", runId: run.runId, outcome },
          (credentialFetch) => sourceSlack(credentialFetch).updateRunStatus(run, outcome)),
        fallbackStatus: (run, outcome) => effects.slack(`source-status-fallback:${run.runId}:${outcome}`,
          { kind: "source_status_fallback", runId: run.runId, outcome },
          (credentialFetch) => sourceSlack(credentialFetch).projectStatusFailure(run)),
      } };
    },
    withWorkspace: (input) => platform.withWorkspace(input),
    markTerminal: (env, tenantId, runId) => platform.markTerminal(env, tenantId, runId),
  };
}

export function handleMeetingMinutesRecoveryQueue<Env>(
  message: TenantQueueMessageLike<MeetingMinutesRecovery>, env: Env,
  platform: MeetingMinutesRecoveryPlatform<Env>,
): Promise<void> {
  return processMeetingMinutesRecoveryQueue(message, env,
    composeMeetingMinutesRecoveryProduction(platform));
}
