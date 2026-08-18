import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("tenant Slack runtime wiring", () => {
  it("resolves signed events and commands through the canonical tenant authority", () => {
    const commandStart = source.indexOf('url.pathname === "/slack/commands"');
    const eventStart = source.indexOf('url.pathname !== "/slack/events"', commandStart);
    const queueStart = source.indexOf("async queue(", eventStart);
    const ingress = source.slice(commandStart, queueStart);

    expect(commandStart).toBeGreaterThan(-1);
    expect(ingress).toContain("resolveSlackWorkerIngress({");
    expect(ingress).toContain("handleTenantSlackRequest(request");
    expect(ingress).toContain('schema_version: "1.0"');
    expect(ingress).not.toContain("tenantId: env.TENANT_ID");
    expect(ingress).not.toContain("handleSlackRequest(request");
  });

  it("validates canonical Queue envelopes before dispatching the legacy Slack payload", () => {
    const queueStart = source.indexOf("async queue(");
    const queue = source.slice(queueStart);

    expect(queue).toContain("ackMalformedTenantQueueMessage");
    expect(queue).toContain("consumeTenantQueueMessage");
    expect(queue).toContain("TenantRuntimeBoundaryVerifier");
    expect(queue).toContain("createDurableTenantStateClient");
    expect(queue).toContain("tenantExpectedScope(env, body)");
  });

  it("exposes installation lifecycle and single-use OAuth intent routes", () => {
    expect(source).toContain('url.pathname === "/internal/slack/installations/lifecycle"');
    expect(source).toContain('url.pathname === "/slack/installations/oauth/start"');
    expect(source).toContain('url.pathname === "/slack/installations/oauth/callback"');
    expect(source).toContain("createDurableSlackInstallationIntentClient(env.TENANT_RUNTIME_STATE)");
    expect(source).toContain("isSlackInstallationIntentRequest(request)");
  });

  it("fails closed when the native control-plane Service Binding is unset", () => {
    const oauthStart = source.indexOf('url.pathname === "/slack/installations/oauth/start"');
    const oauthCallback = source.indexOf('url.pathname === "/slack/installations/oauth/callback"');
    const commandStart = source.indexOf('url.pathname === "/slack/commands"', oauthCallback);
    const oauthRoutes = source.slice(oauthStart, commandStart);

    expect(oauthStart).toBeGreaterThan(-1);
    expect(oauthRoutes.match(/!env\.SLACK_INSTALLATION_CONTROL_PLANE/g)).toHaveLength(2);
    expect(oauthRoutes.match(/oauth_configuration_invalid/g)).toHaveLength(2);
    expect(oauthRoutes.match(/status: 503/g)).toHaveLength(2);
    expect(oauthRoutes).toContain(
      "createSlackInstallationControlPlaneClient(\n          env.SLACK_INSTALLATION_CONTROL_PLANE",
    );
  });
});
