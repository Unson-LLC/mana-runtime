import { describe, expect, it, vi } from "vitest";
import { signTaskWriteCapability } from "@openryoko/write-broker";
import { createRuntimeGatewayProxyHandler } from "../runtime-gateway-proxy.js";

const secret = "g".repeat(32);
const placements = JSON.stringify([{ placementId: "mana-dev-biz", channelId: "C_MANA", projectCodes: ["mana"], taskWriteEnabled: true,
  audience: { type: "operator", allowedUserIds: ["UALLOWED"] }, taskInventoryChannelIds: ["C_MANA", "C_ACCOUNTING"], taskInventoryAllowedUserIds: ["UALLOWED"],
  capabilities: { mcp: ["gateway"], gatewayTools: ["list_tasks","search_tasks","list_tasks_across_channels","search_tasks_across_channels","send_message"] },
  deliveryScopes: [{ connector: "slack", channelId: "C_MANA" }] },
{ placementId: "mana-accounting", channelId: "C_ACCOUNTING", projectCodes: ["back-office"], taskWriteEnabled: false,
  taskInventoryAllowedUserIds: ["UALLOWED"] }]);
async function capability(actor = "UALLOWED", projects = ["mana"]) { return signTaskWriteCapability({ version: 1, audience: "mana-task-write", requestId: "Ev1", actor: { provider: "slack", id: actor, workspace: "T_TEAM" }, placementId: "mana-dev-biz", projects, operations: ["*"], expiresAt: Date.now() + 60_000, nonce: "n", budget: 3 }, secret); }
const env = { TASK_WRITE_CAPABILITY_SECRET: secret, SLACK_EXPECTED_TEAM_ID: "T_TEAM", RUNTIME_PLACEMENTS_JSON: placements, RUNTIME_TASK_SEARCH_ENABLED: "true", BRAINBASE_TASK_API_BASE_URL: "https://tasks.example.com", BRAINBASE_TASK_API_TOKEN: "task-token", SLACK_BOT_TOKEN: "slack-token", RUNTIME_EMPLOYEES_JSON: JSON.stringify([{ name: "critical-reviewer", persona: "private instructions", model: "opus" }]) };
const request = async (tool: string, args: Record<string, unknown>, token = capability()) => new Request("https://gateway.internal/api/runtime/gateway", { method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": await token }, body: JSON.stringify({ tool, arguments: args, request_id: "Ev1", call_index: 1 }) });

describe("runtime gateway proxy", () => {
  it("forces list_tasks to the placement project", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { expect(input instanceof Request ? input.url : String(input)).toContain("project_code=mana"); return Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"], assignee_person_id: null, assignee_display_name: null, due_at: null }], next_cursor: null }); });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", { limit: 10, project: "outside" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total_count: null,
      count_status: "not_requested",
      has_more: false,
      read_status: "complete",
      scope: { mode: "current_channel", project_codes: ["mana"] },
    });
  });
  it("preserves exact count metadata and reports partial list reads", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"], assignee_person_id: null, assignee_display_name: null, due_at: null }],
      next_cursor: "next",
      total_count: 37,
      count_status: "exact",
      read_status: "partial",
    }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject({ total_count: 37, count_status: "exact", has_more: true, read_status: "partial" });
  });
  it("implements bounded search_tasks with placement scope and count metadata", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/companion/tasks/search");
      expect(url.searchParams.get("query")).toBe("契約");
      expect(url.searchParams.getAll("project_code")).toEqual(["mana"]);
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.searchParams.get("status")).toBe("pending");
      expect(url.searchParams.get("priority")).toBe("high");
      expect(url.searchParams.get("assignee_person_id")).toBe("person-1");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      return Response.json({ items: [], next_cursor: null, total_count: 0, count_status: "exact", has_more: false, read_status: "complete" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks", { query: "契約", limit: 20, project: "outside", status: "pending", priority: "high", assignee_person_id: "person-1", cursor: "cursor-1" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 0, count_status: "exact", has_more: false, scope: { mode: "current_channel", project_codes: ["mana"] } });
  });
  it("lists tasks across explicitly authorized channels", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      return Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["back-office"] }], next_cursor: null, total_count: 1, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks_across_channels", { channel_ids: ["C_MANA", "C_ACCOUNTING"], limit: 20 }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 1, scope: { mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"], project_codes: ["mana", "back-office"], channels: [
      { channel_id: "C_MANA", project_codes: ["mana"] }, { channel_id: "C_ACCOUNTING", project_codes: ["back-office"] },
    ] } });
  });
  it("searches tasks across explicitly authorized channels", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/companion/tasks/search");
      expect(url.searchParams.get("query")).toBe("請求");
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      expect(url.searchParams.get("status")).toBe("pending");
      expect(url.searchParams.get("priority")).toBe("high");
      expect(url.searchParams.get("assignee_person_id")).toBe("person-1");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      expect(url.searchParams.get("limit")).toBe("12");
      return Response.json({ items: [{ id: "t1", title: "請求確認", status: "pending", priority: "high", version: 1, project_codes: ["back-office"] }], next_cursor: null, total_count: 1, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks_across_channels", {
      channel_ids: ["C_MANA", "C_ACCOUNTING"], query: "請求", status: "pending", priority: "high",
      assignee_person_id: "person-1", cursor: "cursor-1", limit: 12,
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 1, scope: { mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"], project_codes: ["mana", "back-office"] } });
  });
  async function expectCrossChannelScopeDenied(channel_ids: string[]) {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids }), env);
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  }
  it("rejects a channel outside the configured inventory scope before upstream", async () => {
    await expectCrossChannelScopeDenied(["C_OTHER"]);
  });
  it("rejects duplicate requested channels before upstream", async () => {
    await expectCrossChannelScopeDenied(["C_MANA", "C_MANA"]);
  });
  it("rejects an empty requested channel scope before upstream", async () => {
    await expectCrossChannelScopeDenied([]);
  });
  it("rejects an actor missing from a target task inventory audience", async () => {
    const restrictedPlacements = JSON.parse(placements) as Array<Record<string, unknown>>;
    restrictedPlacements[1].taskInventoryAllowedUserIds = ["UOTHER"];
    const restricted = JSON.stringify(restrictedPlacements);
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids: ["C_ACCOUNTING"] }), { ...env, RUNTIME_PLACEMENTS_JSON: restricted });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects ambiguous target channel placements before upstream", async () => {
    const ambiguousPlacements = JSON.parse(placements) as Array<Record<string, unknown>>;
    ambiguousPlacements.push({ placementId: "duplicate-accounting", channelId: "C_ACCOUNTING", projectCodes: ["duplicate"] });
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids: ["C_ACCOUNTING"] }), {
      ...env, RUNTIME_PLACEMENTS_JSON: JSON.stringify(ambiguousPlacements),
    });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("disables cross-channel search with the shared kill switch", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("search_tasks_across_channels", { channel_ids: ["C_MANA"], query: "x" }), { ...env, RUNTIME_TASK_SEARCH_ENABLED: "false" });
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects invalid count metadata instead of turning it into zero", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [], next_cursor: null, total_count: null, count_status: "exact" }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_invalid_response" });
  });
  it.each([
    [{ total_count: 12, count_status: "lower_bound" }, { total_count: 12, count_status: "lower_bound" }],
    [{ total_count: null, count_status: "unavailable" }, { total_count: null, count_status: "unavailable" }],
  ])("preserves non-exact count state %#", async (metadata, expected) => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items: [], next_cursor: null, ...metadata })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject(expected);
  });
  it("keeps an upstream API failure distinct from an empty result", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ code: "upstream" }, { status: 500 })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_failed" });
  });
  it("rejects a search result containing a project outside the placement", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["outside"] }], next_cursor: null, total_count: 1, count_status: "exact", has_more: false }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks", { query: "x" }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_scope_violation" });
  });
  it("rejects a cross-channel result containing a project outside the authorized union", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["outside"] }], next_cursor: null, total_count: 1, count_status: "exact" }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks_across_channels", { channel_ids: ["C_MANA", "C_ACCOUNTING"] }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_scope_violation" });
  });
  it("rejects an upstream page larger than the requested limit", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ id: `t${index}`, title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"] }));
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items, next_cursor: null })) as typeof fetch)(await request("list_tasks", { limit: 2 }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_invalid_response" });
  });
  it("forces partial when the upstream says complete but has a next page", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items: [], next_cursor: "next", read_status: "complete" })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject({ has_more: true, read_status: "partial" });
  });
  it("disables gateway search_tasks with the shared task search kill switch", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("search_tasks", { query: "x" }), { ...env, RUNTIME_TASK_SEARCH_ENABLED: "false" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "gateway_tool_disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects delivery outside the placement", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("send_message", { connector: "slack", channel: "C_OTHER", text: "x" }), env);
    expect(response.status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a capability for a non-operator", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_tasks", {}, capability("UOTHER")), env);
    expect(response.status).toBe(403);
  });
  it("lists employees without persona and returns an exact employee", async () => {
    const listPlacement = placements.replace('"search_tasks_across_channels","send_message"', '"search_tasks_across_channels","send_message","list_employees","get_employee"');
    const list = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_employees", {}), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await list.json()).toEqual({ employees: [{ name: "critical-reviewer", model: "opus" }] });
    const get = await createRuntimeGatewayProxyHandler(vi.fn())(await request("get_employee", { name: "critical-reviewer" }), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await get.json()).toEqual({ name: "critical-reviewer", persona: "private instructions", model: "opus" });
  });
  it("reads sessions only from the placement registry object", async () => {
    const sessionPlacement = placements.replace('"search_tasks_across_channels","send_message"', '"search_tasks_across_channels","send_message","list_sessions","get_session"');
    const fetch = vi.fn(async () => Response.json({ sessions: [{ sessionId: "s1", placementId: "mana-dev-biz" }] }));
    const registry = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch })) };
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_sessions", { status: "active" }), { ...env, RUNTIME_PLACEMENTS_JSON: sessionPlacement, RUNTIME_SESSION_REGISTRY: registry });
    expect(response.status).toBe(200);
    expect(registry.idFromName).toHaveBeenCalledWith("mana-dev-biz");
    expect(fetch).toHaveBeenCalledWith("https://session-registry.internal/sessions?status=active");
  });
});
