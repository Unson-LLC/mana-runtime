import { describe, expect, it, vi } from "vitest";

import { bootstrapUnsonSlackCredential } from "../tenant-credential-bootstrap.js";

const env = {
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID: "ten_01M0HMA228ES64N4TFX846V8T8",
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY: "unson-business",
  SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
  SLACK_OAUTH_APP_ID: "A0BPM2J33SN",
  SLACK_BOT_TOKEN_UNSON: "xoxb-production-secret",
  BRAINBASE_SLACK_CREDENTIAL_STORE_URL: "https://credential.example/api/v1/credentials",
  BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN: "store-service-token",
  BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID: "wsc_01M0HRK94FG2Y8DMBFYJHYT14K",
};

describe("Unson Slack credential bootstrap", () => {
  it("moves the existing Worker secret to the credential store without returning it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        team_id: env.SLACK_EXPECTED_TEAM_ID,
        user_id: "U088D1HBY6L",
      }, { headers: { "x-oauth-scopes": "commands,chat:write,users:read" } }))
      .mockResolvedValueOnce(Response.json({
        result: {
          credential_ref: "credref://bbcs/opaque",
          credential_mode: "customer_oauth",
        },
      }));

    const response = await bootstrapUnsonSlackCredential(
      new Request("https://worker.example/admin/tenant-credential/bootstrap-slack", {
        method: "POST",
        headers: { "content-length": "0" },
      }),
      env,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const responsePayload = await response.json();
    expect(responsePayload).toEqual({
      ok: true,
      tenant_id: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID,
      connection_id: env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID,
      connection_revision: "1",
      provider: "slack",
      workspace_id: env.SLACK_EXPECTED_TEAM_ID,
      app_id: env.SLACK_OAUTH_APP_ID,
      credential_ref: "credref://bbcs/opaque",
      credential_mode: "customer_oauth",
      scopes: ["chat:write", "commands", "users:read"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [slackUrl, slackInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(slackUrl).toBe("https://slack.com/api/auth.test");
    expect(slackInit.headers).toEqual({ authorization: `Bearer ${env.SLACK_BOT_TOKEN_UNSON}` });
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(env.BRAINBASE_SLACK_CREDENTIAL_STORE_URL);
    expect(init.headers).toEqual({
      authorization: `Bearer ${env.BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      operation: "store",
      tenant_id: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID,
      tenant_key: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY,
      connection_id: env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID,
      connection_revision: "1",
      provider: "slack",
      workspace_id: env.SLACK_EXPECTED_TEAM_ID,
      app_id: env.SLACK_OAUTH_APP_ID,
      idempotency_key: `bootstrap-v2:${env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID}:${env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID}:1`,
      credential_material: env.SLACK_BOT_TOKEN_UNSON,
      credential_mode: "customer_oauth",
    });
    expect(JSON.stringify(responsePayload)).not.toContain(env.SLACK_BOT_TOKEN_UNSON);
  });

  it("uses the credential-store service binding when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      team_id: env.SLACK_EXPECTED_TEAM_ID,
    }));
    const serviceFetch = vi.fn().mockResolvedValue(Response.json({
      result: {
        credential_ref: "credref://bbcs/opaque",
        credential_mode: "customer_oauth",
      },
    }));

    const response = await bootstrapUnsonSlackCredential(new Request(
      "https://worker.example/admin/tenant-credential/bootstrap-slack",
      { method: "POST" },
    ), {
      ...env,
      BRAINBASE_SLACK_CREDENTIAL_STORE_SERVICE: { fetch: serviceFetch },
    }, fetchImpl);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(serviceFetch).toHaveBeenCalledOnce();
    expect(serviceFetch.mock.calls[0]?.[0]).toBe(env.BRAINBASE_SLACK_CREDENTIAL_STORE_URL);
  });

  it("fails closed for request bodies, missing configuration, and upstream failures", async () => {
    const fetchImpl = vi.fn();
    const bodyResponse = await bootstrapUnsonSlackCredential(new Request(
      "https://worker.example/admin/tenant-credential/bootstrap-slack",
      { method: "POST", body: "{}" },
    ), env, fetchImpl);
    const missingResponse = await bootstrapUnsonSlackCredential(new Request(
      "https://worker.example/admin/tenant-credential/bootstrap-slack",
      { method: "POST" },
    ), { ...env, SLACK_BOT_TOKEN_UNSON: undefined }, fetchImpl);
    const upstreamResponse = await bootstrapUnsonSlackCredential(new Request(
      "https://worker.example/admin/tenant-credential/bootstrap-slack",
      { method: "POST" },
    ), env, vi.fn().mockRejectedValue(new Error("unavailable")));

    expect(bodyResponse.status).toBe(400);
    expect(missingResponse.status).toBe(503);
    expect(upstreamResponse.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not store a token belonging to another Slack workspace", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      team_id: "T0000000000",
    }));

    const response = await bootstrapUnsonSlackCredential(new Request(
      "https://worker.example/admin/tenant-credential/bootstrap-slack",
      { method: "POST" },
    ), env, fetchImpl);

    expect(response.status).toBe(409);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
