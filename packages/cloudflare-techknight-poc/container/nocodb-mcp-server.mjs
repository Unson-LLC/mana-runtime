import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://nocodb.internal/api/runtime/nocodb";
const definitions = [
  ["nocodb_list_bases", [], {}],
  ["nocodb_list_tables", ["baseId"], { baseId: { type: "string" } }],
  ["nocodb_list_records", ["baseId", "tableName"], {
    baseId: { type: "string" }, tableName: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0 }, where: { type: "string" }, sort: { type: "string" },
    fields: { type: "array", items: { type: "string" } },
  }],
  ["nocodb_get_record", ["baseId", "tableName", "recordId"], {
    baseId: { type: "string" }, tableName: { type: "string" }, recordId: { type: "string" },
  }],
  ["nocodb_create_record", ["baseId", "tableName", "fields"], {
    baseId: { type: "string" }, tableName: { type: "string" }, fields: { type: "object" },
  }],
  ["nocodb_update_record", ["baseId", "tableName", "recordId", "fields"], {
    baseId: { type: "string" }, tableName: { type: "string" }, recordId: { type: "string" }, fields: { type: "object" },
  }],
  ["nocodb_delete_record", ["baseId", "tableName", "recordId"], {
    baseId: { type: "string" }, tableName: { type: "string" }, recordId: { type: "string" },
  }],
  ["nocodb_get_table_meta", ["tableId"], { tableId: { type: "string" } }],
  ["nocodb_update_column", ["columnId", "colOptions"], {
    columnId: { type: "string" }, colOptions: { type: "object" },
  }],
].map(([name, required, properties]) => ({
  name,
  description: `${name} through the placement-scoped NocoDB connection`,
  inputSchema: { type: "object", additionalProperties: false, required, properties },
}));

const names = new Set(definitions.map((tool) => tool.name));
const error = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(name, args, fetchImpl) {
  if (!names.has(name) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid_arguments");
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MANA_TENANT_BOUNDARY_HANDLE ? {
          "x-mana-tenant-boundary-handle": process.env.MANA_TENANT_BOUNDARY_HANDLE,
        } : {}),
      },
      body: JSON.stringify({ tool: name, arguments: args }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { content: [{ type: "text", text: JSON.stringify({ error: "nocodb_unavailable" }) }], isError: true };
  }
  const payload = await response.json().catch(() => ({ error: "nocodb_invalid_response" }));
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !response.ok };
}

export async function processNocodbRpcMessage(message, fetchImpl = fetch) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(message?.id, -32600, "Invalid Request");
  if (message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id ?? null, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mana-nocodb", version: "1.0.0" } } };
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id ?? null, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id ?? null, result: { tools: definitions } };
  if (message.method === "tools/call") {
    try {
      return { jsonrpc: "2.0", id: message.id ?? null, result: await callTool(message.params?.name, message.params?.arguments, fetchImpl) };
    } catch { return error(message.id, -32602, "Invalid params"); }
  }
  return error(message.id, -32601, "Method not found");
}

async function run() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(error(null, -32700, "Parse error"))}\n`); continue; }
    const response = await processNocodbRpcMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(() => { process.exitCode = 1; });
