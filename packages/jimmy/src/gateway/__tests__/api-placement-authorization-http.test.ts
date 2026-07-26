import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RYOKO_HOME = `/tmp/openryoko-placement-http-${process.pid}`;
  delete process.env.JINN_HOME;
});

import type { AddressInfo } from "node:net";
import type { ApiContext } from "../api.js";
import type { Connector, JinnConfig } from "../../shared/types.js";
import { handleApiRequest } from "../api.js";
import { createSession, getSession, initDb, updateSession } from "../../sessions/registry.js";
import {
  CURRENT_SESSION_HEADER,
  getSessionDelegationToken,
  SESSION_DELEGATION_HEADER,
  SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
  SYSTEM_NOTIFICATION_SESSION_ID,
} from "../../sessions/delegation-auth.js";
import { logger } from "../../shared/logger.js";

describe("placement authorization at HTTP derived-session endpoints", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let parentId = "";
  let legacyParentId = "";
  let config: JinnConfig;
  const sendMessage = vi.fn().mockResolvedValue("sent-1");
  const deliverMessage = vi.fn();

  beforeAll(async () => {
    process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256 = "76af8eef7c7a75fb319976fe592e0ef0f7cc8f14b5f117e97db5b6512d351096";
    const orgDir = path.join(process.env.RYOKO_HOME!, "org");
    fs.mkdirSync(orgDir, { recursive: true });
    fs.writeFileSync(path.join(orgDir, "reviewer.yaml"), [
      "name: reviewer",
      "displayName: Reviewer",
      "department: pilot",
      "rank: employee",
      "engine: claude",
      "model: opus",
      "effortLevel: high",
      "persona: Review placement work",
      "provides:",
      "  - name: review",
      "    description: Review delegated work",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(orgDir, "ryoko.yaml"), [
      "name: ryoko",
      "displayName: Ryoko",
      "department: pilot",
      "rank: manager",
      "engine: claude",
      "model: sonnet",
      "effortLevel: medium",
      "persona: Operate the pilot",
      "",
    ].join("\n"));
    initDb();
    const parent = createSession({
      engine: "claude",
      source: "slack",
      sourceRef: "slack:C1",
      connector: "slack",
      sessionKey: `placement-http-${Date.now()}`,
      replyContext: { channel: "C1" },
      employee: "ryoko",
      model: "sonnet",
      effortLevel: "medium",
    });
    parentId = parent.id;
    updateSession(parent.id, { transportMeta: { placementId: "pilot" } });
    const legacyParent = createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:legacy",
      connector: "web",
      sessionKey: `legacy-http-${Date.now()}`,
      replyContext: { source: "web" },
    });
    legacyParentId = legacyParent.id;

    config = {
      gateway: { host: "127.0.0.1", port: 0 },
      engines: { default: "claude" },
      connectors: { discord: { proxyToken: "service-proxy-canary" } },
      notifications: { connector: "discord", channel: "C-notifications" },
      placements: [{
        id: "pilot",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
        agent: { employee: "ryoko", escalationEmployee: "reviewer" },
        capabilities: { gatewayTools: ["send_message"] },
      }],
    } as unknown as JinnConfig;
    const context = {
      config,
      getConfig: () => config,
      startTime: Date.now(),
      emit: vi.fn(),
      connectors: new Map([["slack", {
        name: "slack",
        sendMessage,
        replyMessage: vi.fn(),
      } as unknown as Connector], ["discord", {
        name: "discord",
        sendMessage,
        replyMessage: vi.fn(),
        deliverMessage,
      } as unknown as Connector]]),
      sessionManager: {
        getEngine: () => ({ name: "claude" }),
        getQueue: () => ({
          getPendingCount: () => 0,
          getTransportState: (_key: string, status: string) => status,
          clearCancelled: vi.fn(),
          enqueue: vi.fn().mockResolvedValue(undefined),
        }),
      },
    } as unknown as ApiContext;
    const server = createServer((req, res) => void handleApiRequest(req, res, context));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  afterAll(async () => {
    delete process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256;
    await closeServer?.();
  });

  async function post(pathname: string, body: Record<string, unknown>, token?: string, sessionId?: string) {
    return fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { [SESSION_DELEGATION_HEADER]: token } : {}),
        ...(sessionId ? { [CURRENT_SESSION_HEADER]: sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function gatewayGet(pathname: string, tool: string, token = getSessionDelegationToken(parentId), sessionId = parentId) {
    return fetch(`${baseUrl}${pathname}`, {
      headers: {
        [SESSION_DELEGATION_HEADER]: token,
        [CURRENT_SESSION_HEADER]: sessionId,
        "x-jinn-gateway-tool": tool,
      },
    });
  }

  it("denies localhost operator mutations without the out-of-process operator token", async () => {
    const deniedConfig = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placements: [] }),
    });
    expect(deniedConfig.status).toBe(403);

    const deniedStub = await post("/api/sessions/stub", { greeting: "bypass" });
    expect(deniedStub.status).toBe(403);

    const allowedStub = await fetch(`${baseUrl}/api/sessions/stub`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openryoko-operator-token": "operator-canary",
      },
      body: JSON.stringify({ greeting: "operator session" }),
    });
    expect(allowedStub.status).toBe(201);
  });

  it("allows only notification-role parent callbacks with the internal service principal", async () => {
    const token = getSessionDelegationToken(SYSTEM_NOTIFICATION_SESSION_ID);
    const allowed = await post(
      `/api/sessions/${parentId}/message`,
      { message: "child completed", role: "notification" },
      token,
      SYSTEM_NOTIFICATION_SESSION_ID,
    );
    expect(allowed.status).toBe(200);

    const wrongRole = await post(
      `/api/sessions/${parentId}/message`,
      { message: "not a notification", role: "user" },
      token,
      SYSTEM_NOTIFICATION_SESSION_ID,
    );
    expect(wrongRole.status).toBe(403);
    await expect(wrongRole.json()).resolves.toEqual({
      error: "internal notification authorization is notification-only",
    });

    const missingAuth = await post(
      `/api/sessions/${parentId}/message`,
      { message: "unauthorized", role: "notification" },
    );
    expect(missingAuth.status).toBe(403);

    const alternateSend = await post(
      "/api/connectors/discord/send",
      { channel: "C-notifications", text: "must not escape through connector send" },
      token,
      SYSTEM_NOTIFICATION_SESSION_ID,
    );
    expect(alternateSend.status).toBe(403);
  });

  it("confines connector notifications to a distinct service principal", async () => {
    const connectorToken = getSessionDelegationToken(SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID);
    const allowed = await post(
      "/api/connectors/discord/send",
      { channel: "C-notifications", text: "rate limit warning" },
      connectorToken,
      SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
    );
    expect(allowed.status).toBe(200);

    const parentCallback = await post(
      `/api/sessions/${parentId}/message`,
      { message: "must not become a parent callback", role: "notification" },
      connectorToken,
      SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
    );
    expect(parentCallback.status).toBe(403);
  });

  it("redacts the Discord proxy service credential from the config API", async () => {
    const denied = await fetch(`${baseUrl}/api/config`);
    expect(denied.status).toBe(403);

    const response = await fetch(`${baseUrl}/api/config`, {
      headers: { "x-openryoko-operator-token": "operator-canary" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { connectors: { discord: { proxyToken?: string } } };
    expect(body.connectors.discord.proxyToken).toBe("***");
    expect(JSON.stringify(body)).not.toContain("service-proxy-canary");
  });

  it("protects session metadata and transcripts while placements are active", async () => {
    const paths = [
      "/api/sessions",
      `/api/sessions/${parentId}`,
      `/api/sessions/${parentId}/children`,
      `/api/sessions/${parentId}/transcript`,
    ];

    for (const path of paths) {
      const denied = await fetch(`${baseUrl}${path}`);
      expect(denied.status).toBe(403);

      const allowed = await fetch(`${baseUrl}${path}`, {
        headers: { "x-openryoko-operator-token": "operator-canary" },
      });
      expect(allowed.status).toBe(200);
    }

    const status = await fetch(`${baseUrl}/api/status`);
    expect(status.status).not.toBe(403);
  });

  it("allows only a signed and explicitly allowed Gateway tool on its bound REST route", async () => {
    config.placements![0].capabilities!.gatewayTools = ["list_sessions", "get_session"];
    try {
      const listed = await gatewayGet("/api/sessions", "list_sessions");
      expect(listed.status).toBe(200);
      const sessions = await listed.json() as Array<{ id: string }>;
      expect(sessions.some((session) => session.id === parentId)).toBe(true);
      expect(sessions.some((session) => session.id === legacyParentId)).toBe(false);

      const current = await gatewayGet(`/api/sessions/${parentId}`, "get_session");
      expect(current.status).toBe(200);
      const outside = await gatewayGet(`/api/sessions/${legacyParentId}`, "get_session");
      expect(outside.status).toBe(403);

      const mismatchedRoute = await gatewayGet("/api/config", "list_sessions");
      expect(mismatchedRoute.status).toBe(403);
      const wrongSignature = await gatewayGet("/api/sessions", "list_sessions", getSessionDelegationToken("wrong"));
      expect(wrongSignature.status).toBe(403);
    } finally {
      config.placements![0].capabilities!.gatewayTools = ["send_message"];
    }
  });

  it("allows only an authenticated placement delivery target on the direct connector route", async () => {
    sendMessage.mockClear();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const token = getSessionDelegationToken(parentId);
    const allowed = await post("/api/connectors/slack/send", { channel: "C1", text: "allowed" }, token, parentId);
    expect(allowed.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith({ channel: "C1", thread: undefined }, "allowed");

    const wrongChannel = await post("/api/connectors/slack/send", { channel: "C2", text: "denied" }, token, parentId);
    expect(wrongChannel.status).toBe(403);
    const missingAuth = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" });
    expect(missingAuth.status).toBe(403);
    const mismatched = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" }, getSessionDelegationToken(legacyParentId), parentId);
    expect(mismatched.status).toBe(403);
    const signedLegacy = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" }, getSessionDelegationToken(legacyParentId), legacyParentId);
    expect(signedLegacy.status).toBe(403);
    await expect(signedLegacy.json()).resolves.toEqual({ error: "session is not bound to a placement" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const events = warn.mock.calls.map(([message]) => message)
      .filter((message) => message.startsWith("security_event "))
      .map((message) => JSON.parse(message.slice("security_event ".length)));
    expect(events).toContainEqual(expect.objectContaining({ reason: "delivery_denied", placementId: "pilot", sessionId: parentId, target: "slack:C2" }));
    expect(events).toContainEqual(expect.objectContaining({ reason: "delivery_denied", placementId: null, sessionId: null }));
    warn.mockRestore();
  });

  it("enforces the placement gateway tool policy on direct delivery", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    config.placements![0].capabilities!.gatewayTools = [];
    try {
      const response = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" }, getSessionDelegationToken(parentId), parentId);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "send_message is not allowed by placement" });
      const event = warn.mock.calls.map(([message]) => message)
        .filter((message) => message.startsWith("security_event "))
        .map((message) => JSON.parse(message.slice("security_event ".length)))
        .find((candidate) => candidate.reason === "gateway_tool_denied");
      expect(event).toMatchObject({
        reason: "gateway_tool_denied", placementId: "pilot", sessionId: parentId, capability: "gateway_tool:send_message",
      });
    } finally {
      config.placements![0].capabilities!.gatewayTools = ["send_message"];
      warn.mockRestore();
    }
  });

  it("denies delivery when a placement omits the gateway tool allowlist", async () => {
    const capabilities = config.placements![0].capabilities;
    config.placements![0].capabilities = undefined;
    try {
      const response = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" }, getSessionDelegationToken(parentId), parentId);
      expect(response.status).toBe(403);
    } finally {
      config.placements![0].capabilities = capabilities;
    }
  });

  it("closes the connector proxy alternate path with the same session and target policy", async () => {
    const token = getSessionDelegationToken(parentId);
    const allowed = await post("/api/connectors/slack/proxy", { action: "sendMessage", target: { channel: "C1" }, text: "allowed proxy" }, token, parentId);
    expect(allowed.status).toBe(200);
    const wrongTarget = await post("/api/connectors/slack/proxy", { action: "sendMessage", target: { channel: "C2" }, text: "denied" }, token, parentId);
    expect(wrongTarget.status).toBe(403);
    const missingAuth = await post("/api/connectors/slack/proxy", { action: "sendMessage", target: { channel: "C1" }, text: "denied" });
    expect(missingAuth.status).toBe(403);
  });

  it("keeps remote Discord proxying on a separate service principal", async () => {
    const response = await fetch(`${baseUrl}/api/connectors/discord/proxy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jinn-connector-proxy-token": "service-proxy-canary",
      },
      body: JSON.stringify({ action: "sendMessage", target: { channel: "REMOTE" }, text: "service send" }),
    });
    expect(response.status).toBe(200);

    for (const token of [undefined, "wrong-token"]) {
      const denied = await fetch(`${baseUrl}/api/connectors/discord/proxy`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-jinn-connector-proxy-token": token } : {}),
        },
        body: JSON.stringify({ action: "sendMessage", target: { channel: "REMOTE" }, text: "denied" }),
      });
      expect(denied.status).toBe(403);
    }
  });

  it("authenticates proxied Discord input with the same service principal", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const denied = await fetch(`${baseUrl}/api/connectors/discord/incoming`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-jinn-connector-proxy-token": token } : {}),
        },
        body: JSON.stringify({ channel: "REMOTE", text: "denied" }),
      });
      expect(denied.status).toBe(403);
    }

    const allowed = await fetch(`${baseUrl}/api/connectors/discord/incoming`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jinn-connector-proxy-token": "service-proxy-canary",
      },
      body: JSON.stringify({ channel: "REMOTE", text: "allowed", sessionKey: "remote:1" }),
    });
    expect(allowed.status).toBe(200);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves the legacy direct delivery API when placements are not configured", async () => {
    const placements = config.placements;
    config.placements = undefined;
    try {
      const response = await post("/api/connectors/slack/send", { channel: "legacy", text: "legacy send" });
      expect(response.status).toBe(200);
    } finally {
      config.placements = placements;
    }
  });

  it.each([
    ["nested child", (id: string) => `/api/sessions/${id}/children`, { prompt: "review", employee: "reviewer" }],
    ["generic child", () => "/api/sessions", { prompt: "review", employee: "reviewer" }],
    ["cross request", () => "/api/org/cross-request", { fromEmployee: "ryoko", service: "review", prompt: "review" }],
  ])("rejects a token bound to another parent on %s", async (_label, pathFor, body) => {
    const response = await post(pathFor(parentId), { ...body, parentSessionId: parentId }, getSessionDelegationToken("other-parent"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid parent session authorization" });
  });

  it("records missing parent rejection on child and cross-request APIs", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const child = await post("/api/sessions/missing-parent/children", { prompt: "review" });
    expect(child.status).toBe(404);
    const cross = await post("/api/org/cross-request", {
      fromEmployee: "ryoko", service: "review", prompt: "review", parentSessionId: "missing-parent",
    });
    expect(cross.status).toBe(400);
    const events = warn.mock.calls.map(([message]) => message)
      .filter((message) => message.startsWith("security_event "))
      .map((message) => JSON.parse(message.slice("security_event ".length)))
      .filter((event) => event.reason === "parent_missing");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "missing-parent", capability: "child_execution" }),
      expect.objectContaining({ sessionId: "missing-parent", capability: "cross_request" }),
    ]));
    warn.mockRestore();
  });

  it.each([
    ["nested child", (id: string) => `/api/sessions/${id}/children`, false],
    ["generic child", () => "/api/sessions", true],
  ])("inherits placement employee and execution settings on a valid %s", async (_label, pathFor, includeParentInBody) => {
    const response = await post(pathFor(parentId), {
      prompt: "continue",
      ...(includeParentInBody ? { parentSessionId: parentId } : {}),
    }, getSessionDelegationToken(parentId));
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    const child = getSession(body.id);
    expect(child).toMatchObject({
      parentSessionId: parentId,
      employee: "ryoko",
      engine: "claude",
      model: "sonnet",
      effortLevel: "medium",
      transportMeta: { placementId: "pilot" },
    });
  });

  it("uses the allowed employee definition and rejects execution overrides", async () => {
    const allowed = await post(`/api/sessions/${parentId}/children`, { prompt: "review", employee: "reviewer" }, getSessionDelegationToken(parentId));
    expect(allowed.status).toBe(201);
    const allowedBody = await allowed.json() as { id: string };
    expect(getSession(allowedBody.id)).toMatchObject({ employee: "reviewer", engine: "claude", model: "opus", effortLevel: "high" });

    for (const override of [{ engine: "codex" }, { model: "opus" }, { effortLevel: "high" }]) {
      const rejected = await post(`/api/sessions/${parentId}/children`, { prompt: "override", ...override }, getSessionDelegationToken(parentId));
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: "placement child execution settings cannot be overridden" });
    }

    const disallowed = await post(`/api/sessions/${parentId}/children`, { prompt: "escape", employee: "outsider" }, getSessionDelegationToken(parentId));
    expect(disallowed.status).toBe(400);
    await expect(disallowed.json()).resolves.toEqual({ error: 'employee "outsider" is not allowed by placement "pilot"' });
  });

  it("inherits placement and provider execution settings on a valid cross-request", async () => {
    const response = await post("/api/org/cross-request", {
      fromEmployee: "ryoko",
      service: "review",
      prompt: "review this",
      parentSessionId: parentId,
    }, getSessionDelegationToken(parentId));
    expect(response.status).toBe(201);
    const body = await response.json() as { sessionId: string; provider: { name: string } };
    expect(body.provider.name).toBe("reviewer");
    expect(getSession(body.sessionId)).toMatchObject({
      parentSessionId: parentId,
      employee: "reviewer",
      engine: "claude",
      model: "opus",
      effortLevel: "high",
      transportMeta: { placementId: "pilot" },
    });
  });

  it("requires operator authorization for legacy parent creation while placements are active", async () => {
    const denied = await post("/api/sessions", {
      prompt: "legacy",
      parentSessionId: legacyParentId,
      engine: "claude",
      model: "opus",
      effortLevel: "high",
    });
    expect(denied.status).toBe(403);

    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openryoko-operator-token": "operator-canary",
      },
      body: JSON.stringify({
        prompt: "legacy",
        parentSessionId: legacyParentId,
        engine: "claude",
        model: "opus",
        effortLevel: "high",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string };
    expect(getSession(body.id)).toMatchObject({
      parentSessionId: legacyParentId,
      engine: "claude",
      model: "opus",
      effortLevel: "high",
    });
  });
});
