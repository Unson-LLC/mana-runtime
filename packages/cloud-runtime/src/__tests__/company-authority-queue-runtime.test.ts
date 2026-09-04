import { describe, expect, it, vi } from "vitest";
import {
  processCompanyAuthorityAutoQueueRoute,
  resolveCompanyAuthoritySlackQueueScope,
  unavailableCompanyAuthorityQueueRoute,
} from "../multitenancy/company-authority-queue-runtime.js";
import { ExternalEffectOutboxMemoryStore } from "../multitenancy/company-authority-external-effect-outbox.js";
import { companyAuthoritySlackResourceRef } from "../multitenancy/company-authority-payload-binding.js";
import { createCompanyAuthoritySelectedContainerProviderRoute }
  from "../multitenancy/company-authority-selected-container-operation.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  TenantBoundaryContextHandler,
  type TenantBoundaryContextNamespace,
} from "../multitenancy/durable-tenant-boundary.js";
import { executeTenantContainerOperation }
  from "../multitenancy/tenant-container-operation.js";
import { runtimeGatewayBoundaries } from "../multitenancy/runtime-gateway-boundaries.js";
import type { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityRuntimeEnvelope,
  ObservedExecutionRequestV1,
} from "../multitenancy/company-authority-runtime-adapter.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "../multitenancy/contracts.js";
import type { SlackQueueEvent } from "../types.js";

const tenantContext = {
  expires_at: "2026-09-02T00:05:00.000Z",
  idempotency_key: "idem-auto-route-a",
  tenant: { tenant_id: "tenant-a" },
  workspace_connection: {
    connection_id: "connection-a",
    connection_revision: "1",
    workspace_id: "workspace-a",
    app_id: "app-a",
  },
  slack: {
    event_id: "event-a",
    channel_id: "channel-a",
    thread_ts: "thread-a",
    requester_id: "person-a",
  },
  actor: {
    principal_id: "principal-a",
    authenticated_subject_id: "person-a",
  },
  authorization: {
    project_ids: ["project-a"],
    capability_ids: ["company_authority_v1"],
  },
  placement: { deployment_id: "deployment-a", profile: "shared_cloud" },
} as unknown as TenantContextEnvelope;

const payload = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  eventId: "event-a",
  channelId: "channel-a",
  threadTs: "thread-a",
  messageTs: "thread-a",
  userId: "person-a",
  eventType: "message",
  text: "hello",
  receivedAt: "2026-09-02T00:00:00.000Z",
} satisfies SlackQueueEvent;

const canonicalResourceRef = await companyAuthoritySlackResourceRef("project-a", payload);

class MemoryBoundaryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
}

class IsolatedBoundaryNamespace implements TenantBoundaryContextNamespace {
  readonly handlers = new Map<string, TenantBoundaryContextHandler>();
  readonly validate = vi.fn(async (_input: {
    boundary: BoundaryName;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    now: string;
    company_authority_envelope?: unknown;
  }) => undefined);
  idFromName(name: string): string { return name; }
  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return { fetch: (request) => {
      let handler = this.handlers.get(key);
      if (!handler) {
        handler = new TenantBoundaryContextHandler(new MemoryBoundaryStorage(), this.validate);
        this.handlers.set(key, handler);
      }
      return handler.fetch(request);
    } };
  }
}

const context = {
  tenant_context: tenantContext,
  scope: {
    project_id: "project-a",
    resource_ref: canonicalResourceRef,
  },
  authority: {
    decision: "auto",
    capability_id: "company_read",
    allowed_effects: ["read"],
  },
} as unknown as AcceptedCompanyAuthorityContext;

const externalEffectContext = {
  ...context,
  authority: {
    decision: "auto",
    capability_id: "company_external_effect",
    allowed_effects: ["external_side_effect"],
  },
} as AcceptedCompanyAuthorityContext;

const request: ObservedExecutionRequestV1 = {
  provider_identity: {
    provider: "slack",
    authenticated_subject_id: "person-a",
    workspace_id: "workspace-a",
    app_id: "app-a",
  },
  requested_action: {
    capability_id: "company_read",
    resource_ref: canonicalResourceRef,
    project_hint: "project-a",
    desired_effect: "read",
  },
  delivery: {
    channel_id: "channel-a",
    thread_ts: "thread-a",
    event_id: "event-a",
  },
  correlation_id: "correlation-a",
};

const runtimeEnvelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent> = {
  schema_version: "1.0",
  correlation_id: request.correlation_id,
  company_authority_request: request,
  company_authority_response: { context },
  payload,
};

