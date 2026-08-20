import { describe, expect, it, vi } from "vitest";
import { processNocodbRpcMessage } from "../../container/nocodb-mcp-server.mjs";

describe("NocoDB MCP discovery tools", () => {
  it("exposes bounded base and table discovery", async () => {
    const result = await processNocodbRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = result.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("nocodb_list_bases");
    expect(names).toContain("nocodb_list_tables");
  });

  it("proxies discovery calls without requiring guessed identifiers", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ bases: [{ baseId: "app_mana" }] }));
    const result = await processNocodbRpcMessage({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "nocodb_list_bases", arguments: {} },
    }, fetchImpl as unknown as typeof fetch);
    expect(result.result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
