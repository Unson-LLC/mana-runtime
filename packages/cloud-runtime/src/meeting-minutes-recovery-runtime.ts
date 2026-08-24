import type {
  MeetingMinutesRecovery,
  MeetingMinutesRun,
} from "./meeting-minutes-contracts.js";
import {
  recoverStaleMeetingMinutesRun,
} from "./meeting-minutes-recovery.js";
import {
  consumeTenantQueueMessage,
  type TenantQueueMessageLike,
  type TenantQueueBody,
  TenantRuntimeBoundaryVerifier,
} from "./multitenancy/runtime-boundaries.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./multitenancy/contracts.js";
import type { IdempotencyStore } from "./multitenancy/idempotency.js";
import { deny, TenantBoundaryError } from "./multitenancy/errors.js";
import type { WorkspaceFs } from "./workspace-store.js";

/** The tenant-scoped effects used by recovery's durable-object and Slack work. */
export interface MeetingMinutesRecoveryEffects {
  boundary<T>(boundary: BoundaryName, execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
  slack<T>(effectId: string, event: unknown,
    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;
}

export interface MeetingMinutesRecoverySlackClients {
  slack: {
    updateRunStatus(run: MeetingMinutesRun, outcome: "failed"): Promise<void>;
    fallbackStatus(run: MeetingMinutesRun, outcome: "failed"): Promise<void>;
  };
}

export interface MeetingMinutesRecoveryQueueContext {
  runtimeTenantId: string;
  verifier: TenantRuntimeBoundaryVerifier;
  expectedScope: ExpectedTenantScope;
  now(): string;
  ownership: IdempotencyStore;
  payloadHash(payload: MeetingMinutesRecovery): string | Promise<string>;
  retentionUntil(now: string): string;
}

export interface MeetingMinutesRecoveryRuntimeDependencies<Env> {
  /** Reissue a fresh envelope from durable recovery authorization before validation. */
  refreshTenantContext?(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>): Promise<TenantContextEnvelope>;
  prepareQueue(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>): MeetingMinutesRecoveryQueueContext;
  createEffects(input: {
    env: Env;
    tenantContext: TenantContextEnvelope;
    expectedScope: ExpectedTenantScope;
    verifier: TenantRuntimeBoundaryVerifier;
    now(): string;
  }): MeetingMinutesRecoveryEffects;
  createClients(env: Env, effects: MeetingMinutesRecoveryEffects): MeetingMinutesRecoverySlackClients;
  withWorkspace<T>(input: {
    env: Env;
    tenantContext: TenantContextEnvelope;
    recovery: MeetingMinutesRecovery;
    execute(fs: WorkspaceFs): Promise<T>;
  }): Promise<T>;
  markTerminal(env: Env, tenantId: string, runId: string): Promise<void>;
}

export async function processTenantMeetingMinutesRecovery<Env>(input: {
  env: Env;
  recovery: MeetingMinutesRecovery;
  tenantContext: TenantContextEnvelope;
  expectedScope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now(): string;
  dependencies: MeetingMinutesRecoveryRuntimeDependencies<Env>;
}): Promise<{ outcome: "recovered" | "terminal" | "superseded" }> {
  const { env, recovery, tenantContext, expectedScope, verifier, now, dependencies } = input;
  const effects = dependencies.createEffects({ env, tenantContext, expectedScope, verifier, now });
  return effects.boundary("durable_object", async () => dependencies.withWorkspace({
    env,
    tenantContext,
    recovery,
    execute: async (fs) => {
      const clients = dependencies.createClients(env, effects);
      const outcome = await recoverStaleMeetingMinutesRun(fs, recovery, {
        now: () => Date.parse(now()),
        updateStatus: (run) => clients.slack.updateRunStatus(run, "failed"),
        fallbackStatus: (run) => clients.slack.fallbackStatus(run, "failed"),
      });
      if (outcome === "not_due") deny("queue_consumer", "UPSTREAM_UNAVAILABLE");
      await dependencies.markTerminal(env, tenantContext.tenant.tenant_id, recovery.runId);
      return { outcome };
    },
  }));
}

/**
 * The production Queue recovery wiring. Keep this function executable so the
 * Queue-to-tenant-boundary-to-recovery-to-Slack path is covered by integration
 * tests without importing the Worker entrypoint or cloudflare:workers.
 */
export async function processMeetingMinutesRecoveryQueue<Env>(
  message: TenantQueueMessageLike<MeetingMinutesRecovery>,
  env: Env,
  dependencies: MeetingMinutesRecoveryRuntimeDependencies<Env>,
): Promise<void> {
  let tenantContext: TenantContextEnvelope;
  try {
    tenantContext = dependencies.refreshTenantContext
      ? await dependencies.refreshTenantContext(env, message.body)
      : message.body.tenant_context;
  } catch (error) {
    const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
    console.error(JSON.stringify({ event: "meeting_minutes_recovery_context_refresh_failed",
      event_id: message.body.tenant_context.slack.event_id, code }));
    if (code === "WORKSPACE_CONNECTION_UNAVAILABLE" || code === "UPSTREAM_UNAVAILABLE") message.retry();
    else message.ack();
    return;
  }
  const tenantBody = tenantContext === message.body.tenant_context
    ? message.body
    : { ...message.body, tenant_context: tenantContext };
  const tenantMessage = tenantBody === message.body
    ? message
    : { ...message, body: tenantBody };
  const context = dependencies.prepareQueue(env, tenantBody);
  await consumeTenantQueueMessage(tenantMessage, {
    verifier: context.verifier,
    expected_scope: () => context.expectedScope,
    now: context.now,
    ownership: context.ownership,
    payload_hash: context.payloadHash,
    retention_until: context.retentionUntil,
    log: (entry) => console.log(JSON.stringify(entry)),
    log_error: (entry) => console.error(JSON.stringify(entry)),
    process: (recovery, tenantContext) => processTenantMeetingMinutesRecovery({
      env,
      recovery,
      tenantContext,
      expectedScope: context.expectedScope,
      verifier: context.verifier,
      now: context.now,
      dependencies,
    }),
  });
}