describe("company authority Queue production seam", () => {
  it("derives the nested tenant scope only when request, context, payload, and configured effect agree", async () => {
    await expect(resolveCompanyAuthoritySlackQueueScope({
      context,
      request,
      payload,
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_read: "read" },
    })).resolves.toEqual({
      audience: "mana-runtime",
      workspace_id: "workspace-a",
      app_id: "app-a",
      channel_id: "channel-a",
      thread_ts: "thread-a",
      actor_principal_id: "principal-a",
      project_id: "project-a",
      project_ids: ["project-a"],
      capability_id: "company_authority_v1",
      deployment_id: "deployment-a",
    });
  });

  it("accepts the producer-resolved project code alias for payload binding", async () => {
    const projectCode = "project-code-a";
    const resourceRef = await companyAuthoritySlackResourceRef(projectCode, payload);
    const aliasedRequest: ObservedExecutionRequestV1 = {
      ...request,
      requested_action: {
        ...request.requested_action,
        resource_ref: resourceRef,
        project_hint: projectCode,
      },
    };
    const aliasedContext = {
      ...context,
      scope: { ...context.scope, resource_ref: resourceRef },
    } as AcceptedCompanyAuthorityContext;

    await expect(resolveCompanyAuthoritySlackQueueScope({
      context: aliasedContext,
      request: aliasedRequest,
      payload,
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_read: "read" },
    })).resolves.toMatchObject({
      project_id: "project-a",
      project_ids: ["project-a"],
    });
  });

  it.each([
    ["unconfigured capability", { desired_effect_by_capability: {} }],
    ["effect mismatch", { desired_effect_by_capability: { company_read: "write" as const } }],
    ["payload event mismatch", { payload: { ...payload, eventId: "event-other" } }],
    ["request actor mismatch", {
      request: {
        ...request,
        provider_identity: { ...request.provider_identity, authenticated_subject_id: "person-other" },
      },
    }],
    ["multiple nested projects", {
      context: {
        ...context,
        tenant_context: {
          ...tenantContext,
          authorization: { ...tenantContext.authorization, project_ids: ["project-a", "project-b"] },
        },
      } as AcceptedCompanyAuthorityContext,
    }],
    ["outer and nested project mismatch", {
      context: {
        ...context,
        scope: { ...context.scope, project_id: "project-b" },
      } as AcceptedCompanyAuthorityContext,
    }],
  ])("fails closed for %s", async (_label, override) => {
    await expect(resolveCompanyAuthoritySlackQueueScope({
      context,
      request,
      payload,
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_read: "read" },
      ...override,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "queue_consumer",
      code: "AUTHORITY_SCOPE_MISMATCH",
    }));
  });

  it.each([
    ["resource reference", { resource_ref: "project:project-a#payload_sha256=invalid" }],
    ["project hint", { project_hint: "project-other" }],
  ])("rejects post-acceptance %s substitution", async (_label, change) => {
    await expect(resolveCompanyAuthoritySlackQueueScope({
      context,
      request: {
        ...request,
        requested_action: { ...request.requested_action, ...change },
      },
      payload,
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_read: "read" },
    })).rejects.toEqual(expect.objectContaining({
      boundary: "queue_consumer",
      code: "AUTHORITY_SCOPE_MISMATCH",
      details: { phase: "company_authority_payload_binding" },
    }));
  });

  it.each([
    ["message timestamp", { messageTs: "changed" }],
    ["event type", { eventType: "reaction_added" }],
    ["text", { text: "changed" }],
    ["files", { files: [{ id: "file-a", name: "changed.txt" }] }],
    ["thread context", { threadContext: "changed" }],
    ["attachment context", { attachmentContext: "changed" }],
  ])("rejects post-acceptance %s substitution", async (_label, change) => {
    await expect(resolveCompanyAuthoritySlackQueueScope({
      context,
      request,
      payload: { ...payload, ...change },
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_read: "read" },
    })).rejects.toEqual(expect.objectContaining({
      boundary: "queue_consumer",
      code: "AUTHORITY_SCOPE_MISMATCH",
      details: { phase: "company_authority_payload_binding" },
    }));
  });

  it("keeps every not-yet-connected decision route retryable without executing an effect", async () => {
    await expect(unavailableCompanyAuthorityQueueRoute("approval"))
      .rejects.toEqual(expect.objectContaining({
        details: { phase: "company_authority_approval_route_not_connected" },
      }));
    await expect(unavailableCompanyAuthorityQueueRoute("human_action"))
      .rejects.toEqual(expect.objectContaining({
        details: { phase: "company_authority_human_action_route_not_connected" },
      }));
  });

  it("routes an accepted auto external effect through an explicitly registered outbox provider", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const createOutbox = vi.fn(() => outbox);
    const providerSend = vi.fn(async () => ({
      applied: true as const,
      response_observed: true as const,
      result_ref: "provider:auto-route-a",
    }));
    const externalRequest: ObservedExecutionRequestV1 = {
      ...request,
      requested_action: {
        ...request.requested_action,
        capability_id: "company_external_effect",
        desired_effect: "external_side_effect",
      },
    };
    const externalEnvelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent> = {
      schema_version: "1.0",
      correlation_id: externalRequest.correlation_id,
      company_authority_request: externalRequest,
      company_authority_response: { context: externalEffectContext },
      payload,
    };

    await expect(processCompanyAuthorityAutoQueueRoute({
      context: externalEffectContext,
      request: externalRequest,
      payload,
      envelope: externalEnvelope,
      registry: {
        company_external_effect: {
          create_outbox: createOutbox,
          provider_send: providerSend,
        },
      },
    })).resolves.toMatchObject({ state: "succeeded", result_ref: "provider:auto-route-a" });
    expect(createOutbox).toHaveBeenCalledOnce();
    expect(createOutbox).toHaveBeenCalledWith(externalEffectContext);
    expect(providerSend).toHaveBeenCalledOnce();
    expect(providerSend).toHaveBeenCalledWith({
      provider_key: expect.stringMatching(/^sha256:/),
      context: externalEffectContext,
      request: externalRequest,
      envelope: externalEnvelope,
      payload,
    });
  });

  it("isolates the accepted snapshot from provider mutation", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const externalRequest: ObservedExecutionRequestV1 = {
      ...request,
      requested_action: {
        ...request.requested_action,
        capability_id: "company_external_effect",
        desired_effect: "external_side_effect",
      },
    };
    const externalEnvelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent> = {
      schema_version: "1.0",
      correlation_id: externalRequest.correlation_id,
      company_authority_request: externalRequest,
      company_authority_response: { context: externalEffectContext },
      payload,
    };
    const contextBefore = structuredClone(externalEffectContext);
    const requestBefore = structuredClone(externalRequest);
    const envelopeBefore = structuredClone(externalEnvelope);
    const providerSend = vi.fn(async (input: {
      context: AcceptedCompanyAuthorityContext;
      request: ObservedExecutionRequestV1;
      envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
      payload: SlackQueueEvent;
    }) => {
      (input.context.tenant_context as unknown as TenantContextEnvelope).slack.channel_id = "provider-mutated";
      if (!input.request.delivery) throw new Error("test_delivery_missing");
      input.request.delivery.channel_id = "provider-mutated";
      input.envelope.payload.text = "provider-mutated";
      return {
        applied: true as const,
        response_observed: true as const,
        result_ref: "provider:auto-route-isolated",
      };
    });
    await expect(processCompanyAuthorityAutoQueueRoute({
      context: externalEffectContext,
      request: externalRequest,
      envelope: externalEnvelope,
      payload,
      registry: {
        company_external_effect: {
          create_outbox: () => outbox,
          provider_send: providerSend,
        },
      },
    })).resolves.toMatchObject({ state: "succeeded" });

    expect(externalEffectContext).toEqual(contextBefore);
    expect(externalRequest).toEqual(requestBefore);
    expect(externalEnvelope).toEqual(envelopeBefore);
  });

  it("isolates outbox selection from the accepted context and provider identity", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const externalRequest: ObservedExecutionRequestV1 = {
      ...request,
      requested_action: {
        ...request.requested_action,
        capability_id: "company_external_effect",
        desired_effect: "external_side_effect",
      },
    };
    const externalEnvelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent> = {
      schema_version: "1.0",
      correlation_id: externalRequest.correlation_id,
      company_authority_request: externalRequest,
      company_authority_response: { context: externalEffectContext },
      payload,
    };
    const contextBefore = structuredClone(externalEffectContext);
    const createOutbox = vi.fn((received: AcceptedCompanyAuthorityContext) => {
      const mutable = received.tenant_context as unknown as {
        tenant: { tenant_id: string };
        idempotency_key: string;
      };
      mutable.tenant.tenant_id = "outbox-mutated";
      mutable.idempotency_key = "outbox-mutated";
      return outbox;
    });
    const providerSend = vi.fn(async () => ({
      applied: true as const,
      response_observed: true as const,
      result_ref: "provider:outbox-isolated",
    }));

    const record = await processCompanyAuthorityAutoQueueRoute({
      context: externalEffectContext,
      request: externalRequest,
      envelope: externalEnvelope,
      payload,
      registry: {
        company_external_effect: { create_outbox: createOutbox, provider_send: providerSend },
      },
    });

    expect(externalEffectContext).toEqual(contextBefore);
    expect(record).toMatchObject({
      tenant_id: "tenant-a",
      effect_id: "idem-auto-route-a",
      state: "succeeded",
    });
    expect(providerSend).toHaveBeenCalledWith(expect.objectContaining({
      context: contextBefore,
    }));
  });

  it("carries a selected accepted envelope into Container and revalidates outbound boundaries", async () => {
    const now = "2026-09-02T00:00:00.000Z";
    const namespace = new IsolatedBoundaryNamespace();
    const outbox = new ExternalEffectOutboxMemoryStore();
    const externalRequest: ObservedExecutionRequestV1 = {
      ...request,
      requested_action: {
        ...request.requested_action,
        capability_id: "company_external_effect",
        desired_effect: "external_side_effect",
      },
    };
    const externalEnvelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent> = {
      schema_version: "1.0",
      correlation_id: externalRequest.correlation_id,
      company_authority_request: externalRequest,
      company_authority_response: { context: externalEffectContext },
      payload,
    };
    const tenantVerifier = {
      validate: vi.fn(async () => undefined),
    } as unknown as TenantRuntimeBoundaryVerifier;
    const executeContainer = vi.fn(async (operation: {
      tenant_context: TenantContextEnvelope;
      expected_scope: ExpectedTenantScope;
      company_authority_envelope: CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>;
      payload: SlackQueueEvent;
    }) => executeTenantContainerOperation({
      namespace,
      tenant_context: operation.tenant_context,
      expected_scope: operation.expected_scope,
      verifier: tenantVerifier,
      company_authority_envelope: operation.company_authority_envelope,
      now,
      execute: async (handle) => {
        const requestFor = (tool: string) => new Request("https://runtime-gateway.internal/tools", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TENANT_BOUNDARY_HANDLE_HEADER]: handle,
          },
          body: JSON.stringify({ tool }),
        });
        const readRequest = requestFor("search_tasks");
        const readResolved = await resolveDurableTenantBoundaryContext(
          namespace, readRequest, await runtimeGatewayBoundaries(readRequest), now,
        );
        expect(readResolved).not.toBeInstanceOf(Response);
        const sendRequest = requestFor("send_message");
        const sendResolved = await resolveDurableTenantBoundaryContext(
          namespace, sendRequest, await runtimeGatewayBoundaries(sendRequest), now,
        );
        expect(sendResolved).toEqual(expect.objectContaining({
          company_authority_envelope: externalEnvelope,
        }));
        return {
          applied: true as const,
          response_observed: true as const,
          result_ref: "container:selected-operation-a",
        };
      },
    }));
    const route = createCompanyAuthoritySelectedContainerProviderRoute({
      create_outbox: () => outbox,
      expected_audience: "mana-runtime",
      desired_effect_by_capability: { company_external_effect: "external_side_effect" },
      execute_container: executeContainer,
    });

    await expect(processCompanyAuthorityAutoQueueRoute({
      context: externalEffectContext,
      request: externalRequest,
      envelope: externalEnvelope,
      payload,
      registry: { company_external_effect: route },
    })).resolves.toMatchObject({ state: "succeeded" });

    expect(executeContainer).toHaveBeenCalledOnce();
    expect(namespace.validate.mock.calls.map(([input]) => input.boundary)).toEqual([
      "container_launch",
      "mcp_gateway",
      "brainbase_proxy",
      "mcp_gateway",
      "brainbase_proxy",
      "slack_delivery",
    ]);
    for (const [input] of namespace.validate.mock.calls) {
      expect(input.company_authority_envelope).toEqual(externalEnvelope);
    }
    expect(tenantVerifier.validate).toHaveBeenCalledWith(expect.objectContaining({
      boundary: "container_launch",
    }));
  });

  it.each(["unregistered_external_effect", "__proto__"])(
    "fails retryably for unregistered auto capability %s before any provider effect",
    async (capabilityId) => {
    await expect(processCompanyAuthorityAutoQueueRoute({
      context: {
        ...externalEffectContext,
        authority: { ...externalEffectContext.authority, capability_id: capabilityId },
      } as AcceptedCompanyAuthorityContext,
      request: {
        ...request,
        requested_action: {
          ...request.requested_action,
          capability_id: capabilityId,
          desired_effect: "external_side_effect",
        },
      },
      envelope: runtimeEnvelope,
      payload,
      registry: {},
    })).rejects.toEqual(expect.objectContaining({
      boundary: "queue_consumer",
      code: "UPSTREAM_UNAVAILABLE",
      details: {
        phase: "company_authority_auto_provider_route_not_connected",
        capability_id: capabilityId,
      },
    }));
    },
  );

  it.each(["approval", "human_action"] as const)(
    "never sends a %s decision through the auto provider route",
    async (decision) => {
      const createOutbox = vi.fn(() => new ExternalEffectOutboxMemoryStore());
      const providerSend = vi.fn();
      await expect(processCompanyAuthorityAutoQueueRoute({
        context: {
          ...externalEffectContext,
          authority: { ...externalEffectContext.authority, decision },
        } as AcceptedCompanyAuthorityContext,
        request: {
          ...request,
          requested_action: {
            ...request.requested_action,
            capability_id: "company_external_effect",
            desired_effect: "external_side_effect",
          },
        },
        envelope: runtimeEnvelope,
        payload,
        registry: {
          company_external_effect: { create_outbox: createOutbox, provider_send: providerSend },
        },
      })).rejects.toEqual(expect.objectContaining({
        code: "AUTHORITY_SCOPE_MISMATCH",
        details: { phase: "company_authority_non_auto_provider_route_forbidden" },
      }));
      expect(createOutbox).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
    },
  );

  it.each(["read", "write"] as const)(
    "rejects a registered capability whose desired effect is %s",
    async (desiredEffect) => {
      const createOutbox = vi.fn(() => new ExternalEffectOutboxMemoryStore());
      const providerSend = vi.fn();
      await expect(processCompanyAuthorityAutoQueueRoute({
        context: externalEffectContext,
        request: {
          ...request,
          requested_action: {
            ...request.requested_action,
            capability_id: "company_external_effect",
            desired_effect: desiredEffect,
          },
        },
        envelope: runtimeEnvelope,
        payload,
        registry: {
          company_external_effect: { create_outbox: createOutbox, provider_send: providerSend },
        },
      })).rejects.toEqual(expect.objectContaining({
        code: "AUTHORITY_SCOPE_MISMATCH",
        details: { phase: "company_authority_provider_effect_mismatch" },
      }));
      expect(createOutbox).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
    },
  );

  it("rejects an accepted authority capability that differs from the provider request", async () => {
    const createOutbox = vi.fn(() => new ExternalEffectOutboxMemoryStore());
    const providerSend = vi.fn();
    await expect(processCompanyAuthorityAutoQueueRoute({
      context: {
        ...externalEffectContext,
        authority: {
          ...externalEffectContext.authority,
          capability_id: "different_external_effect",
        },
      } as AcceptedCompanyAuthorityContext,
      request: {
        ...request,
        requested_action: {
          ...request.requested_action,
          capability_id: "company_external_effect",
          desired_effect: "external_side_effect",
        },
      },
      envelope: runtimeEnvelope,
      payload,
      registry: {
        company_external_effect: { create_outbox: createOutbox, provider_send: providerSend },
      },
    })).rejects.toEqual(expect.objectContaining({
      code: "AUTHORITY_SCOPE_MISMATCH",
      details: { phase: "company_authority_provider_capability_mismatch" },
    }));
    expect(createOutbox).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });

  it("rejects an accepted authority that does not allow the external side effect", async () => {
    const createOutbox = vi.fn(() => new ExternalEffectOutboxMemoryStore());
    const providerSend = vi.fn();
    await expect(processCompanyAuthorityAutoQueueRoute({
      context: {
        ...externalEffectContext,
        authority: {
          ...externalEffectContext.authority,
          allowed_effects: ["read"],
        },
      } as AcceptedCompanyAuthorityContext,
      request: {
        ...request,
        requested_action: {
          ...request.requested_action,
          capability_id: "company_external_effect",
          desired_effect: "external_side_effect",
        },
      },
      envelope: runtimeEnvelope,
      payload,
      registry: {
        company_external_effect: { create_outbox: createOutbox, provider_send: providerSend },
      },
    })).rejects.toEqual(expect.objectContaining({
      code: "AUTHORITY_SCOPE_MISMATCH",
      details: { phase: "company_authority_provider_effect_not_allowed" },
    }));
    expect(createOutbox).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });
});
