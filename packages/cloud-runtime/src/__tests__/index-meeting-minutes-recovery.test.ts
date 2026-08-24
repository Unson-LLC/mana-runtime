import { describe, expect, it, vi } from "vitest";
import { armMeetingMinutesRecovery } from "../meeting-minutes-recovery.js";
import {
  processMeetingMinutesRecoveryQueue,
  type MeetingMinutesRecoveryRuntimeDependencies,
} from "../meeting-minutes-recovery-runtime.js";
import {
  executeTenantBoundary,
  TenantRuntimeBoundaryVerifier,
  type TenantQueueBody,
} from "../multitenancy/runtime-boundaries.js";
import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  UnsignedTenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "../multitenancy/contracts.js";
import { signTenantContextEnvelope } from "../multitenancy/envelope.js";
import { IdempotencyMemoryStore, createIdempotencyKey } from "../multitenancy/idempotency.js";
import { MeetingMinutesSlackClient } from "../meeting-minutes-slack.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { MeetingMinutesRecovery, MeetingMinutesRun, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const NOW = new Date(Date.now() + 60_000).toISOString();
const TENANT_ID = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONNECTION_ID = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEPLOYMENT_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const WORKSPACE_ID = "T1";
const APP_ID = "A1";
const CHANNEL_ID = "C1";
const THREAD_TS = "1.1";

const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1",
  destinationId: "united", workspaceId: WORKSPACE_ID, appId: APP_ID, channelId: CHANNEL_ID,
  threadTs: THREAD_TS, userId: "U1", actionTs: "2.1" };

