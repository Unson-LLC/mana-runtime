import type {
  MeetingMinutesRecovery,
} from "./meeting-minutes-contracts.js";
import {
  processMeetingMinutesRecoveryQueue,
  type MeetingMinutesRecoveryEffects,
  type MeetingMinutesRecoveryQueueContext,
  type MeetingMinutesRecoveryRuntimeDependencies,
  type MeetingMinutesRecoverySlackClients,
} from "./meeting-minutes-recovery-runtime.js";
import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "./multitenancy/contracts.js";
import type {
  TenantQueueBody,
  TenantQueueMessageLike,
  TenantRuntimeBoundaryVerifier,
} from "./multitenancy/runtime-boundaries.js";
import type { WorkspaceFs } from "./workspace-store.js";

/**
 * Cloudflare-free ports for the production meeting-minutes recovery wiring.
 *
 * The Worker entrypoint supplies the tenant authority, effect guard, workspace
 * Durable Object, and deployment gate adapters. Keeping the queue handler and
 * dependency assembly here gives integration tests the same production
 * handler/export without importing `cloudflare:workers`.
 */
export interface MeetingMinutesRecoveryProductionPorts<Env> {
  refreshTenantContext(env: Env, body: TenantQueueBody<MeetingMinutesRecovery>): Promise<TenantContextEnvelope>;
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

/**
 * Assemble the production dependency contract once, so the Worker and
 * integration tests cannot drift into separate recovery implementations.
 */
export function createMeetingMinutesRecoveryDependencies<Env>(
  ports: MeetingMinutesRecoveryProductionPorts<Env>,
): MeetingMinutesRecoveryRuntimeDependencies<Env> {
  return {
    refreshTenantContext: ports.refreshTenantContext,
    prepareQueue: ports.prepareQueue,
    createEffects: ports.createEffects,
    createClients: ports.createClients,
    withWorkspace: ports.withWorkspace,
    markTerminal: ports.markTerminal,
  };
}

/**
 * Production Queue recovery handler. This is the single exported handler used
 * by `index.ts` and by the production wiring integration test.
 */
export function handleMeetingMinutesRecoveryQueue<Env>(
  message: TenantQueueMessageLike<MeetingMinutesRecovery>,
  env: Env,
  ports: MeetingMinutesRecoveryProductionPorts<Env>,
): Promise<void> {
  return processMeetingMinutesRecoveryQueue(
    message,
    env,
    createMeetingMinutesRecoveryDependencies(ports),
  );
}
