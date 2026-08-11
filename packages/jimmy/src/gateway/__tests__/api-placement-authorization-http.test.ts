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
import type { Connector, JinnConfig, PlacementProfile } from "../../shared/types.js";
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
        projects: ["back-office"],
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

  it("rejects valid placement and internal notification credentials at the topology boundary", async () => {
    const placementCredential = await gatewayGet(
      "/api/settings/topology",
      "send_to_session",
    );
    expect(placementCredential.status).toBe(403);
    const placementBody = await placementCredential.text();
    expect(placementBody).toBe('{"error":"operator authorization required"}');
    expect(placementBody).not.toMatch(/topology|placement-http|pilot|x-jinn-session-token/);

    const internalNotificationCredential = await fetch(`${baseUrl}/api/settings/topology`, {
      headers: {
        [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(SYSTEM_NOTIFICATION_SESSION_ID),
        [CURRENT_SESSION_HEADER]: SYSTEM_NOTIFICATION_SESSION_ID,
      },
    });
    expect(internalNotificationCredential.status).toBe(403);
    const notificationBody = await internalNotificationCredential.text();
    expect(notificationBody).toBe('{"error":"operator authorization required"}');
    expect(notificationBody).not.toMatch(/topology|system:notifications|x-jinn-session-token/);
  });

  it("confines connector notifications to a distinct service principal", async () => {
    sendMessage.mockClear();
    const connectorToken = getSessionDelegationToken(SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID);
    const allowed = await post(
      "/api/connectors/discord/send",
      { channel: "C-notifications", text: "rate limit warning" },
      connectorToken,
      SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
    );
    expect(allowed.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const wrongConnector = await post(
      "/api/connectors/slack/send",
      { channel: "C-notifications", text: "must not cross connector scope" },
      connectorToken,
      SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
    );
    expect(wrongConnector.status).toBe(403);

    const wrongChannel = await post(
      "/api/connectors/discord/send",
      { channel: "C-other", text: "must not cross channel scope" },
      connectorToken,
      SYSTEM_CONNECTOR_NOTIFICATION_SESSION_ID,
    );
    expect(wrongChannel.status).toBe(403);
    expect(sendMessage).toHaveBeenCalledTimes(1);

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

  it("binds canonical task tools to their /api/tasks routes under placement policy", async () => {
    config.placements![0].capabilities!.gatewayTools = ["list_tasks", "create_task"];
    try {
      // Authorized tool + matching route passes the placement gate; the request
      // then reaches the task proxy, which fails loud (503) because the
      // Brainbase store is unconfigured in tests — proving the gate was passed.
      const listed = await fetch(`${baseUrl}/api/tasks`, {
        headers: {
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "list_tasks",
        },
      });
      expect(listed.status).toBe(503);
      expect(((await listed.json()) as { code?: string }).code).toBe("task_store_not_configured");

      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "create_task",
        },
        body: JSON.stringify({ title: "placement-bound task" }),
      });
      expect(created.status).toBe(503);

      // A tool not in the placement allowlist is rejected before the proxy.
      const denied = await fetch(`${baseUrl}/api/tasks/some-id`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "update_task",
        },
        body: JSON.stringify({ expected_version: 1 }),
      });
      expect(denied.status).toBe(403);

      // A route/tool mismatch is rejected even for an allowed tool.
      const mismatched = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "list_tasks",
        },
        body: JSON.stringify({ title: "mismatched" }),
      });
      expect(mismatched.status).toBe(403);
    } finally {
      config.placements![0].capabilities!.gatewayTools = ["send_message"];
    }
  });

  it("forces placement channel projects onto canonical task creation", async () => {
    const originalPlacements = config.placements;
    const originalFetch = globalThis.fetch;
    const companionBodies: Array<Record<string, unknown>> = [];
    const scopedPlacement = {
      ...originalPlacements![0],
      capabilities: { ...originalPlacements![0].capabilities, gatewayTools: ["create_task"] },
    } as PlacementProfile;
    config.placements = [
      { ...scopedPlacement, projects: [" back-office ", "shared"] },
      { ...scopedPlacement, id: "same-channel", projects: ["shared", "finance"] },
      { ...scopedPlacement, id: "disabled", enabled: false, projects: ["disabled"] },
      { ...scopedPlacement, id: "other-workspace", workspaceId: "T2", projects: ["other-workspace"] },
      { ...scopedPlacement, id: "other-channel", channelId: "C2", projects: ["other-channel"] },
    ];
    process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
    process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://bb.example/api/companion/tasks") {
        companionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          id: "ct1.test",
          version: 1,
          title: "placement-bound task",
          project_codes: companionBodies.at(-1)?.project_codes,
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    });

    try {
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "create_task",
        },
        body: JSON.stringify({
          title: "placement-bound task",
          project_codes: ["spoofed-project"],
        }),
      });
      expect(created.status).toBe(201);
      expect(companionBodies).toHaveLength(1);
      expect(companionBodies[0].project_codes).toEqual(["back-office", "shared", "finance"]);

      config.placements = [{ ...config.placements[0], projects: [] }];
      const unscoped = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "create_task",
        },
        body: JSON.stringify({ title: "must not become an orphan" }),
      });
      expect(unscoped.status).toBe(409);
      await expect(unscoped.json()).resolves.toEqual({ error: "placement has no projects configured" });
      expect(companionBodies).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.BRAINBASE_TASK_API_BASE_URL;
      delete process.env.BRAINBASE_TASK_API_TOKEN;
      config.placements = originalPlacements;
    }
  });

  it("resolves placement assignee names and fail-closes before task creation", async () => {
    const originalPlacements = config.placements;
    const originalFetch = globalThis.fetch;
    const companionBodies: Array<Record<string, unknown>> = [];
    const companionIdempotencyKeys: Array<string | null> = [];
    let graphStatus = 200;
    let graphRecords: Array<Record<string, unknown>> = [{
      id: "per_umeda_haruka",
      payload: { name: "梅田 遼", aliases: ["Haruka Umeda"] },
    }];
    config.placements = [{
      ...originalPlacements![0],
      projects: ["back-office"],
      capabilities: { ...originalPlacements![0].capabilities, gatewayTools: ["create_task"] },
    }];
    process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
    process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
    process.env.BRAINBASE_GRAPH_API_BASE_URL = "https://graph.example";
    process.env.BRAINBASE_GRAPH_API_TOKEN = "bbsvc_graph";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith("https://graph.example/api/info/graph/entities")) {
        return new Response(JSON.stringify({ records: graphRecords }), {
          status: graphStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (target === "https://bb.example/api/companion/tasks") {
        companionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        companionIdempotencyKeys.push(new Headers(init?.headers).get("idempotency-key"));
        return new Response(JSON.stringify({ id: "ct1.assigned", version: 1, title: "assigned" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });
    const create = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
        [CURRENT_SESSION_HEADER]: parentId,
        "x-jinn-gateway-tool": "create_task",
      },
      body: JSON.stringify({ title: "assigned", idempotency_key: "idem-create", ...body }),
    });

    try {
      const resolved = await create({ assignee_name: "Haruka Umeda" });
      expect(resolved.status).toBe(201);
      expect(companionBodies).toEqual([expect.objectContaining({
        assignee_person_id: "per_umeda_haruka",
        project_codes: ["back-office"],
      })]);
      expect(companionIdempotencyKeys).toEqual(["idem-create"]);

      for (const raw of [null, "per_spoofed"]) {
        const rejected = await create({ assignee_person_id: raw });
        expect(rejected.status).toBe(400);
        await expect(rejected.json()).resolves.toMatchObject({ code: "assignee_person_id_forbidden" });
      }
      const blank = await create({ assignee_name: "   " });
      expect(blank.status).toBe(400);
      await expect(blank.json()).resolves.toMatchObject({ code: "invalid_assignee_name" });
      const wrongType = await create({ assignee_name: 42 });
      expect(wrongType.status).toBe(400);
      await expect(wrongType.json()).resolves.toMatchObject({ code: "invalid_assignee_name" });

      graphRecords = [];
      const unknown = await create({ assignee_name: "Nobody" });
      expect(unknown.status).toBe(422);
      await expect(unknown.json()).resolves.toMatchObject({ code: "assignee_not_found" });

      graphRecords = [
        { id: "per_a", payload: { name: "A", aliases: ["Shared"] } },
        { id: "per_b", payload: { name: "B", aliases: ["Shared"] } },
      ];
      const ambiguous = await create({ assignee_name: "Shared" });
      expect(ambiguous.status).toBe(422);
      await expect(ambiguous.json()).resolves.toMatchObject({ code: "assignee_ambiguous" });

      graphStatus = 503;
      const unavailable = await create({ assignee_name: "梅田 遼" });
      expect(unavailable.status).toBe(503);
      await expect(unavailable.json()).resolves.toMatchObject({ code: "assignee_directory_unavailable" });
      expect(companionBodies).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.BRAINBASE_TASK_API_BASE_URL;
      delete process.env.BRAINBASE_TASK_API_TOKEN;
      delete process.env.BRAINBASE_GRAPH_API_BASE_URL;
      delete process.env.BRAINBASE_GRAPH_API_TOKEN;
      config.placements = originalPlacements;
    }
  });

  it("resolves placement assignees on update and sends only the update allowlist", async () => {
    const originalPlacements = config.placements;
    const originalFetch = globalThis.fetch;
    let companionBody: Record<string, unknown> | undefined;
    let companionIdempotencyKey: string | null = null;
    config.placements = [{
      ...originalPlacements![0],
      capabilities: { ...originalPlacements![0].capabilities, gatewayTools: ["update_task"] },
    }];
    process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
    process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
    process.env.BRAINBASE_GRAPH_API_BASE_URL = "https://graph.example";
    process.env.BRAINBASE_GRAPH_API_TOKEN = "bbsvc_graph";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith("https://graph.example/api/info/graph/entities")) {
        return new Response(JSON.stringify({ records: [{
          id: "per_umeda_haruka",
          payload: { name: "梅田 遼", aliases: ["Haruka Umeda"] },
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target === "https://bb.example/api/companion/tasks/ct1.test") {
        companionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        companionIdempotencyKey = new Headers(init?.headers).get("idempotency-key");
        return new Response(JSON.stringify({ id: "ct1.test", version: 4, title: "updated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });

    try {
      const spoofed = await fetch(`${baseUrl}/api/tasks/ct1.test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "update_task",
        },
        body: JSON.stringify({ expected_version: 3, assignee_person_id: "per_spoofed" }),
      });
      expect(spoofed.status).toBe(400);
      await expect(spoofed.json()).resolves.toMatchObject({ code: "assignee_person_id_forbidden" });
      expect(companionBody).toBeUndefined();

      const projectSpoofed = await fetch(`${baseUrl}/api/tasks/ct1.test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "update_task",
        },
        body: JSON.stringify({ expected_version: 3, project_codes: ["other-project"] }),
      });
      expect(projectSpoofed.status).toBe(400);
      await expect(projectSpoofed.json()).resolves.toMatchObject({ code: "project_codes_forbidden" });
      expect(companionBody).toBeUndefined();

      const updated = await fetch(`${baseUrl}/api/tasks/ct1.test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "update_task",
        },
        body: JSON.stringify({
          expected_version: 3,
          title: "updated",
          assignee_name: "梅田 遼",
          idempotency_key: "idem-update",
          arbitrary: "must-not-leak",
        }),
      });
      expect(updated.status).toBe(200);
      expect(companionBody).toEqual({
        expected_version: 3,
        title: "updated",
        assignee_person_id: "per_umeda_haruka",
      });
      expect(companionIdempotencyKey).toBe("idem-update");
    } finally {
      fetchSpy.mockRestore();
      delete process.env.BRAINBASE_TASK_API_BASE_URL;
      delete process.env.BRAINBASE_TASK_API_TOKEN;
      delete process.env.BRAINBASE_GRAPH_API_BASE_URL;
      delete process.env.BRAINBASE_GRAPH_API_TOKEN;
      config.placements = originalPlacements;
    }
  });

  it.each(["missing", "disabled"] as const)(
    "revalidates a %s placement after Graph resolution before updating a task",
    async (placementState) => {
    const originalPlacements = config.placements;
    const originalFetch = globalThis.fetch;
    let graphRequestedResolve!: () => void;
    const graphRequested = new Promise<void>((resolve) => { graphRequestedResolve = resolve; });
    let releaseGraph!: (response: Response) => void;
    const graphResponse = new Promise<Response>((resolve) => { releaseGraph = resolve; });
    let companionCalls = 0;
    config.placements = [{
      ...originalPlacements![0],
      capabilities: { ...originalPlacements![0].capabilities, gatewayTools: ["update_task"] },
    }];
    process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
    process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
    process.env.BRAINBASE_GRAPH_API_BASE_URL = "https://graph.example";
    process.env.BRAINBASE_GRAPH_API_TOKEN = "bbsvc_graph";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith("https://graph.example/api/info/graph/entities")) {
        graphRequestedResolve();
        return graphResponse;
      }
      if (target === "https://bb.example/api/companion/tasks/ct1.test") {
        companionCalls += 1;
        return new Response(JSON.stringify({ id: "ct1.test", version: 4, title: "updated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });

    try {
      const pending = fetch(`${baseUrl}/api/tasks/ct1.test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [SESSION_DELEGATION_HEADER]: getSessionDelegationToken(parentId),
          [CURRENT_SESSION_HEADER]: parentId,
          "x-jinn-gateway-tool": "update_task",
        },
        body: JSON.stringify({ expected_version: 3, assignee_name: "梅田 遼" }),
      });
      await graphRequested;
      config.placements = placementState === "missing"
        ? []
        : [{ ...config.placements![0], enabled: false }];
      releaseGraph(new Response(JSON.stringify({ records: [{
        id: "per_umeda_haruka",
        payload: { name: "梅田 遼", aliases: [] },
      }] }), { status: 200, headers: { "content-type": "application/json" } }));

      const response = await pending;
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "placement is unavailable" });
      expect(companionCalls).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.BRAINBASE_TASK_API_BASE_URL;
      delete process.env.BRAINBASE_TASK_API_TOKEN;
      delete process.env.BRAINBASE_GRAPH_API_BASE_URL;
      delete process.env.BRAINBASE_GRAPH_API_TOKEN;
      config.placements = originalPlacements;
    }
    },
  );

  it("keeps legacy create omission and operator update null compatibility", async () => {
    const originalFetch = globalThis.fetch;
    const companionBodies: Array<Record<string, unknown>> = [];
    process.env.BRAINBASE_TASK_API_BASE_URL = "https://bb.example";
    process.env.BRAINBASE_TASK_API_TOKEN = "bbsvc_test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://bb.example/api/companion/tasks" || String(input) === "https://bb.example/api/companion/tasks/ct1.operator") {
        companionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "ct1.operator", version: 2, title: "operator" }), {
          status: init?.method === "PATCH" ? 200 : 201,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });

    try {
      for (const assignee_person_id of ["per_direct", null]) {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openryoko-operator-token": "operator-canary",
          },
          body: JSON.stringify({ title: "operator", assignee_person_id }),
        });
        expect(response.status).toBe(201);
      }
      expect(companionBodies.map((body) => body.assignee_person_id)).toEqual(["per_direct", undefined]);

      const cleared = await fetch(`${baseUrl}/api/tasks/ct1.operator`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-openryoko-operator-token": "operator-canary",
        },
        body: JSON.stringify({
          expected_version: 1,
          assignee_person_id: null,
          project_codes: [" finance ", "finance", "", "back-office"],
        }),
      });
      expect(cleared.status).toBe(200);
      expect(companionBodies.at(-1)).toEqual({
        expected_version: 1,
        assignee_person_id: null,
        project_codes: ["finance", "back-office"],
      });

      const placementOnly = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openryoko-operator-token": "operator-canary",
        },
        body: JSON.stringify({ title: "operator", assignee_name: "梅田 遼" }),
      });
      expect(placementOnly.status).toBe(400);
      await expect(placementOnly.json()).resolves.toMatchObject({ code: "assignee_name_placement_only" });
      expect(companionBodies).toHaveLength(3);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.BRAINBASE_TASK_API_BASE_URL;
      delete process.env.BRAINBASE_TASK_API_TOKEN;
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

  it("fail-closes the session-run boundary when the placement kill switch is off", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    config.placements![0].enabled = false;
    try {
      const runSession = createSession({
        engine: "claude", source: "slack", sourceRef: "slack:C1-run", connector: "slack",
        sessionKey: `placement-run-${Date.now()}`, replyContext: { channel: "C1" },
      });
      updateSession(runSession.id, { transportMeta: { placementId: "pilot" } });
      const { runWebSession } = await import("../api.js");
      await runWebSession(
        getSession(runSession.id)!,
        "blocked prompt",
        { name: "claude" } as never,
        config,
        {} as never,
      );
      const after = getSession(runSession.id);
      expect(after?.status).toBe("error");
      expect(after?.lastError).toBe('Placement "pilot" is disabled');
      const event = warn.mock.calls.map(([message]) => message)
        .filter((message) => message.startsWith("security_event "))
        .map((message) => JSON.parse(message.slice("security_event ".length)))
        .find((candidate) => candidate.reason === "placement_disabled" && candidate.capability === "session_run");
      expect(event).toMatchObject({ reason: "placement_disabled", placementId: "pilot", sessionId: runSession.id });
    } finally {
      delete config.placements![0].enabled;
      warn.mockRestore();
    }
  });

  it("fail-closes direct delivery when the placement kill switch is off", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    config.placements![0].enabled = false;
    try {
      const response = await post("/api/connectors/slack/send", { channel: "C1", text: "denied" }, getSessionDelegationToken(parentId), parentId);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'placement "pilot" is disabled' });
      const event = warn.mock.calls.map(([message]) => message)
        .filter((message) => message.startsWith("security_event "))
        .map((message) => JSON.parse(message.slice("security_event ".length)))
        .find((candidate) => candidate.reason === "placement_disabled");
      expect(event).toMatchObject({ reason: "placement_disabled", placementId: "pilot", sessionId: parentId });
    } finally {
      delete config.placements![0].enabled;
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
