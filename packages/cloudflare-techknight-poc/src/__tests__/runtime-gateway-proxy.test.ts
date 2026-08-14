import { describe, expect, it, vi } from "vitest";
import { signTaskWriteCapability } from "@openryoko/write-broker";
import { createRuntimeGatewayProxyHandler } from "../runtime-gateway-proxy.js";

const secret = "g".repeat(32);
const placements = JSON.stringify([{ placementId: "mana-dev-biz", channelId: "C_MANA", projectCodes: ["mana"], taskWriteEnabled: true,
  audience: { type: "operator", allowedUserIds: ["UALLOWED"] }, capabilities: { mcp: ["gateway"], gatewayTools: ["list_tasks","send_message"] },
  deliveryScopes: [{ connector: "slack", channelId: "C_MANA" }] }]);
async function capability(actor = "UALLOWED", projects = ["mana"]) { return signTaskWriteCapability({ version: 1, audience: "mana-task-write", requestId: "Ev1", actor: { provider: "slack", id: actor, workspace: "T_TEAM" }, placementId: "mana-dev-biz", projects, operations: ["*"], expiresAt: Date.now() + 60_000, nonce: "n", budget: 3 }, secret); }
const env = { TASK_WRITE_CAPABILITY_SECRET: secret, SLACK_EXPECTED_TEAM_ID: "T_TEAM", RUNTIME_PLACEMENTS_JSON: placements, BRAINBASE_TASK_API_BASE_URL: "https://tasks.example.com", BRAINBASE_TASK_API_TOKEN: "task-token", SLACK_BOT_TOKEN: "slack-token", RUNTIME_EMPLOYEES_JSON: JSON.stringify([{ name: "critical-reviewer", persona: "private instructions", model: "opus" }]) };
const request = async (tool: string, args: Record<string, unknown>, token = capability()) => new Request("https://gateway.internal/api/runtime/gateway", { method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": await token }, body: JSON.stringify({ tool, arguments: args, request_id: "Ev1", call_index: 1 }) });

describe("runtime gateway proxy", () => {
  it("forces list_tasks to the placement project", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { expect(input instanceof Request ? input.url : String(input)).toContain("project_code=mana"); return Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"], assignee_person_id: null, assignee_display_name: null, due_at: null }], next_cursor: null }); });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", { limit: 10, project: "outside" }), env);
    expect(response.status).toBe(200);
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
    const listPlacement = placements.replace('"list_tasks","send_message"', '"list_tasks","send_message","list_employees","get_employee"');
    const list = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_employees", {}), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await list.json()).toEqual({ employees: [{ name: "critical-reviewer", model: "opus" }] });
    const get = await createRuntimeGatewayProxyHandler(vi.fn())(await request("get_employee", { name: "critical-reviewer" }), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await get.json()).toEqual({ name: "critical-reviewer", persona: "private instructions", model: "opus" });
  });
  it("reads sessions only from the placement registry object", async () => {
    const sessionPlacement = placements.replace('"list_tasks","send_message"', '"list_tasks","send_message","list_sessions","get_session"');
    const fetch = vi.fn(async () => Response.json({ sessions: [{ sessionId: "s1", placementId: "mana-dev-biz" }] }));
    const registry = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch })) };
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_sessions", { status: "active" }), { ...env, RUNTIME_PLACEMENTS_JSON: sessionPlacement, RUNTIME_SESSION_REGISTRY: registry });
    expect(response.status).toBe(200);
    expect(registry.idFromName).toHaveBeenCalledWith("mana-dev-biz");
    expect(fetch).toHaveBeenCalledWith("https://session-registry.internal/sessions?status=active");
  });
});
