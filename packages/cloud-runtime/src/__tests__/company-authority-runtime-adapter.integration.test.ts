import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createObservedExecutionRequest,
  executeCompanyAuthorityWorkerIngress,
  resolveCompanyAuthorityWorkerIngress,
  type CompanyAuthorityClient,
} from "../multitenancy/company-authority-runtime-adapter.js";

describe("company authority runtime adapter foundation after explicit opt-in", () => {
  const observation = {
    provider: "slack" as const,
    authentication: {
      status: "verified" as const,
      scheme: "slack_signature_v0" as const,
    },
    authenticated_subject_id: "U123",
    workspace_id: "T123",
    app_id: "A123",
    capability_id: "task.read",
    resource_ref: "project:project-1",
    project_hint: "project-1",
    channel_id: "C123",
    event_id: "Ev123",
    correlation_id: "cor_01J00000000000000000000000",
  };

  it("normalizes an internal transport code and fails closed after explicit opt-in", async () => {
    const businessEffect = vi.fn();
    const legacyFallback = vi.fn(async (): Promise<never> => {
      throw new Error("legacy fallback must not run");
    });
    const client: CompanyAuthorityClient = {
      async resolve() {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
    };

    await expect(executeCompanyAuthorityWorkerIngress({
      observation,
      desired_effect_by_capability: {
        "task.read": "read",
      },
      client,
      acceptance: {
        expected_audience: "mana-runtime",
        expected_deployment_id: "dep_test",
        now: "2026-09-02T00:00:00Z",
        public_jwk: {},
      },
      execute_auto: businessEffect,
      legacy_authorization_fallback: legacyFallback,
    })).rejects.toEqual(expect.objectContaining({
      boundary: "worker_ingress",
      code: "AUTHORITY_UNAVAILABLE",
      details: expect.objectContaining({ phase: "company_authority_transport" }),
    }));

    expect(businessEffect).not.toHaveBeenCalled();
    expect(legacyFallback).not.toHaveBeenCalled();
  });

  it.each(["no_data", "unknown", "partial", "not_collected"] as const)(
    "treats %s authority retrieval as unavailable without calling business effects",
    async (state) => {
      const businessEffect = vi.fn();
      const legacyFallback = vi.fn(async (): Promise<never> => {
        throw new Error("legacy fallback must not run");
      });
      await expect(executeCompanyAuthorityWorkerIngress({
        observation,
        desired_effect_by_capability: { "task.read": "read" },
        client: { resolve: async () => ({ state }) },
        acceptance: {
          expected_audience: "mana-runtime",
          expected_deployment_id: "dep_test",
          now: "2026-09-02T00:00:00Z",
          public_jwk: {},
        },
        execute_auto: businessEffect,
        legacy_authorization_fallback: legacyFallback,
      })).rejects.toEqual(expect.objectContaining({
        code: "AUTHORITY_UNAVAILABLE",
        details: expect.objectContaining({ retrieval_state: state }),
      }));
      expect(businessEffect).not.toHaveBeenCalled();
      expect(legacyFallback).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, {}, { state: "resolved" }, { state: "unexpected" }])(
    "maps a malformed authority resolution %j to stable unavailable",
    async (malformed) => {
      await expect(resolveCompanyAuthorityWorkerIngress({
        observation,
        desired_effect_by_capability: { "task.read": "read" },
        client: { resolve: async () => malformed as never },
        acceptance: {
          expected_audience: "mana-runtime",
          expected_deployment_id: "dep_test",
          now: "2026-09-02T00:00:00Z",
          public_jwk: {},
        },
      })).rejects.toEqual(expect.objectContaining({
        code: "AUTHORITY_UNAVAILABLE",
        details: expect.objectContaining({ retrieval_state: "invalid" }),
      }));
    },
  );

  it("rejects observations without verified Slack provenance", () => {
    expect(() => createObservedExecutionRequest({
      ...observation,
      provider: "service" as never,
    }, { "task.read": "read" })).toThrow(expect.objectContaining({
      code: "PROVIDER_NOT_IMPLEMENTED",
    }));
    expect(() => createObservedExecutionRequest({
      ...observation,
      authentication: { ...observation.authentication, status: "unverified" as never },
    }, { "task.read": "read" })).toThrow(expect.objectContaining({
      code: "PROVIDER_NOT_IMPLEMENTED",
    }));
  });

  it("does not default an unknown capability to read", () => {
    expect(() => createObservedExecutionRequest({
      provider: "slack",
      authentication: { status: "verified", scheme: "slack_signature_v0" },
      authenticated_subject_id: "U123",
      capability_id: "unknown.capability",
      resource_ref: "project:project-1",
      correlation_id: "cor_01J00000000000000000000000",
    }, {})).toThrow(expect.objectContaining({
      boundary: "worker_ingress",
      code: "DESIRED_EFFECT_REQUIRED",
    }));
  });

  it.each(["read", "write"] as const)(
    "rejects runtime.execute when the canonical map classifies it as %s",
    (effect) => {
      expect(() => createObservedExecutionRequest({
        ...observation,
        capability_id: "runtime.execute",
      }, { "runtime.execute": effect })).toThrow(expect.objectContaining({
        boundary: "worker_ingress",
        code: "DESIRED_EFFECT_REQUIRED",
      }));
    },
  );

  it("maps only Slack observations and preserves accepted signed decisions unchanged", async () => {
    const contractRoot = new URL(
      "../../../../contracts/mana-brainbase-company-authority/v1/",
      import.meta.url,
    );
    const fixtures = JSON.parse(await readFile(new URL("fixtures/cases.json", contractRoot), "utf8")) as {
      positive: Array<Record<string, any>>;
    };
    const contract = JSON.parse(await readFile(new URL("producer.contract.json", contractRoot), "utf8")) as {
      signature: { audience: string };
    };
    const key = JSON.parse(await readFile(new URL("fixtures/test-key.json", contractRoot), "utf8")) as {
      key_id: string;
      public_jwk: JsonWebKey;
    };
    for (const decision of ["auto", "approval", "human_action"] as const) {
      const fixture = fixtures.positive.find(({ context }) => context?.authority?.decision === decision)!;
      const resolve = vi.fn(async () => ({
        state: "resolved" as const,
        response: {
          schema_version: "1.0",
          contract_id: "mana-brainbase-company-authority/v1",
          correlation_id: fixture.request.correlation_id,
          context: fixture.context,
          error: null,
        },
      }));

      const businessEffect = vi.fn(async () => `${decision}-executed`);
      const accepted = await executeCompanyAuthorityWorkerIngress({
        observation: {
          provider: "slack",
          authentication: { status: "verified", scheme: "slack_signature_v0" },
          authenticated_subject_id: fixture.request.provider_identity.authenticated_subject_id,
          workspace_id: fixture.request.provider_identity.workspace_id,
          app_id: fixture.request.provider_identity.app_id,
          enterprise_id: fixture.request.provider_identity.enterprise_id,
          capability_id: fixture.request.requested_action.capability_id,
          resource_ref: fixture.request.requested_action.resource_ref,
          project_hint: fixture.request.requested_action.project_hint,
          channel_id: fixture.request.delivery.channel_id,
          thread_ts: fixture.request.delivery.thread_ts,
          event_id: fixture.request.delivery.event_id,
          correlation_id: fixture.request.correlation_id,
        },
        desired_effect_by_capability: {
          [fixture.request.requested_action.capability_id]: fixture.request.requested_action.desired_effect,
        },
        client: { resolve },
        acceptance: {
          expected_audience: contract.signature.audience,
          expected_deployment_id: fixture.context.tenant_context.placement.deployment_id,
          now: fixture.evaluation_time,
          public_jwk: key.public_jwk,
          tenant_context_public_jwk: key.public_jwk,
          tenant_context_key_id: key.key_id,
        },
        execute_auto: businessEffect,
        legacy_authorization_fallback: vi.fn(async (): Promise<never> => {
          throw new Error("legacy fallback must not run");
        }),
      });

      expect(resolve, decision).toHaveBeenCalledWith(fixture.request);
      expect(accepted.context, decision).toEqual(fixture.context);
      expect(accepted.decision).toBe(decision);
      expect(businessEffect).toHaveBeenCalledTimes(decision === "auto" ? 1 : 0);
      expect(accepted.result).toBe(decision === "auto" ? "auto-executed" : undefined);
    }
  });

  it("rejects deny and deployment mismatch before any business or legacy effect", async () => {
    const contractRoot = new URL(
      "../../../../contracts/mana-brainbase-company-authority/v1/",
      import.meta.url,
    );
    const fixtures = JSON.parse(await readFile(new URL("fixtures/cases.json", contractRoot), "utf8")) as {
      positive: Array<Record<string, any>>;
    };
    const contract = JSON.parse(await readFile(new URL("producer.contract.json", contractRoot), "utf8")) as {
      signature: { audience: string };
    };
    const key = JSON.parse(await readFile(new URL("fixtures/test-key.json", contractRoot), "utf8")) as {
      key_id: string;
      public_jwk: JsonWebKey;
    };
    for (const expected of ["deny", "deployment_mismatch"] as const) {
      const fixture = expected === "deny"
        ? fixtures.positive.find(({ context }) => context?.authority?.decision === "deny")!
        : fixtures.positive.find(({ context }) => context?.authority?.decision === "auto")!;
      const businessEffect = vi.fn();
      const legacyFallback = vi.fn(async (): Promise<never> => {
        throw new Error("legacy fallback must not run");
      });
      await expect(executeCompanyAuthorityWorkerIngress({
        observation: {
          provider: "slack",
          authentication: { status: "verified", scheme: "slack_signature_v0" },
          authenticated_subject_id: fixture.request.provider_identity.authenticated_subject_id,
          workspace_id: fixture.request.provider_identity.workspace_id,
          app_id: fixture.request.provider_identity.app_id,
          enterprise_id: fixture.request.provider_identity.enterprise_id,
          capability_id: fixture.request.requested_action.capability_id,
          resource_ref: fixture.request.requested_action.resource_ref,
          project_hint: fixture.request.requested_action.project_hint,
          channel_id: fixture.request.delivery.channel_id,
          thread_ts: fixture.request.delivery.thread_ts,
          event_id: fixture.request.delivery.event_id,
          correlation_id: fixture.request.correlation_id,
        },
        desired_effect_by_capability: {
          [fixture.request.requested_action.capability_id]: fixture.request.requested_action.desired_effect,
        },
        client: { resolve: async () => ({
          state: "resolved",
          response: {
            schema_version: "1.0",
            contract_id: "mana-brainbase-company-authority/v1",
            correlation_id: fixture.request.correlation_id,
            context: fixture.context,
            error: null,
          },
        }) },
        acceptance: {
          expected_audience: contract.signature.audience,
          expected_deployment_id: expected === "deny"
            ? fixture.context.tenant_context.placement.deployment_id
            : "dep_wrong",
          now: fixture.evaluation_time,
          public_jwk: key.public_jwk,
          tenant_context_public_jwk: key.public_jwk,
          tenant_context_key_id: key.key_id,
        },
        execute_auto: businessEffect,
        legacy_authorization_fallback: legacyFallback,
      })).rejects.toEqual(expect.objectContaining({
        code: expected === "deny" ? "COMPANY_AUTHORITY_DENIED" : "AUTHORITY_SCOPE_MISMATCH",
      }));
      expect(businessEffect).not.toHaveBeenCalled();
      expect(legacyFallback).not.toHaveBeenCalled();
    }
  });
});
