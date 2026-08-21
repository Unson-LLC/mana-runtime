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

  it("allows only health and OAuth installation routes in bootstrap mode", () => {
    const fetchStart = source.indexOf("async fetch(");
    const queueStart = source.indexOf("async queue(", fetchStart);
    const fetchSource = source.slice(fetchStart, queueStart);

    expect(fetchSource).toContain('bootstrapMode === "slack_oauth"');
    expect(fetchSource).toContain('request.method === "POST" && url.pathname === "/slack/installations/oauth/start"');
    expect(fetchSource).toContain('request.method === "GET" && url.pathname === "/slack/installations/oauth/callback"');
    expect(fetchSource).toContain('error: "runtime_bootstrap_mode_active"');
    expect(fetchSource.indexOf('error: "runtime_bootstrap_mode_active"'))
      .toBeLessThan(fetchSource.indexOf('url.pathname === "/internal/slack/installations/lifecycle"'));
  });

  it("retries Queue messages and suppresses scheduled work while bootstrap is active", () => {
    const queueStart = source.indexOf("async queue(");
    const scheduledStart = source.indexOf("async scheduled(", queueStart);
    const queueSource = source.slice(queueStart, scheduledStart);
    const scheduledSource = source.slice(scheduledStart);

    expect(queueSource).toContain("resolveTenantBootstrapMode(env.MANA_BOOTSTRAP_MODE) !== undefined");
    expect(queueSource).toContain("message.retry({ delaySeconds: 60 })");
    expect(scheduledSource).toContain("resolveTenantBootstrapMode(env.MANA_BOOTSTRAP_MODE) !== undefined");
  });
});
