import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSettingsDeepLink } from "../../connectors/slack/settings-deep-link.js";
import type { ApiContext } from "../api.js";
import { handleApiRequest } from "../api.js";

describe("settings topology HTTP integration", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256 = "76af8eef7c7a75fb319976fe592e0ef0f7cc8f14b5f117e97db5b6512d351096";
    const config = {
      gateway: { host: "127.0.0.1", port: 0 },
      engines: { default: "claude" },
      logging: { file: false, stdout: false, level: "error" },
      connectors: { slack: {
        appToken: "xapp-secret",
        botToken: "xoxb-secret",
        allowFrom: ["U1"],
        settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" },
        meetingMinutesPipeline: {
          enabled: true,
          routerChannels: ["C_ROUTER"],
          destinations: [{ projectId: "project-a", name: "Project A", channelId: "C_DEST" }],
        },
      } },
    };
    const context = {
      config,
      getConfig: () => config,
      startTime: Date.now(),
      emit: vi.fn(),
      connectors: new Map(),
      sessionManager: {},
      settingsTopologyHistory: () => [{
        ts: "2026-08-02T00:00:00.000Z",
        source: "api/config",
        file: "config.yaml",
        snapshot: "must-not-leak.yaml",
        operatorAuthenticated: true,
      }],
    } as unknown as ApiContext;
    const server = createServer((req, res) => void handleApiRequest(req, res, context));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  afterAll(async () => {
    delete process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256;
    await closeServer?.();
  });

  it("keeps authentication and redaction intact across the real HTTP boundary", async () => {
    const rejected = await fetch(`${baseUrl}/api/settings/topology`);
    expect(rejected.status).toBe(403);

    const accepted = await fetch(`${baseUrl}/api/settings/topology`, {
      headers: { "x-openryoko-operator-token": "operator-canary" },
    });
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(body.schemaVersion).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/xapp-secret|xoxb-secret|must-not-leak/);
  });

  it("carries a Slack-generated safe selection through the authenticated Gateway projection", async () => {
    const deepLink = buildSettingsDeepLink("https://mana.example.com", {
      projectId: "project-a",
      channelId: "C_DEST",
    });
    expect(deepLink).not.toBeNull();

    const unauthorized = await fetch(`${baseUrl}/api/settings/topology`);
    expect(unauthorized.status).toBe(403);
    const authorized = await fetch(`${baseUrl}/api/settings/topology`, {
      headers: { "x-openryoko-operator-token": "operator-canary" },
    });
    expect(authorized.status).toBe(200);
    const topology = await authorized.json();
    const selection = new URL(deepLink!).searchParams;
    const selectedRoute = topology.routes.find((route: { projectId: string; channelId: string }) =>
      route.projectId === selection.get("project") && route.channelId === selection.get("channel"));

    expect(selectedRoute).toMatchObject({ projectId: "project-a", channelId: "C_DEST" });
    expect(JSON.stringify(topology)).not.toMatch(/xapp-secret|xoxb-secret|must-not-leak/);
  });
});
