#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { GOOGLE_DRIVE_TOOLS, handleGoogleDriveTool } from "./google-drive-server.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown };
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 25 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
}

export async function handleGoogleDriveMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bearerToken = process.env.MCP_HTTP_BEARER_TOKEN || "",
): Promise<void> {
  const authorization = request.headers.authorization || "";
  if (!bearerToken || authorization !== `Bearer ${bearerToken}`) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  let rpc: JsonRpcRequest;
  try {
    rpc = await readJson(request);
  } catch {
    sendJson(response, 400, { error: "invalid_json" });
    return;
  }
  const id = rpc.id ?? null;
  if (rpc.method === "notifications/initialized") {
    response.writeHead(202, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (rpc.method === "initialize") {
    sendJson(response, 200, { jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mana-google-drive", version: "1.3.0" },
    } });
    return;
  }
  if (rpc.method === "tools/list") {
    sendJson(response, 200, { jsonrpc: "2.0", id, result: { tools: GOOGLE_DRIVE_TOOLS } });
    return;
  }
  if (rpc.method === "tools/call") {
    try {
      const args = rpc.params?.arguments;
      const result = await handleGoogleDriveTool(
        typeof rpc.params?.name === "string" ? rpc.params.name : "",
        args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {},
      );
      sendJson(response, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 200, { jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: `Error: ${message}` }], isError: true,
      } });
    }
    return;
  }
  sendJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

export function startGoogleDriveMcpHttpServer(): void {
  const port = Number(process.env.MCP_HTTP_PORT || "31015");
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  createServer((request, response) => {
    void handleGoogleDriveMcpHttpRequest(request, response).catch(() => sendJson(response, 500, { error: "internal_error" }));
  }).listen(port, host, () => process.stderr.write(`Google Drive MCP HTTP listening on ${host}:${port}\n`));
}

if (import.meta.url === `file://${process.argv[1]}`) startGoogleDriveMcpHttpServer();
