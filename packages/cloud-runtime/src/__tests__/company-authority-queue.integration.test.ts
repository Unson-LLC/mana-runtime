import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  consumeCompanyAuthorityQueueMessage,
  diagnoseCompanyAuthorityRuntimeEnvelope,
  isCompanyAuthorityRuntimeEnvelopeCandidate,
  isCompanyAuthorityRuntimeEnvelope,
  type AcceptedCompanyAuthorityContext,
  type CompanyAuthorityQueueDecisionSnapshot,
  type CompanyAuthorityRuntimeEnvelope,
  type ObservedExecutionRequestV1,
} from "../multitenancy/company-authority-runtime-adapter.js";
import {
  ExternalEffectOutboxMemoryStore,
  processCompanyAuthorityExternalEffect,
} from "../multitenancy/company-authority-external-effect-outbox.js";
import {
  CompanyAuthorityHumanHandoffMemoryStore,
  processCompanyAuthorityHumanHandoff,
} from "../multitenancy/company-authority-human-handoff.js";
import type { ExpectedTenantScope, TenantContextEnvelope } from "../multitenancy/contracts.js";
import { IdempotencyMemoryStore } from "../multitenancy/idempotency.js";
import { jcsCanonicalize } from "../multitenancy/jcs.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";

type Fixture = {
  id: string;
  evaluation_time: string;
  request: ObservedExecutionRequestV1;
  context: Record<string, any> & { tenant_context: TenantContextEnvelope };
};

const contractRoot = new URL(
  "../../../../contracts/mana-brainbase-company-authority/v1/",
  import.meta.url,
);
const fixtures = JSON.parse(await readFile(new URL("fixtures/cases.json", contractRoot), "utf8")) as {
  positive: Fixture[];
};
const contract = JSON.parse(await readFile(new URL("producer.contract.json", contractRoot), "utf8")) as {
  signature: { audience: string[] };
};
const key = JSON.parse(await readFile(new URL("fixtures/test-key.json", contractRoot), "utf8")) as {
  key_id: string;
  public_jwk: JsonWebKey;
};
const tenantPublicKey = await crypto.subtle.importKey(
  "jwk",
  key.public_jwk,
  { name: "Ed25519" },
  true,
  ["verify"],
);

function fixture(id: string): Fixture {
  const selected = fixtures.positive.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`missing fixture: ${id}`);
  return structuredClone(selected);
}

function envelope(selected: Fixture): CompanyAuthorityRuntimeEnvelope<{ event_id: string }> {
  return {
    schema_version: "1.0",
    correlation_id: selected.request.correlation_id,
    company_authority_request: selected.request,
    company_authority_response: {
      schema_version: "1.0",
      contract_id: "mana-brainbase-company-authority/v1",
      correlation_id: selected.request.correlation_id,
      context: selected.context,
      error: null,
    },
    payload: { event_id: selected.request.delivery?.event_id ?? "" },
  };
}

function expectedScope(selected: Fixture): ExpectedTenantScope {
  const context = selected.context.tenant_context;
  return {
    audience: contract.signature.audience[0]!,
    workspace_id: context.workspace_connection.workspace_id,
    app_id: context.workspace_connection.app_id,
    channel_id: context.slack.channel_id,
    thread_ts: context.slack.thread_ts!,
    actor_principal_id: context.actor.principal_id,
    project_id: context.authorization.project_ids[0],
    project_ids: context.authorization.project_ids,
    capability_id: "company_authority_v1",
    deployment_id: context.placement.deployment_id,
  };
}

