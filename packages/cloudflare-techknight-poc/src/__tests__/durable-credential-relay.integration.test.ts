import { describe, expect, it, vi } from "vitest";

import {
  createDurableTenantCredentialRegistry,
  forwardTenantCredentialRequest,
  TenantCredentialRelayHandler,
} from "../multitenancy/durable-credential-relay.js";
import { credentialLeaseMarker } from "../multitenancy/credential-injector.js";
import type { CredentialLease, CredentialLeaseBinding } from "../multitenancy/contracts.js";

const NOW = "2026-08-17T01:00:00.000Z";
const BINDING: CredentialLeaseBinding = {
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  contract_revision: "11",
  operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  audience: "api.anthropic.com",
  credential_mode: "customer_oauth",
  credential_ref: "opaque-credential-ref-a",
};

function lease(): CredentialLease {
  return {
    message_type: "credential_lease_response",
    protocol_version: "1.0",
    lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0",
    contract_revision: "11",
    binding: BINDING,
    issued_at: "2026-08-17T00:59:50.000Z",
    expires_at: "2026-08-17T01:00:50.000Z",
    max_uses: 1,
    lease_token: "fixture-secret-never-persist",
  };
}

class IsolatedCredentialNamespace {
  readonly handlers = new Map<string, TenantCredentialRelayHandler>();
  readonly claimedLeaseIds = new Set<string>();
  readonly providerFetch = vi.fn(async (request: Request) => Response.json({
    authorization: request.headers.get("authorization"),
    relayHeader: request.headers.get("x-mana-credential-target-url"),
  }));

  idFromName(name: string): string { return name; }

  private handler(): TenantCredentialRelayHandler {
    return new TenantCredentialRelayHandler(this.providerFetch as unknown as typeof fetch, {
      claim: async (leaseId) => {
        if (this.claimedLeaseIds.has(leaseId)) return false;
        this.claimedLeaseIds.add(leaseId);
        return true;
      },
    });
  }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return {
      fetch: (request) => {
        let handler = this.handlers.get(key);
        if (!handler) {
          handler = this.handler();
          this.handlers.set(key, handler);
        }
        return handler.fetch(request);
      },
    };
  }

  restart(handle: string): void {
    this.handlers.set(`credential:${handle}`, this.handler());
  }
}

describe("durable credential relay integration", () => {
  it("hands an opaque handle across isolates and injects the credential at provider outbound once", async () => {
    const namespace = new IsolatedCredentialNamespace();
    const registry = createDurableTenantCredentialRegistry(namespace);
    const handle = await registry.register({
      lease: lease(),
      expected_binding: BINDING,
      now: NOW,
      allowed_hostname: "api.anthropic.com",
    });

    expect(handle).not.toContain("fixture-secret-never-persist");
    expect(handle).not.toContain(BINDING.credential_ref);
    const request = () => new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${credentialLeaseMarker(handle)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model" }),
    });
    const first = await forwardTenantCredentialRequest(namespace, request(), NOW);
    await expect(first.json()).resolves.toEqual({
      authorization: "Bearer fixture-secret-never-persist",
      relayHeader: null,
    });
    const duplicate = await forwardTenantCredentialRequest(namespace, request(), NOW);
    expect(duplicate.status).toBe(503);
    expect(await duplicate.text()).toBe("credential_lease_rejected");
    expect(namespace.providerFetch).toHaveBeenCalledOnce();
  });

  it("fails closed after a relay isolate restart instead of reacquiring or persisting the secret", async () => {
    const namespace = new IsolatedCredentialNamespace();
    const registry = createDurableTenantCredentialRegistry(namespace);
    const handle = await registry.register({ lease: lease(), expected_binding: BINDING, now: NOW });
    namespace.restart(handle);

    const response = await forwardTenantCredentialRequest(namespace, new Request(
      "https://api.anthropic.com/v1/messages",
      { headers: { authorization: `Bearer ${credentialLeaseMarker(handle)}` } },
    ), NOW);
    expect(response.status).toBe(503);
    expect(namespace.providerFetch).not.toHaveBeenCalled();
  });

  it("owns max_uses=1 by canonical lease_id across a relay restart", async () => {
    const namespace = new IsolatedCredentialNamespace();
    const registry = createDurableTenantCredentialRegistry(namespace);
    const firstHandle = await registry.register({ lease: lease(), expected_binding: BINDING, now: NOW });
    namespace.restart(firstHandle);
    await expect(registry.register({ lease: lease(), expected_binding: BINDING, now: NOW }))
      .rejects.toMatchObject({ code: "FALLBACK_FORBIDDEN" });
    expect(namespace.providerFetch).not.toHaveBeenCalled();
  });

  it("actively scrubs an unused secret after TTL plus clock skew", async () => {
    vi.useFakeTimers();
    try {
      const namespace = new IsolatedCredentialNamespace();
      const registry = createDurableTenantCredentialRegistry(namespace);
      const handle = await registry.register({ lease: lease(), expected_binding: BINDING, now: NOW });
      const handler = namespace.handlers.get(`credential:${handle}`)!;
      expect(handler.activeCredentialCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(80_001);
      expect(handler.activeCredentialCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
