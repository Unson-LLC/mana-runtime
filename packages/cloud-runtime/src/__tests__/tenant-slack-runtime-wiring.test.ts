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

  it("keeps pre-handler Slack ingress failures diagnosable without exposing raw errors", () => {
    const eventStart = source.indexOf('url.pathname !== "/slack/events"');
    const queueStart = source.indexOf("async queue(", eventStart);
    const ingress = source.slice(eventStart, queueStart);

    expect(ingress).toContain('event: "slack_tenant_ingress_failed"');
    expect(ingress).toContain('const stage = "runtime_configuration"');
    expect(ingress).toContain('"x-mana-error-code": code');
    expect(ingress).toContain('"x-mana-failure-stage": stage');
    expect(ingress).toContain('"x-mana-correlation-id": correlationId');
    expect(ingress).not.toContain("error.message");
    expect(ingress).not.toContain("error.stack");
  });

  it("validates canonical Queue envelopes before dispatching the legacy Slack payload", () => {
    const queueStart = source.indexOf("async queue(");
    const queue = source.slice(queueStart);

    expect(queue).toContain("ackMalformedTenantQueueMessage");
    expect(queue).toContain("consumeTenantQueueMessage");
    expect(queue).toContain("TenantRuntimeBoundaryVerifier");
    expect(queue).toContain("createDurableTenantStateClient");
    expect(queue).toContain("expectedTenantQueueScope(env, body)");
    expect(queue).toContain('code: "FALLBACK_FORBIDDEN"');
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
    expect(oauthRoutes.match(/status: 503/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(oauthRoutes).toContain(
      "createSlackInstallationControlPlaneClient(\n        env.SLACK_INSTALLATION_CONTROL_PLANE",
    );
  });
});
