import { describe, expect, it, vi } from "vitest";
import { createTenantRuntimeHttpClients } from "../multitenancy/http-clients.js";
import { handleSlackInstallationLifecycleRequest } from "../multitenancy/slack-installation-entrypoint.js";
import { SlackInstallationAdapter } from "../multitenancy/workspace-connection.js";

const snapshot = {
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "1",
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  installation_id: "I-A",
  workspace_id: "T-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active" as const,
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud" as const,
  credential_mode: "customer_oauth" as const,
  contract_revision: "11",
};

const bindings = {
  deployment_profile: "shared_cloud" as const,
  service: { fetch: vi.fn(async () => new Response("not-called", { status: 503 })) },
  workspace_connections: [{ ...snapshot, tenant_revision: "1" }],
  timeout_ms: 25,
};

function lifecycleRequest(body: unknown, token = "lifecycle-token"): Request {
  return new Request("https://worker.invalid/internal/slack/installations/lifecycle", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Slack installation lifecycle production entrypoint", () => {
  it("does not accept a public OAuth callback through the internal lifecycle endpoint", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ result: snapshot });
    });
    const clients = createTenantRuntimeHttpClients({ ...bindings, service: { fetch: fetchMock } });
    const response = await handleSlackInstallationLifecycleRequest(lifecycleRequest({
      kind: "oauth_callback",
      expected_revision: "0",
      app_id: "A-MANA",
      workspace_id: "T-A",
      installation_id: "I-A",
      installer_id: "U-INSTALLER",
      granted_scopes: ["app_mentions:read", "chat:write"],
      authorization_code_ref: "oauth_exchange_opaque_01",
    }), {
      token: "lifecycle-token",
      adapter: new SlackInstallationAdapter(clients.workspace_connections),
    });

    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain("access_token");
    expect(JSON.stringify(requests)).not.toContain("refresh_token");
  });

  it("rejects unauthenticated, additional-property, and secret-bearing requests", async () => {
    const apply = vi.fn();
    const adapter = { apply };
    const event = {
      kind: "tokens_revoked",
      connection_id: snapshot.connection_id,
      expected_revision: "1",
    };
    await expect(handleSlackInstallationLifecycleRequest(lifecycleRequest(event, "wrong"), {
      token: "lifecycle-token", adapter,
    })).resolves.toMatchObject({ status: 401 });
    await expect(handleSlackInstallationLifecycleRequest(lifecycleRequest({ ...event, tenant_id: snapshot.tenant_id }), {
      token: "lifecycle-token", adapter,
    })).resolves.toMatchObject({ status: 400 });
    await expect(handleSlackInstallationLifecycleRequest(lifecycleRequest({ ...event, access_token: "never-store" }), {
      token: "lifecycle-token", adapter,
    })).resolves.toMatchObject({ status: 400 });
    expect(apply).not.toHaveBeenCalled();
  });

  it("fails closed when the lifecycle endpoint is not configured", async () => {
    const response = await handleSlackInstallationLifecycleRequest(lifecycleRequest({
      kind: "tokens_revoked",
      connection_id: snapshot.connection_id,
      expected_revision: "1",
    }), { token: undefined, adapter: { apply: vi.fn() } });
    expect(response.status).toBe(503);
  });
});