function verifier(selected: Fixture): TenantRuntimeBoundaryVerifier {
  const context = selected.context.tenant_context;
  return new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: async () => ({
      ...context.workspace_connection,
      tenant_id: context.tenant.tenant_id,
      installer_id: "person-sato",
      granted_scopes: [],
      deployment_id: context.placement.deployment_id,
      profile: context.placement.profile,
      credential_mode: context.credential.mode,
      contract_revision: context.contract_revision,
    }),
    resolve_verification_key: async () => tenantPublicKey,
  });
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function message(body: CompanyAuthorityRuntimeEnvelope<{ event_id: string }>) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function options(selected: Fixture, callbacks: {
  process_auto(
    context: AcceptedCompanyAuthorityContext,
    payload: { event_id: string },
    snapshot: CompanyAuthorityQueueDecisionSnapshot,
  ): Promise<unknown>;
  route_approval(
    context: AcceptedCompanyAuthorityContext,
    payload: { event_id: string },
    snapshot: CompanyAuthorityQueueDecisionSnapshot,
  ): Promise<unknown>;
  route_human_action(
    context: AcceptedCompanyAuthorityContext,
    payload: { event_id: string },
    snapshot: CompanyAuthorityQueueDecisionSnapshot,
  ): Promise<unknown>;
}, ownership = new IdempotencyMemoryStore()) {
  const runtime = {
    tenant_verifier: verifier(selected),
    expected_tenant_scope: expectedScope(selected),
    ownership,
  };
  return {
    acceptance: {
      expected_audience: contract.signature.audience,
      expected_deployment_id: selected.context.tenant_context.placement.deployment_id,
      public_jwk: key.public_jwk,
      tenant_context_public_jwk: key.public_jwk,
      tenant_context_key_id: key.key_id,
    },
    resolve_runtime: vi.fn(async () => runtime),
    validate_payload_binding: (_context: unknown, request: ObservedExecutionRequestV1, payload: { event_id: string }) => {
      if (payload.event_id !== request.delivery?.event_id) {
        throw new TenantBoundaryError("queue_consumer", "PAYLOAD_SCOPE_MISMATCH");
      }
    },
    ...callbacks,
    execution_hash: sha256,
    retention_until: (now: string) => new Date(Date.parse(now) + 31 * 24 * 60 * 60 * 1_000).toISOString(),
    now: () => selected.evaluation_time,
  };
}

