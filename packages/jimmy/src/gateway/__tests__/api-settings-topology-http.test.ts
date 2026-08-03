import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api.js";
import { handleApiRequest } from "../api.js";

describe("GET /api/settings/topology", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let getSettingsTopologyConfig: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256 = "76af8eef7c7a75fb319976fe592e0ef0f7cc8f14b5f117e97db5b6512d351096";
    const config = {
      gateway: { host: "127.0.0.1", port: 0 },
      engines: { default: "claude" },
      logging: { file: false, stdout: false, level: "error" },
      connectors: { slack: { appToken: "xapp-secret", botToken: "xoxb-secret", allowFrom: ["U1"] } },
    };
    getSettingsTopologyConfig = vi.fn(() => ({
      ...config,
      connectors: { slack: { ...config.connectors.slack, allowFrom: ["U1", "U2"] } },
    }));
    const context = {
      config,
      getConfig: () => config,
      getSettingsTopologyConfig,
      startTime: Date.now(),
      emit: vi.fn(),
      connectors: new Map(),
      sessionManager: {},
      settingsTopologyHistory: () => [{ ts: "2026-08-02T00:00:00.000Z", source: "api/config", file: "config.yaml", snapshot: "must-not-leak.yaml", operatorAuthenticated: true }],
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

  it("requires the dedicated operator credential even without placements", async () => {
    const response = await fetch(`${baseUrl}/api/settings/topology`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "operator authorization required" });
  });

  it("returns a redacted projection only for the operator credential", async () => {
    const response = await fetch(`${baseUrl}/api/settings/topology`, { headers: { "x-openryoko-operator-token": "operator-canary" } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].allowlistedOperatorCount).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/xapp-secret|xoxb-secret|must-not-leak/);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s at the read-only topology boundary", async (method) => {
    getSettingsTopologyConfig.mockClear();
    const response = await fetch(`${baseUrl}/api/settings/topology`, {
      method,
      headers: { "x-openryoko-operator-token": "operator-canary" },
    });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: "method not allowed" });
    expect(getSettingsTopologyConfig).not.toHaveBeenCalled();
  });

  it("normalizes internal failures without reflecting exception details", async () => {
    getSettingsTopologyConfig.mockImplementationOnce(() => {
      throw new Error("secret-sentinel=xoxb-must-not-leak");
    });

    const response = await fetch(`${baseUrl}/api/settings/topology`, {
      headers: { "x-openryoko-operator-token": "operator-canary" },
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "configuration topology unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/secret-sentinel|xoxb-must-not-leak/);
  });
});
