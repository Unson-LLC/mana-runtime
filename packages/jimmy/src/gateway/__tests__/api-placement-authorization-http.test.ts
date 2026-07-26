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
import { CURRENT_SESSION_HEADER, getSessionDelegationToken, SESSION_DELEGATION_HEADER } from "../../sessions/delegation-auth.js";

describe("placement authorization at HTTP derived-session endpoints", () => {
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let parentId = "";
  let legacyParentId = "";
  const sendMessage = vi.fn().mockResolvedValue("sent-1");

  beforeAll(async () => {
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

    const config = {
      gateway: { host: "127.0.0.1", port: 0 },
      engines: { default: "claude" },
      placements: [{
        id: "pilot",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C1",
        audience: { type: "operator", allowedUsers: ["U1"] },
        agent: { employee: "ryoko", escalationEmployee: "reviewer" },
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
      } as unknown as Connector]]),
      sessionManager: {
        getEngine: () => undefined,
        getQueue: () => ({
          getPendingCount: () => 0,
          getTransportState: (_key: string, status: string) => status,
        }),
      },
    } as unknown as ApiContext;
    const server = createServer((req, res) => void handleApiRequest(req, res, context));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  afterAll(async () => closeServer?.());

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

  it("allows only an authenticated placement delivery target on the direct connector route", async () => {
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
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

  it("keeps legacy parent creation compatible without a delegation token", async () => {
    const response = await post("/api/sessions", {
      prompt: "legacy",
      parentSessionId: legacyParentId,
      engine: "claude",
      model: "opus",
      effortLevel: "high",
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
