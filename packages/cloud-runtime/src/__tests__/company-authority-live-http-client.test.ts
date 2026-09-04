import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  createTenantRuntimeHttpClients,
  type TenantRuntimeServiceBinding,
} from "../multitenancy/http-clients.js";
import {
  executeCompanyAuthorityWorkerIngress,
  type ObservedExecutionRequestV1,
} from "../multitenancy/company-authority-runtime-adapter.js";

const request: ObservedExecutionRequestV1 = {
  provider_identity: {
    provider: "slack",
    authenticated_subject_id: "U-UMEDA",
    workspace_id: "T-UNSON",
    app_id: "A-MANA",
  },
  requested_action: {
    capability_id: "task.write",
    resource_ref: "project:brainbase",
    project_hint: "brainbase",
    desired_effect: "write",
  },
  delivery: {
    channel_id: "C-BACKOFFICE",
    thread_ts: "1723800000.000001",
    event_id: "Ev-company-authority-1",
  },
  correlation_id: "cor-company-authority-1",
};

function clients(service: TenantRuntimeServiceBinding, timeout_ms = 1_000) {
  return createTenantRuntimeHttpClients({
    deployment_profile: "shared_cloud",
    service,
    timeout_ms,
  });
}

describe("Brainbase company authority HTTP client", () => {
  it("round-trips the observed request over the private Service Binding", async () => {
    const response = { context: { signed: "opaque-company-authority-context" } };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json(response, { status: 200 })
    ));
    const runtime = clients({ fetch });

    await expect(runtime.company_authority.resolve(request)).resolves.toEqual({
      state: "resolved",
      response,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      "https://brainbase.internal/api/v1/runtime/company-authority:resolve",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(new Headers(init?.headers).get("x-service-token")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it("passes a signed producer fixture from the HTTP client into adapter verification", async () => {
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
    const fixture = fixtures.positive.find(({ context }) => context?.authority?.decision === "auto");
    if (!fixture) throw new Error("signed auto fixture is required");

    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(fixture.request);
      return Response.json({
        schema_version: "1.0",
        contract_id: "mana-brainbase-company-authority/v1",
        correlation_id: fixture.request.correlation_id,
        context: fixture.context,
        error: null,
      });
    });
    const runtime = clients({ fetch });
    const businessEffect = vi.fn(async () => "executed");
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
      client: runtime.company_authority,
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

    expect(accepted.context).toEqual(fixture.context);
    expect(accepted.decision).toBe("auto");
    expect(accepted.result).toBe("executed");
    expect(businessEffect).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a tampered signed fixture before invoking the business effect", async () => {
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
    const fixture = fixtures.positive.find(({ context }) => context?.authority?.decision === "auto");
    if (!fixture) throw new Error("signed auto fixture is required");
    const tamperedContext = structuredClone(fixture.context);
    tamperedContext.integrity.value = "tampered";

    const fetch = vi.fn(async () => Response.json({
      schema_version: "1.0",
      contract_id: "mana-brainbase-company-authority/v1",
      correlation_id: fixture.request.correlation_id,
      context: tamperedContext,
      error: null,
    }));
    const runtime = clients({ fetch });
    const businessEffect = vi.fn(async () => "must-not-run");

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
      client: runtime.company_authority,
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
    })).rejects.toMatchObject({
      code: "AUTHORITY_CONTEXT_INVALID_SIGNATURE",
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(businessEffect).not.toHaveBeenCalled();
  });

  it("does not turn invalid JSON into a resolved authority response", async () => {
    const fetch = vi.fn(async () => new Response("{not-json", { status: 200 }));
    const runtime = clients({ fetch });

    await expect(runtime.company_authority.resolve(request)).resolves.toEqual({
      state: "not_collected",
    });
  });

  it("fails closed for an upstream HTTP error", async () => {
    const fetch = vi.fn(async () => Response.json({
      code: "AUTHORITY_UNAVAILABLE",
      retryable: true,
    }, { status: 503 }));
    const runtime = clients({ fetch });

    await expect(runtime.company_authority.resolve(request)).rejects.toMatchObject({
      boundary: "company_authority",
      code: "AUTHORITY_UNAVAILABLE",
      details: expect.objectContaining({ status: 503, retryable: true }),
    });
  });

  it("does not follow a redirect returned by the private Service Binding", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response(null, {
        status: 302,
        headers: { location: "https://unexpected.example/authority" },
      });
    });
    const runtime = clients({ fetch });

    await expect(runtime.company_authority.resolve(request)).rejects.toMatchObject({
      boundary: "company_authority",
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(redirects).toEqual(["manual"]);
  });

  it("fails closed when the Service Binding is unavailable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("private service unavailable");
    });
    const runtime = clients({ fetch });

    await expect(runtime.company_authority.resolve(request)).rejects.toMatchObject({
      boundary: "company_authority",
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("passes the configured timeout signal and fails closed on timeout", async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error("missing timeout signal"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const runtime = clients({ fetch }, 5);

    await expect(runtime.company_authority.resolve(request)).rejects.toMatchObject({
      boundary: "company_authority",
      code: "UPSTREAM_UNAVAILABLE",
      details: expect.objectContaining({ phase: "fetch", path: "/company-authority:resolve" }),
    });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });
});
