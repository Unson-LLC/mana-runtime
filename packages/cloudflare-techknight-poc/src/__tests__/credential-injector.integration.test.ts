import { describe, expect, it } from "vitest";

import {
  TenantCredentialInjector,
  credentialLeaseMarker,
  type CredentialLease,
  type CredentialLeaseBinding,
} from "../multitenancy/index.js";

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

function lease(overrides: Partial<CredentialLease> = {}): CredentialLease {
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
    ...overrides,
  };
}

describe("tenant credential Container outbound integration", () => {
  it("passes only an opaque operation-bound handle and injects the secret at outbound", async () => {
    const injector = new TenantCredentialInjector();
    const handle = await injector.register({ lease: lease(), expected_binding: BINDING, now: NOW });
    const marker = credentialLeaseMarker(handle);

    expect(marker).not.toContain("fixture-secret-never-persist");
    expect(marker).not.toContain(BINDING.credential_ref);
    expect(marker).not.toContain("lease_01ARZ3NDEKTSV4RRFFQ69G5FB0");

    const headers = injector.inject({
      hostname: "api.anthropic.com",
      headers: new Headers({ authorization: `Bearer ${marker}` }),
      now: NOW,
    });
    expect(headers.get("authorization")).toBe("Bearer fixture-secret-never-persist");
    expect(headers.has("x-api-key")).toBe(false);

    injector.dispose(handle);
    expect(() => injector.inject({
      hostname: "api.anthropic.com",
      headers: new Headers({ authorization: `Bearer ${marker}` }),
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "CREDENTIAL_LEASE_INVALID" }));
  });

  it("enforces max_uses=1 and never falls back for an invalid or expired handle", async () => {
    const injector = new TenantCredentialInjector();
    const value = lease();
    await injector.register({ lease: value, expected_binding: BINDING, now: NOW });
    await expect(injector.register({ lease: value, expected_binding: BINDING, now: NOW }))
      .rejects.toMatchObject({ code: "FALLBACK_FORBIDDEN" });

    expect(() => injector.inject({
      hostname: "api.anthropic.com",
      headers: new Headers({ authorization: "Bearer mana-credential-lease-v1:missing" }),
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "CREDENTIAL_LEASE_INVALID" }));

    const expiring = new TenantCredentialInjector();
    const handle = await expiring.register({ lease: lease(), expected_binding: BINDING, now: NOW });
    expect(() => expiring.inject({
      hostname: "api.anthropic.com",
      headers: new Headers({ authorization: `Bearer ${credentialLeaseMarker(handle)}` }),
      now: "2026-08-17T01:01:21.000Z",
    })).toThrow(expect.objectContaining({ code: "WORKSPACE_CONNECTION_REVOKED" }));
  });

  it("rejects revision/binding changes and maps customer API credentials to x-api-key", async () => {
    const invalid = new TenantCredentialInjector();
    await expect(invalid.register({
      lease: lease(),
      expected_binding: { ...BINDING, connection_revision: "8" },
      now: NOW,
    })).rejects.toMatchObject({ code: "CREDENTIAL_LEASE_BINDING_MISMATCH" });

    const injector = new TenantCredentialInjector();
    const apiBinding = { ...BINDING, credential_mode: "customer_api" as const };
    const handle = await injector.register({
      lease: lease({
        lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB1",
        binding: apiBinding,
      }),
      expected_binding: apiBinding,
      now: NOW,
    });
    const headers = injector.inject({
      hostname: "api.anthropic.com",
      headers: new Headers({ authorization: `Bearer ${credentialLeaseMarker(handle)}` }),
      now: NOW,
    });
    expect(headers.get("x-api-key")).toBe("fixture-secret-never-persist");
    expect(headers.has("authorization")).toBe(false);
  });
});