describe("company authority Queue consumer", () => {
  it("recognizes only structurally correlated runtime envelopes", () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const valid = envelope(selected);
    const mismatched = structuredClone(valid);
    mismatched.company_authority_request.correlation_id = "corr-mismatch";
    const missingResponse = structuredClone(valid) as CompanyAuthorityRuntimeEnvelope<{
      event_id: string;
    }> & { company_authority_response: unknown };
    missingResponse.company_authority_response = null;

    expect(isCompanyAuthorityRuntimeEnvelope(valid)).toBe(true);
    expect(isCompanyAuthorityRuntimeEnvelope(mismatched)).toBe(false);
    expect(isCompanyAuthorityRuntimeEnvelope(missingResponse)).toBe(false);
  });

  it("keeps Company Authority-shaped invalid envelopes on the diagnostic retry path", () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const valid = envelope(selected);
    const mismatched = structuredClone(valid);
    mismatched.company_authority_request.correlation_id = "corr-mismatch";
    const { company_authority_response: _missingResponse, ...missingResponse } = structuredClone(valid);
    const unknownSchema = { ...valid, schema_version: "9.9" };
    const ordinarySlackEvent = { type: "event_callback", event_id: "ordinary" };

    expect(isCompanyAuthorityRuntimeEnvelopeCandidate(valid)).toBe(true);
    expect(isCompanyAuthorityRuntimeEnvelopeCandidate(mismatched)).toBe(true);
    expect(isCompanyAuthorityRuntimeEnvelopeCandidate(missingResponse)).toBe(true);
    expect(isCompanyAuthorityRuntimeEnvelopeCandidate(unknownSchema)).toBe(true);
    expect(isCompanyAuthorityRuntimeEnvelopeCandidate(ordinarySlackEvent)).toBe(false);

    expect(diagnoseCompanyAuthorityRuntimeEnvelope(mismatched)).toMatchObject({
      code: "AUTHORITY_SCOPE_MISMATCH",
      stage: "company_authority_runtime_envelope",
      reason: "correlation_mismatch",
      correlation_id: valid.correlation_id,
    });
    expect(diagnoseCompanyAuthorityRuntimeEnvelope(missingResponse)).toMatchObject({
      code: "AUTHORITY_ENVELOPE_INVALID",
      stage: "company_authority_runtime_envelope",
      reason: "missing_response",
      correlation_id: valid.correlation_id,
    });
    expect(diagnoseCompanyAuthorityRuntimeEnvelope(unknownSchema)).toMatchObject({
      code: "AUTHORITY_ENVELOPE_INVALID",
      stage: "company_authority_runtime_envelope",
      reason: "unknown_schema",
      correlation_id: valid.correlation_id,
    });
  });

  it("executes an auto effect once across an identical redelivery", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const ownership = new IdempotencyMemoryStore();
    const first = message(envelope(selected));
    const redelivery = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(first, options(selected, callbacks, ownership));
    await consumeCompanyAuthorityQueueMessage(redelivery, options(selected, callbacks, ownership));

    expect(callbacks.process_auto).toHaveBeenCalledTimes(1);
    expect(callbacks.route_approval).not.toHaveBeenCalled();
    expect(callbacks.route_human_action).not.toHaveBeenCalled();
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(redelivery.ack).toHaveBeenCalledTimes(1);
    expect(first.retry).not.toHaveBeenCalled();
    expect(redelivery.retry).not.toHaveBeenCalled();
  });

  it("resolves runtime dependencies only after accepting the context, request, and payload", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const returnedOwnership = new IdempotencyMemoryStore();
    const runtimeOptions = options(selected, callbacks, returnedOwnership);
    const queued = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(queued, runtimeOptions);

    expect(runtimeOptions.resolve_runtime).toHaveBeenCalledTimes(1);
    expect(runtimeOptions.resolve_runtime).toHaveBeenCalledWith({
      context: expect.objectContaining({
        authority: expect.objectContaining({ decision: "auto" }),
      }),
      request: expect.objectContaining({
        correlation_id: selected.request.correlation_id,
      }),
      payload: { event_id: selected.request.delivery?.event_id ?? "" },
    });
    expect(returnedOwnership.read(selected.context.tenant_context.idempotency_key))
      .toEqual(expect.objectContaining({ state: "succeeded" }));
  });

  it("passes an immutable accepted request and one execution hash to the decision callback", async () => {
    const selected = fixture("POS-APPROVAL-EXTERNAL-SIDE-EFFECT");
    const queued = message(envelope(selected));
    const acceptedResourceRef = selected.request.requested_action.resource_ref;
    const routeApproval = vi.fn(async (
      _context: AcceptedCompanyAuthorityContext,
      _payload: { event_id: string },
      _snapshot: CompanyAuthorityQueueDecisionSnapshot,
    ) => "approval");
    const runtimeOptions = options(selected, {
      process_auto: vi.fn(async () => "auto"),
      route_approval: routeApproval,
      route_human_action: vi.fn(async () => "human_action"),
    });
    const originalExecutionHash = runtimeOptions.execution_hash;
    runtimeOptions.execution_hash = vi.fn(async (acceptedEnvelope) => {
      const hash = await originalExecutionHash(acceptedEnvelope);
      queued.body.company_authority_request.requested_action.resource_ref = "company://mutated/after-acceptance";
      return hash;
    });

    await consumeCompanyAuthorityQueueMessage(queued, runtimeOptions);

    expect(routeApproval).toHaveBeenCalledTimes(1);
    expect(routeApproval.mock.calls[0]?.[2]).toEqual({
      request: expect.objectContaining({
        requested_action: expect.objectContaining({ resource_ref: acceptedResourceRef }),
      }),
      execution_hash: expect.stringMatching(/^sha256:/),
      envelope: expect.objectContaining({
        schema_version: "1.0",
        correlation_id: selected.request.correlation_id,
        company_authority_request: expect.objectContaining({
          requested_action: expect.objectContaining({ resource_ref: acceptedResourceRef }),
        }),
        payload: { event_id: selected.request.delivery?.event_id ?? "" },
      }),
    });
    expect(runtimeOptions.execution_hash).toHaveBeenCalledTimes(1);
    expect(queued.ack).toHaveBeenCalledTimes(1);
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("does not resolve runtime dependencies for invalid or tampered envelopes", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const invalidOptions = options(selected, callbacks);
    const invalid = {
      ...envelope(selected),
      correlation_id: "corr-invalid",
    };
    const tamperedOptions = options(selected, callbacks);
    const originalResponse = structuredClone(envelope(selected).company_authority_response) as {
      context: Record<string, unknown>;
      [key: string]: unknown;
    };
    const tampered = {
      ...envelope(selected),
      company_authority_response: {
        ...originalResponse,
        context: {
          ...originalResponse.context,
          scope: {
            ...(originalResponse.context.scope as Record<string, unknown>),
            project_ids: ["project-other"],
          },
        },
      },
    };
    const nestedTamperedOptions = options(selected, callbacks);
    const nestedTampered = structuredClone(envelope(selected)) as any;
    nestedTampered.company_authority_response.context.tenant_context.integrity.signature = "invalid";

    await consumeCompanyAuthorityQueueMessage(message(invalid), invalidOptions);
    await consumeCompanyAuthorityQueueMessage(message(tampered), tamperedOptions);
    await consumeCompanyAuthorityQueueMessage(message(nestedTampered), nestedTamperedOptions);

    const payloadTamperedOptions = options(selected, callbacks);
    const payloadTampered = envelope(selected);
    payloadTampered.payload.event_id = "event-other";
    await consumeCompanyAuthorityQueueMessage(message(payloadTampered), payloadTamperedOptions);

    expect(invalidOptions.resolve_runtime).not.toHaveBeenCalled();
    expect(tamperedOptions.resolve_runtime).not.toHaveBeenCalled();
    expect(nestedTamperedOptions.resolve_runtime).not.toHaveBeenCalled();
    expect(payloadTamperedOptions.resolve_runtime).not.toHaveBeenCalled();
  });

  it("maps resolver canonical failures before choosing Queue ACK or retry", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const logError = vi.fn();
    const terminalOptions = { ...options(selected, callbacks), log_error: logError };
    terminalOptions.resolve_runtime.mockRejectedValueOnce(new TenantBoundaryError(
      "queue_consumer",
      "AUTHORITY_SCOPE_MISMATCH",
      undefined,
      { phase: "company_authority_project_binding", secret: "not-logged" },
    ));
    const terminal = message(envelope(selected));
    const retryableOptions = options(selected, callbacks);
    retryableOptions.resolve_runtime.mockRejectedValueOnce(new Error("temporary"));
    const retryable = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(terminal, terminalOptions);
    await consumeCompanyAuthorityQueueMessage(retryable, retryableOptions);

    expect(terminal.ack).toHaveBeenCalledTimes(1);
    expect(terminal.retry).not.toHaveBeenCalled();
    expect(retryable.retry).toHaveBeenCalledTimes(1);
    expect(retryable.ack).not.toHaveBeenCalled();
    expect(callbacks.process_auto).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith({
      event: "company_authority_queue_failed",
      correlation_id: terminal.body.correlation_id,
      code: "AUTHORITY_SCOPE_MISMATCH",
      boundary: "queue_consumer",
      phase: "company_authority_project_binding",
    });
  });

  it.each([
    ["POS-APPROVAL-EXTERNAL-SIDE-EFFECT", "approval"],
    ["POS-HUMAN-ACTION-COMPANY-WRITE", "human_action"],
  ] as const)("routes %s without invoking the protected auto effect", async (id, decision) => {
    const selected = fixture(id);
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const queued = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(queued, options(selected, callbacks));

    expect(callbacks.process_auto).not.toHaveBeenCalled();
    expect(callbacks.route_approval).toHaveBeenCalledTimes(decision === "approval" ? 1 : 0);
    expect(callbacks.route_human_action).toHaveBeenCalledTimes(decision === "human_action" ? 1 : 0);
    expect(queued.ack).toHaveBeenCalledTimes(1);
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("converges to one pending handoff when the response is lost after durable approval persistence", async () => {
    const selected = fixture("POS-APPROVAL-EXTERNAL-SIDE-EFFECT");
    const handoffs = new CompanyAuthorityHumanHandoffMemoryStore();
    const ownership = new IdempotencyMemoryStore();
    let loseResponse = true;
    const routeApproval = vi.fn(async (
      context: AcceptedCompanyAuthorityContext,
      payload: { event_id: string },
      snapshot: CompanyAuthorityQueueDecisionSnapshot,
    ) => {
      const result = await processCompanyAuthorityHumanHandoff({
        context,
        request: snapshot.request,
        payload,
        execution_hash: snapshot.execution_hash,
        store: handoffs,
        now: () => selected.evaluation_time,
      });
      if (loseResponse) {
        loseResponse = false;
        throw new TenantBoundaryError("queue_consumer", "UPSTREAM_UNAVAILABLE");
      }
      return result;
    });
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: routeApproval,
      route_human_action: vi.fn(async () => "human_action"),
    };
    const first = message(envelope(selected));
    const redelivery = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(first, options(selected, callbacks, ownership));
    await consumeCompanyAuthorityQueueMessage(redelivery, options(selected, callbacks, ownership));

    const tenantContext = selected.context.tenant_context;
    await expect(handoffs.read(
      tenantContext.tenant.tenant_id,
      tenantContext.idempotency_key,
    )).resolves.toMatchObject({
      decision: "approval",
      state: "pending_approval",
      target: { role: "approver" },
    });
    expect(routeApproval).toHaveBeenCalledTimes(2);
    expect(callbacks.process_auto).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(redelivery.ack).toHaveBeenCalledTimes(1);
    expect(redelivery.retry).not.toHaveBeenCalled();
  });

  it("terminally acknowledges deny and tampered payloads with zero effects", async () => {
    const denied = fixture("POS-DENY-COMPANY-WRITE");
    const accepted = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const callbacks = {
      process_auto: vi.fn(async () => "auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const denyMessage = message(envelope(denied));
    const tamperedEnvelope = envelope(accepted);
    tamperedEnvelope.payload.event_id = "wrong-event";
    const tamperedMessage = message(tamperedEnvelope);

    await consumeCompanyAuthorityQueueMessage(denyMessage, options(denied, callbacks));
    await consumeCompanyAuthorityQueueMessage(tamperedMessage, options(accepted, callbacks));

    expect(callbacks.process_auto).not.toHaveBeenCalled();
    expect(callbacks.route_approval).not.toHaveBeenCalled();
    expect(callbacks.route_human_action).not.toHaveBeenCalled();
    expect(denyMessage.ack).toHaveBeenCalledTimes(1);
    expect(tamperedMessage.ack).toHaveBeenCalledTimes(1);
    expect(denyMessage.retry).not.toHaveBeenCalled();
    expect(tamperedMessage.retry).not.toHaveBeenCalled();
  });

  it("releases retryable callback failures but terminally records nonretryable failures", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const retryableCallbacks = {
      process_auto: vi.fn()
        .mockRejectedValueOnce(new TenantBoundaryError("queue_consumer", "UPSTREAM_UNAVAILABLE"))
        .mockResolvedValueOnce("auto"),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const retryableOwnership = new IdempotencyMemoryStore();
    const first = message(envelope(selected));
    const retry = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(
      first,
      options(selected, retryableCallbacks, retryableOwnership),
    );
    await consumeCompanyAuthorityQueueMessage(
      retry,
      options(selected, retryableCallbacks, retryableOwnership),
    );

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(retry.ack).toHaveBeenCalledTimes(1);
    expect(retryableCallbacks.process_auto).toHaveBeenCalledTimes(2);

    const terminalCallbacks = {
      process_auto: vi.fn(async () => {
        throw new TenantBoundaryError("queue_consumer", "PAYLOAD_SCOPE_MISMATCH");
      }),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const terminalOwnership = new IdempotencyMemoryStore();
    const terminal = message(envelope(selected));
    const terminalRedelivery = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(
      terminal,
      options(selected, terminalCallbacks, terminalOwnership),
    );
    await consumeCompanyAuthorityQueueMessage(
      terminalRedelivery,
      options(selected, terminalCallbacks, terminalOwnership),
    );

    expect(terminal.ack).toHaveBeenCalledTimes(1);
    expect(terminal.retry).not.toHaveBeenCalled();
    expect(terminalRedelivery.ack).toHaveBeenCalledTimes(1);
    expect(terminalCallbacks.process_auto).toHaveBeenCalledTimes(1);
  });

  it("records provider response loss as unknown and ACKs identical redelivery without replay", async () => {
    const selected = fixture("POS-QUEUE-REDELIVERY-IDEMPOTENT");
    const outbox = new ExternalEffectOutboxMemoryStore();
    const providerSend = vi.fn(async () => ({
      // The provider applied the effect, but its response was lost in transit.
      applied: true as const,
      response_observed: false as const,
    }));
    const callbacks = {
      process_auto: vi.fn(async (context: AcceptedCompanyAuthorityContext, payload: { event_id: string }) => (
        processCompanyAuthorityExternalEffect({
          context,
          payload,
          outbox,
          provider_send: providerSend,
        })
      )),
      route_approval: vi.fn(async () => "approval"),
      route_human_action: vi.fn(async () => "human_action"),
    };
    const ownership = new IdempotencyMemoryStore();
    const first = message(envelope(selected));
    const redelivery = message(envelope(selected));

    await consumeCompanyAuthorityQueueMessage(first, options(selected, callbacks, ownership));
    await consumeCompanyAuthorityQueueMessage(redelivery, options(selected, callbacks, ownership));

    await expect(outbox.read(
      selected.context.tenant_context.tenant.tenant_id,
      selected.context.tenant_context.idempotency_key,
    )).resolves.toMatchObject({
      state: "unknown_requires_reconcile",
    });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(redelivery.ack).toHaveBeenCalledTimes(1);
    expect(first.retry).not.toHaveBeenCalled();
    expect(redelivery.retry).not.toHaveBeenCalled();
  });
});
