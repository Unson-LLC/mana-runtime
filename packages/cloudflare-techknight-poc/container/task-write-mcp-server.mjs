import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://task-write.internal/api/task-write";
const common = { project: { type: "string" }, call_index: { type: "integer", minimum: 1, maximum: 3 } };
export const taskWriteTools = [
  { name: "create_task", description: "許可projectにBrainbaseタスクを作成します。", inputSchema: { type: "object", additionalProperties: false, required: ["project","call_index","title"], properties: { ...common, title: { type: "string" }, description: { type: "string" }, priority: { enum: ["low","medium","high","urgent"] }, assignee_person_id: { type: "string" }, due_at: { type: "string" } } } },
  { name: "update_task", description: "Brainbaseタスクを楽観ロック付きで更新します。", inputSchema: { type: "object", additionalProperties: false, required: ["project","call_index","task_id","expected_version"], properties: { ...common, task_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, title: { type: "string" }, description: { type: "string" }, priority: { enum: ["low","medium","high","urgent"] }, assignee_person_id: { type: ["string","null"] }, due_at: { type: "string" } } } },
  { name: "transition_task", description: "Brainbaseタスクの状態を楽観ロック付きで遷移します。", inputSchema: { type: "object", additionalProperties: false, required: ["project","call_index","task_id","expected_version","to_status"], properties: { ...common, task_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, to_status: { enum: ["pending","in_progress","waiting","completed"] }, waiting_on: { type: "string" }, review_at: { type: "string" } } } },
];
const error = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
export async function processTaskWriteRpcMessage(message, fetchImpl = fetch) {
  if (!message || message.jsonrpc !== "2.0") return error(message?.id, -32600, "Invalid Request");
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id ?? null, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mana-task-write", version: "1.0.0" } } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id ?? null, result: { tools: taskWriteTools } };
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id ?? null, result: {} };
  if (message.method !== "tools/call") return error(message.id, -32601, "Method not found");
  const index = taskWriteTools.findIndex((tool) => tool.name === message.params?.name);
  if (index < 0 || !message.params?.arguments || typeof message.params.arguments !== "object") return error(message.id, -32602, "Invalid params");
  const args = message.params.arguments;
  const requestId = process.env.MANA_TASK_WRITE_REQUEST_ID;
  const capability = process.env.MANA_TASK_WRITE_CAPABILITY;
  if (!requestId || !capability) return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ error: "task_write_not_configured" }) }], isError: true } };
  const operation = ["create","update","transition"][index];
  const response = await fetchImpl(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": capability }, body: JSON.stringify({ ...args, request_id: requestId, operation }), redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({ error: "task_write_invalid_response" })) : { error: "task_write_unavailable" };
  return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !response?.ok } };
}
async function run() { const lines = createInterface({ input: process.stdin, crlfDelay: Infinity }); for await (const line of lines) { let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(error(null,-32700,"Parse error"))}\n`); continue; } const response = await processTaskWriteRpcMessage(msg); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(() => { process.exitCode = 1; });
