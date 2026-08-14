import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The production MCP server is an executable ESM module.
import { processGatewayRpcMessage } from "../../container/gateway-mcp-server.mjs";

describe("gateway MCP", () => {
  afterEach(() => { delete process.env.MANA_ALLOWED_GATEWAY_TOOLS; delete process.env.MANA_TASK_WRITE_REQUEST_ID; delete process.env.MANA_TASK_WRITE_CAPABILITY; });
  it("exposes only placement-allowed tools", async () => {
    process.env.MANA_ALLOWED_GATEWAY_TOOLS = JSON.stringify(["list_tasks", "get_employee"]);
    const result = await processGatewayRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(result.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_tasks", "get_employee"]);
  });
  it("forwards requester capability without accepting a model project", async () => {
    process.env.MANA_ALLOWED_GATEWAY_TOOLS = JSON.stringify(["list_tasks"]);
    process.env.MANA_TASK_WRITE_REQUEST_ID = "Ev1";
    process.env.MANA_TASK_WRITE_CAPABILITY = "signed";
    const fetchImpl = vi.fn(async (_url, init) => Response.json({ ok: true, received: JSON.parse(String(init?.body)) }));
    const result = await processGatewayRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tasks", arguments: { limit: 10, project: "outside" } } }, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://gateway.internal/api/runtime/gateway", expect.objectContaining({ headers: expect.objectContaining({ "x-mana-task-write-capability": "signed" }) }));
    expect(JSON.parse((result.result.content[0] as { text: string }).text).received).toEqual({ tool: "list_tasks", arguments: { limit: 10, project: "outside" }, request_id: "Ev1", call_index: 0 });
  });
});
