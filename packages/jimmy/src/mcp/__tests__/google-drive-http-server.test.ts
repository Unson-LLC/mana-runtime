import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { handleGoogleDriveMcpHttpRequest } from "../google-drive-http-server.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function serve(token: string): Promise<string> {
  const server = createServer((request, response) => void handleGoogleDriveMcpHttpRequest(request, response, token));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

describe("Google Drive MCP HTTP server", () => {
  it("rejects missing authorization", async () => {
    const base = await serve("secret");
    expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("returns the complete Drive tool catalog to an authorized MCP client", async () => {
    const base = await serve("secret");
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "auth_status", "list_files", "get_file", "create_folder", "create_file", "upload_file",
      "create_spreadsheet", "write_sheet_values", "get_sheet_values",
    ]);
  });
});
