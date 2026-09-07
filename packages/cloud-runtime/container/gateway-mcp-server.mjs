import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const GATEWAY_ENDPOINT = "https://gateway.internal/api/runtime/gateway";
const TASK_WRITE_ENDPOINT = "https://task-write.internal/api/task-write";
const TOOL_DEFINITIONS = Object.freeze([
  { name: "send_message", description: "許可されたSlack配送先へメッセージを送信します。", inputSchema: { type: "object", additionalProperties: false, required: ["connector", "channel", "text"], properties: { connector: { const: "slack" }, channel: { type: "string" }, text: { type: "string" }, thread: { type: "string" } } } },
  { name: "search_personal_kg", description: "本人のSlack DMからのみ利用できる個人ナレッジを検索します。", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 4000 }, limit: { type: "integer", minimum: 1, maximum: 50 } } } },
  { name: "register_personal_kg", description: "本人のSlack DMからのみ、本人専用ナレッジイベントを登録します。", inputSchema: { type: "object", additionalProperties: false, required: ["body", "body_hash"], properties: { body: { type: "string", minLength: 1 }, body_hash: { type: "string", minLength: 1 }, event_id: { type: "string", minLength: 1 }, source: { type: "object" }, source_pointer: { type: "object" }, parent_episode_id: { type: "string", minLength: 1 }, permission_snapshot: { type: "object" }, sensitivity: { type: "string", minLength: 1 }, occurred_at: { type: "string", minLength: 1 }, captured_at: { type: "string", minLength: 1 } } } },
  { name: "create_task", description: "許可projectにタスクを作成します。", inputSchema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, priority: { enum: ["low","medium","high","urgent"] }, assignee_person_id: { type: "string" }, due_at: { type: "string" } } } },
  { name: "list_tasks", description: "現在のチャンネルに許可されたprojectのタスクを最大20件一覧します。count_statusがexactでない限りtotal_countは正確な総件数とは限りません。", inputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" }, priority: { type: "string" }, assignee_person_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
  { name: "search_tasks", description: "現在のチャンネルに許可されたprojectのタスクを検索します。最大20件で、件数の意味はcount_statusで確認します。", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 }, status: { type: "string" }, priority: { type: "string" }, assignee_person_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
  { name: "list_authorized_task_channels", description: "現在の利用者がタスクを横断取得できるチャンネル名、ID、projectを一覧します。対象名が省略された全件横断依頼で先に使います。", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "list_tasks_across_channels", description: "明示的に許可された複数チャンネルのタスクを、チャンネル名またはIDで最大20件一覧します。対象projectはサーバー側で解決します。", inputSchema: { type: "object", additionalProperties: false, oneOf: [{ required: ["channel_ids"], not: { required: ["channel_names"] } }, { required: ["channel_names"], not: { required: ["channel_ids"] } }], properties: { channel_ids: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[A-Z0-9_]{2,32}$" } }, channel_names: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1 } }, status: { type: "string" }, priority: { type: "string" }, assignee_person_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
  { name: "search_tasks_across_channels", description: "明示的に許可された複数チャンネルのタスクを、チャンネル名またはIDで最大20件検索します。対象projectはサーバー側で解決します。", inputSchema: { type: "object", additionalProperties: false, required: ["query"], oneOf: [{ required: ["channel_ids"], not: { required: ["channel_names"] } }, { required: ["channel_names"], not: { required: ["channel_ids"] } }], properties: { channel_ids: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[A-Z0-9_]{2,32}$" } }, channel_names: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1 } }, query: { type: "string", minLength: 1, maxLength: 200 }, status: { type: "string" }, priority: { type: "string" }, assignee_person_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
  { name: "update_task", description: "タスクを楽観ロック付きで更新します。", inputSchema: { type: "object", additionalProperties: false, required: ["task_id","expected_version"], properties: { task_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, assignee_person_id: { type: ["string","null"] }, due_at: { type: "string" } } } },
  { name: "transition_task", description: "タスクの状態を遷移します。", inputSchema: { type: "object", additionalProperties: false, required: ["task_id","expected_version","to_status"], properties: { task_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, to_status: { enum: ["pending","in_progress","waiting","completed"] }, waiting_on: { type: "string" }, review_at: { type: "string" } } } },
  { name: "list_sessions", description: "このplacementの会話セッションを一覧します。", inputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } } } },
  { name: "get_session", description: "このplacementの会話セッションを取得します。", inputSchema: { type: "object", additionalProperties: false, required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
  { name: "list_employees", description: "利用可能な従業員を一覧します。", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "get_employee", description: "従業員を名前で取得します。", inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } } },
]);

function configuredTools() {
  try {
    const allowed = JSON.parse(process.env.MANA_ALLOWED_GATEWAY_TOOLS ?? "[]");
    if (!Array.isArray(allowed)) return [];
    return TOOL_DEFINITIONS.filter((tool) => allowed.includes(tool.name));
  } catch { return []; }
}
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(name, args, fetchImpl, state) {
  const requestId = process.env.MANA_TASK_WRITE_REQUEST_ID;
  const capability = process.env.MANA_TASK_WRITE_CAPABILITY;
  if (!requestId || !capability) return { content: [{ type: "text", text: JSON.stringify({ error: "gateway_not_configured" }) }], isError: true };
  const endpoint = GATEWAY_ENDPOINT;
  if (["create_task","update_task","transition_task"].includes(name)) state.writeCalls += 1;
  const body = { tool: name, arguments: args, request_id: requestId, call_index: state.writeCalls };
  const response = await fetchImpl(endpoint, { method: "POST", headers: {
    "content-type": "application/json",
    "x-mana-task-write-capability": capability,
    ...(process.env.MANA_TENANT_BOUNDARY_HANDLE ? {
      "x-mana-tenant-boundary-handle": process.env.MANA_TENANT_BOUNDARY_HANDLE,
    } : {}),
  }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({ error: "gateway_invalid_response" })) : { error: "gateway_unavailable" };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !response?.ok };
}

export async function processGatewayRpcMessage(message, fetchImpl = fetch, state = { calls: 0, writeCalls: 0 }) {
  if (!message || message.jsonrpc !== "2.0") return rpcError(message?.id, -32600, "Invalid Request");
  if (message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id ?? null, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mana-gateway", version: "1.0.0" } } };
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id ?? null, result: {} };
  const tools = configuredTools();
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id ?? null, result: { tools } };
  if (message.method !== "tools/call") return rpcError(message.id, -32601, "Method not found");
  const tool = tools.find((candidate) => candidate.name === message.params?.name);
  if (!tool || !message.params?.arguments || typeof message.params.arguments !== "object" || Array.isArray(message.params.arguments)) return rpcError(message.id, -32602, "Invalid params");
  if (state.calls++ >= 10) return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: JSON.stringify({ error: "gateway_call_limit_exceeded" }) }], isError: true } };
  return { jsonrpc: "2.0", id: message.id ?? null, result: await callTool(tool.name, message.params.arguments, fetchImpl, state) };
}

async function run() { const lines = createInterface({ input: process.stdin, crlfDelay: Infinity }); const state = { calls: 0, writeCalls: 0 }; for await (const line of lines) { let message; try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(rpcError(null,-32700,"Parse error"))}\n`); continue; } const response = await processGatewayRpcMessage(message, fetch, state); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); } }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(() => { process.exitCode = 1; });