function run(status: MeetingMinutesRun["status"] = "routed"): MeetingMinutesRun {
  return { version: 1, runId: "Ev1_F1", eventId: "Ev1", workspaceId: WORKSPACE_ID,
    sourceAppId: APP_ID, sourceChannelId: CHANNEL_ID, sourceThreadTs: THREAD_TS,
    sourceMessageTs: THREAD_TS, file: { id: "F1", name: "meeting.txt" }, status,
    destination: { id: "united", projectId: "united", contextProjectCode: "techknight",
      taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-united", name: "United",
      organization: { id: "tech-knight", name: "Tech Knight" },
      slackChannelId: "CD", github: { owner: "o", repo: "r" } },
    slack: { processingTs: "3.1", postedChunkIndexes: [] },
    createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" };
}

const snapshot: WorkspaceConnectionSnapshot = {
  connection_id: CONNECTION_ID,
  connection_revision: "7",
  tenant_id: TENANT_ID,
  installation_id: `installation-${TENANT_ID}`,
  workspace_id: WORKSPACE_ID,
  app_id: APP_ID,
  installer_id: "U-INSTALLER",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active",
  deployment_id: DEPLOYMENT_ID,
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "11",
};

const expectedScope: ExpectedTenantScope = {
  audience: "mana-runtime",
  workspace_id: WORKSPACE_ID,
  app_id: APP_ID,
  channel_id: CHANNEL_ID,
  thread_ts: THREAD_TS,
  actor_principal_id: "person-a",
  project_id: "project-a",
  capability_id: "task.write",
  deployment_id: DEPLOYMENT_ID,
};

async function signedRecoveryContext(): Promise<{ value: TenantContextEnvelope; publicKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const eventId = "EvRecovery";
  const operationId = "op_01ARZ3NDEKTSV4RRFFQ69G5FB4";
  const idempotencyKey = await createIdempotencyKey({
    protocol_id: "mana-brainbase-tenant-context",
    protocol_major: "1",
    tenant_id: TENANT_ID,
    connection_id: CONNECTION_ID,
    slack_event_id: eventId,
    operation_id: operationId,
  });
  const envelopeNow = Date.now();
  const unsigned: UnsignedTenantContextEnvelope = {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime", "brainbase-api"],
    tenant: { tenant_id: TENANT_ID, tenant_revision: "3" },
    workspace_connection: {
      connection_id: CONNECTION_ID,
      connection_revision: "7",
      provider: "slack",
      installation_id: `installation-${TENANT_ID}`,
      workspace_id: WORKSPACE_ID,
      app_id: APP_ID,
      status: "active",
    },
    actor: {
      principal_id: "person-a",
      principal_type: "person",
      authenticated_subject_id: "slack-person-a",
    },
    authorization: {
      organization_ids: [`organization-${TENANT_ID}`],
      project_ids: ["project-a"],
      data_scopes: ["tasks:tenant"],
      capability_ids: ["task.read", "task.write"],
    },
    placement: { deployment_id: DEPLOYMENT_ID, profile: "shared_cloud" },
    slack: {
      event_id: eventId,
      channel_id: CHANNEL_ID,
      thread_ts: THREAD_TS,
      requester_id: "slack-person-a",
    },
    correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FB5",
    operation_id: operationId,
    idempotency_key: idempotencyKey,
    contract_revision: "11",
    credential: {
      mode: "customer_oauth",
      credential_ref: `credential-${TENANT_ID}`,
      billing_principal_id: `billing-${TENANT_ID}`,
    },
    issued_at: new Date(envelopeNow - 60_000).toISOString(),
    expires_at: new Date(envelopeNow + 240_000).toISOString(),
  };
  return { value: await signTenantContextEnvelope(unsigned, keyPair.privateKey, "test-key-1"), publicKey: keyPair.publicKey };
}

async function payloadHash(payload: MeetingMinutesRecovery): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(payload)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function queueMessage(body: TenantQueueBody<MeetingMinutesRecovery>) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("meeting-minutes recovery production wiring", () => {
  it("executes Queue to tenant effect to recovery handler and projects the bounded Slack fallback", async () => {
    const fs = new MemoryFs();
    await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, Date.parse(NOW) - 20 * 60 * 1_000 - 1_000);
    const signed = await signedRecoveryContext();
    const queue = queueMessage({ schema_version: "1.0", tenant_context: signed.value, payload: armed.event });
    const effectBoundaries: string[] = [];
    const effectIds: string[] = [];
    const effectEvents: unknown[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const credentialFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return String(input).endsWith("/assistant.threads.setStatus")
        ? Response.json({ ok: false, error: "status_unavailable" })
        : Response.json({ ok: true });
    }) as typeof fetch;
    const ownership = new IdempotencyMemoryStore();
    const dependencies: MeetingMinutesRecoveryRuntimeDependencies<Record<string, never>> = {
      prepareQueue: (_env, body) => ({
        runtimeTenantId: body.tenant_context.tenant.tenant_id,
        verifier: new TenantRuntimeBoundaryVerifier({
          read_authoritative_snapshot: async () => snapshot,
          resolve_verification_key: async () => signed.publicKey,
        }),
        expectedScope,
        now: () => NOW,
        ownership,
        payloadHash,
        retentionUntil: (now) => new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      createEffects: ({ tenantContext, expectedScope: scope, verifier, now }) => ({
        boundary: (boundary, execute) => {
          effectBoundaries.push(boundary);
          return executeTenantBoundary({ boundary, tenant_context: tenantContext, expected_scope: scope,
            verifier, now: now(), execute: () => execute(credentialFetch) });
        },
        slack: (effectId, event, execute) => {
          effectIds.push(effectId);
          effectEvents.push(event);
          effectBoundaries.push("slack_delivery");
          return executeTenantBoundary({ boundary: "slack_delivery", tenant_context: tenantContext,
            expected_scope: scope, verifier, now: now(), execute: () => execute(credentialFetch) });
        },
      }),
      createClients: (_env, effects) => ({
        slack: {
          updateRunStatus: (recoveryRun, outcome) => effects.slack(
            `source-status:${recoveryRun.runId}:${outcome}`,
            { kind: "source_status", runId: recoveryRun.runId, outcome },
            (fetchImpl) => new MeetingMinutesSlackClient(undefined, fetchImpl).updateRunStatus(recoveryRun, outcome),
          ),
          fallbackStatus: (recoveryRun, outcome) => effects.slack(
            `source-status-fallback:${recoveryRun.runId}:${outcome}`,
            { kind: "source_status_fallback", runId: recoveryRun.runId, outcome },
            (fetchImpl) => new MeetingMinutesSlackClient(undefined, fetchImpl).projectStatusFailure(recoveryRun),
          ),
        },
      }),
      withWorkspace: ({ execute }) => execute(fs),
      markTerminal: vi.fn(async () => undefined),
    };

    await processMeetingMinutesRecoveryQueue(queue, {}, dependencies);

    expect(queue.retry).toHaveBeenCalledOnce();
    expect(queue.ack).not.toHaveBeenCalled();
    expect(effectBoundaries).toEqual(["durable_object", "slack_delivery", "slack_delivery"]);
    expect(effectIds).toEqual(["source-status:Ev1_F1:failed", "source-status-fallback:Ev1_F1:failed"]);
    expect(effectEvents).toEqual([
      { kind: "source_status", runId: "Ev1_F1", outcome: "failed" },
      { kind: "source_status_fallback", runId: "Ev1_F1", outcome: "failed" },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/assistant.threads.setStatus",
      "https://slack.com/api/chat.update",
    ]);
    expect(requests.every((request) => !JSON.stringify(request.init?.headers ?? {}).includes("Bearer"))).toBe(true);
    const fallbackBody = String(requests[1]?.init?.body);
    expect(fallbackBody).toContain("処理ID: Ev1_F1");
    expect(fallbackBody).toContain("失敗段階: 状態表示");
    expect(fallbackBody).toContain("エラーコード: STATUS_PROJECTION_FAILED");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      projectionFailure: { stage: "status_projection", code: "STATUS_PROJECTION_FAILED" },
      lifecycle: { recoveryFallbackOutcome: "succeeded", recoveryProjectedAt: expect.any(String) },
    });
  });
});
