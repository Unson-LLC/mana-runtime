import { describe, expect, it, vi } from "vitest";
import { createSlackInstallationControlPlaneClient } from "../multitenancy/slack-installation-control-plane-client.js";

const binding = {
  installation_intent_id: "insi_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  app_id: "A-MANA",
  expected_workspace_id: "T-A",
  initiated_by_person_id: "per_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
} as const;

const snapshot = {
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "1",
  tenant_id: binding.tenant_id,
  installation_id: "I-A",
  workspace_id: "T-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["chat:write"],
  status: "active" as const,
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud" as const,
  credential_mode: "customer_oauth" as const,
  contract_revision: "11",
};

describe("Slack installation control-plane Service Binding", () => {
  it("uses only Fetcher.fetch with fixed paths and forwards only authorization", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(init?.redirect).toBe("manual");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-arbitrary")).toBeNull();
      if (new URL(request.url).pathname.endsWith(":authorize")) {
        expect(request.headers.get("authorization")).toBe("Bearer tenant-admin");
        expect(await request.json()).toEqual({ app_id: "A-MANA" });
        return Response.json({ result: binding });
      }
      expect(request.headers.get("authorization")).toBeNull();
      expect(await request.json()).toEqual({
        authorization_code: "opaque-code",
        redirect_uri: "https://mana.invalid/slack/installations/oauth/callback",
        intent: binding,
      });
      return Response.json({ result: snapshot });
    });
    const client = createSlackInstallationControlPlaneClient({ fetch }, "A-MANA");

    await expect(client.authorize(new Request("https://mana.invalid/start", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-admin",
        cookie: "must-not-cross=1",
        "x-arbitrary": "must-not-cross",
      },
    }))).resolves.toEqual(binding);
    await expect(client.exchange_and_register({
      authorization_code: "opaque-code",
      redirect_uri: "https://mana.invalid/slack/installations/oauth/callback",
      intent: binding,
    })).resolves.toEqual(snapshot);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/api/v1/slack-installations:authorize",
      "/api/v1/slack-installations:exchange-and-register",
    ]);
  });

  it("fails closed without admin authorization and does not call the binding", async () => {
    const fetch = vi.fn();
    const client = createSlackInstallationControlPlaneClient({ fetch }, "A-MANA");

    await expect(client.authorize(new Request("https://mana.invalid/start", { method: "POST" })))
      .rejects.toThrow("INSTALLATION_AUTHORIZATION_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose upstream bodies or accept unbounded responses", async () => {
    const secret = "upstream-secret-must-not-escape";
    const client = createSlackInstallationControlPlaneClient({
      fetch: vi.fn(async () => new Response(secret.repeat(10_000), { status: 500 })),
    }, "A-MANA");

    const rejection = client.exchange_and_register({
      authorization_code: "opaque-code",
      redirect_uri: "https://mana.invalid/slack/installations/oauth/callback",
      intent: binding,
    });
    await expect(rejection).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    await expect(rejection).rejects.not.toThrow(secret);
  });
});
