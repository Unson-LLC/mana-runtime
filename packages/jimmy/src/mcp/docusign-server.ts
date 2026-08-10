#!/usr/bin/env node
/** Account-pinned DocuSign eSignature MCP adapter for contract-ledger sync. */

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface JsonRpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string } }
interface DocuSignSession { accessToken: string; accountId: string; baseUri: string; userName?: string; userEmail?: string }

export const CONTRACT_LEDGER_HEADERS = [
  "管理番号", "契約書名", "契約種別", "契約先", "自社名義", "社内担当者",
  "契約ステータス", "締結日", "契約開始日", "契約終了日", "自動更新",
  "解約通知期限", "更新確認日", "契約金額（税込）", "支払条件", "原本URL",
  "電子契約サービス", "備考",
] as const;

const AUTH_SERVER = process.env.DOCUSIGN_AUTH_SERVER || "account.docusign.com";
const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY || "";
const USER_ID = process.env.DOCUSIGN_USER_ID || "";
const EXPECTED_ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID || "";
const EXPECTED_USER_EMAIL = process.env.DOCUSIGN_EXPECTED_USER_EMAIL || "info@unson.jp";
const PRIVATE_KEY_PATH = process.env.DOCUSIGN_PRIVATE_KEY_PATH || "";
const PRIVATE_KEY_BASE64 = process.env.DOCUSIGN_PRIVATE_KEY_BASE64 || "";
const STATIC_ACCESS_TOKEN = process.env.DOCUSIGN_ACCESS_TOKEN || "";

let cachedSession: { value: DocuSignSession; expiresAt: number } | undefined;

export const DOCUSIGN_TOOLS = [
  { name: "auth_status", description: "Verify the configured DocuSign user and account without exposing credentials.", inputSchema: { type: "object" as const, properties: {} } },
  {
    name: "list_envelopes",
    description: "List DocuSign envelopes for the contract ledger. Paginate with startPosition.",
    inputSchema: { type: "object" as const, properties: {
      fromDate: { type: "string", description: "ISO date/time; defaults to 2000-01-01T00:00:00Z" },
      toDate: { type: "string", description: "Optional ISO date/time" }, status: { type: "string" },
      searchText: { type: "string" }, count: { type: "number", minimum: 1, maximum: 100, default: 100 },
      startPosition: { type: "number", minimum: 0, default: 0 }, include: { type: "string" },
    } },
  },
  {
    name: "list_contract_ledger_rows",
    description: "List envelopes as rows matching the existing Japanese Google Sheets contract ledger. 管理番号 is the immutable DocuSign envelopeId.",
    inputSchema: { type: "object" as const, properties: {
      fromDate: { type: "string", description: "ISO date/time; defaults to 2000-01-01T00:00:00Z" },
      toDate: { type: "string", description: "Optional ISO date/time" }, status: { type: "string" },
      count: { type: "number", minimum: 1, maximum: 100, default: 100 },
      startPosition: { type: "number", minimum: 0, default: 0 },
    } },
  },
  { name: "get_envelope", description: "Get one envelope's contract metadata and status.", inputSchema: { type: "object" as const, properties: { envelopeId: { type: "string" }, include: { type: "string" } }, required: ["envelopeId"] } },
  { name: "list_recipients", description: "List signers and other recipients for one envelope.", inputSchema: { type: "object" as const, properties: { envelopeId: { type: "string" } }, required: ["envelopeId"] } },
  { name: "list_documents", description: "List documents belonging to one envelope (metadata only; no PDF content).", inputSchema: { type: "object" as const, properties: { envelopeId: { type: "string" } }, required: ["envelopeId"] } },
] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function requireNonEmptyString(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function base64Url(value: string | Buffer): string { return Buffer.from(value).toString("base64url"); }

async function loadPrivateKey(): Promise<string> {
  if (PRIVATE_KEY_BASE64) return Buffer.from(PRIVATE_KEY_BASE64, "base64").toString("utf8");
  if (PRIVATE_KEY_PATH) return readFile(PRIVATE_KEY_PATH, "utf8");
  throw new Error("DocuSign private key is not configured");
}

export function createJwtAssertion(integrationKey: string, userId: string, authServer: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: requireNonEmptyString(integrationKey, "integrationKey"), sub: requireNonEmptyString(userId, "userId"), aud: requireNonEmptyString(authServer, "authServer"), iat: nowSeconds, exp: nowSeconds + 3600, scope: "signature impersonation" }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function requestJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = {};
  if (text) { try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; } }
  if (!response.ok) {
    const error = asObject(body);
    throw new Error(`DocuSign API ${response.status}: ${String(error.error_description || error.message || error.error || response.statusText)}`);
  }
  return asObject(body);
}

function selectAccount(userInfo: Record<string, unknown>): Record<string, unknown> {
  const accounts = Array.isArray(userInfo.accounts) ? userInfo.accounts.map(asObject) : [];
  const account = EXPECTED_ACCOUNT_ID ? accounts.find((item) => item.account_id === EXPECTED_ACCOUNT_ID) : accounts.find((item) => item.is_default === true || item.is_default === "true") || accounts[0];
  if (!account) throw new Error("DocuSign user has no accessible account");
  if (EXPECTED_ACCOUNT_ID && account.account_id !== EXPECTED_ACCOUNT_ID) throw new Error(`DocuSign account mismatch: expected ${EXPECTED_ACCOUNT_ID}`);
  return account;
}

async function authenticate(): Promise<DocuSignSession> {
  if (cachedSession && cachedSession.expiresAt > Date.now() + 60_000) return cachedSession.value;
  let accessToken = STATIC_ACCESS_TOKEN;
  let expiresIn = 300;
  if (!accessToken) {
    const assertion = createJwtAssertion(INTEGRATION_KEY, USER_ID, AUTH_SERVER, await loadPrivateKey());
    const token = await requestJson(`https://${AUTH_SERVER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
    accessToken = requireNonEmptyString(token.access_token, "access_token");
    expiresIn = Number(token.expires_in || 3600);
  }
  const userInfo = await requestJson(`https://${AUTH_SERVER}/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
  const email = String(userInfo.email || "");
  if (EXPECTED_USER_EMAIL && email.toLowerCase() !== EXPECTED_USER_EMAIL.toLowerCase()) throw new Error(`DocuSign user mismatch: expected ${EXPECTED_USER_EMAIL}, got ${email || "unknown"}`);
  const account = selectAccount(userInfo);
  const session = { accessToken, accountId: requireNonEmptyString(account.account_id, "account_id"), baseUri: requireNonEmptyString(account.base_uri, "base_uri").replace(/\/$/, ""), userName: String(userInfo.name || "") || undefined, userEmail: email || undefined };
  cachedSession = { value: session, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
  return session;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function textValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function firstText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) { const value = textValue(record[key]); if (value) return value; }
  return "";
}

function recipientNames(envelope: Record<string, unknown>): string {
  const recipients = asObject(envelope.recipients);
  const groups = ["signers", "carbonCopies", "certifiedDeliveries", "inPersonSigners"];
  const names = groups.flatMap((group) => Array.isArray(recipients[group]) ? (recipients[group] as unknown[]).map(asObject).map((recipient) => firstText(recipient, "name", "email")).filter(Boolean) : []);
  return [...new Set(names)].join("、");
}

export function envelopeToContractLedgerRow(value: unknown): string[] {
  const envelope = asObject(value);
  const envelopeId = requireNonEmptyString(envelope.envelopeId, "envelopeId");
  const status = firstText(envelope, "status");
  const completed = firstText(envelope, "completedDateTime", "statusChangedDateTime");
  const sender = asObject(envelope.sender);
  const senderName = firstText(sender, "userName", "name", "email");
  const note = [senderName ? `DocuSign送信者: ${senderName}` : "", status === "voided" ? firstText(envelope, "voidedReason") : ""].filter(Boolean).join(" / ");
  return [
    envelopeId,
    firstText(envelope, "emailSubject", "envelopeName"),
    "",
    recipientNames(envelope),
    "",
    "",
    status,
    status === "completed" ? completed : "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    `https://app.docusign.com/documents/details/${encodeURIComponent(envelopeId)}`,
    "DocuSign",
    note,
  ];
}

function envelopeUrl(session: DocuSignSession, suffix = ""): string { return `${session.baseUri}/restapi/v2.1/accounts/${encodeURIComponent(session.accountId)}/envelopes${suffix}`; }
async function apiGet(session: DocuSignSession, url: string): Promise<Record<string, unknown>> { return requestJson(url, { headers: { authorization: `Bearer ${session.accessToken}` } }); }

export async function handleDocuSignTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const session = await authenticate();
  if (name === "auth_status") return { authenticated: true, accountId: session.accountId, expectedAccountId: EXPECTED_ACCOUNT_ID || null, user: { name: session.userName, email: session.userEmail }, expectedUserEmail: EXPECTED_USER_EMAIL || null, baseUri: session.baseUri };
  if (name === "list_envelopes") {
    const query = new URLSearchParams({ from_date: String(args.fromDate || "2000-01-01T00:00:00Z"), count: String(integerInRange(args.count, 100, 1, 100)), start_position: String(integerInRange(args.startPosition, 0, 0, Number.MAX_SAFE_INTEGER)), order: "desc", order_by: "last_modified" });
    if (args.toDate) query.set("to_date", String(args.toDate)); if (args.status) query.set("status", String(args.status));
    if (args.searchText) query.set("search_text", String(args.searchText)); if (args.include) query.set("include", String(args.include));
    return apiGet(session, `${envelopeUrl(session)}?${query}`);
  }
  if (name === "list_contract_ledger_rows") {
    const query = new URLSearchParams({ from_date: String(args.fromDate || "2000-01-01T00:00:00Z"), count: String(integerInRange(args.count, 100, 1, 100)), start_position: String(integerInRange(args.startPosition, 0, 0, Number.MAX_SAFE_INTEGER)), order: "desc", order_by: "last_modified", include: "recipients" });
    if (args.toDate) query.set("to_date", String(args.toDate)); if (args.status) query.set("status", String(args.status));
    const result = await apiGet(session, `${envelopeUrl(session)}?${query}`);
    const envelopes = Array.isArray(result.envelopes) ? result.envelopes : [];
    return { headers: CONTRACT_LEDGER_HEADERS, rows: envelopes.map(envelopeToContractLedgerRow), resultSetSize: result.resultSetSize, totalSetSize: result.totalSetSize, nextUri: result.nextUri };
  }
  const envelopeId = encodeURIComponent(requireNonEmptyString(args.envelopeId, "envelopeId"));
  if (name === "get_envelope") { const query = new URLSearchParams(); if (args.include) query.set("include", String(args.include)); return apiGet(session, envelopeUrl(session, `/${envelopeId}${query.size ? `?${query}` : ""}`)); }
  if (name === "list_recipients") return apiGet(session, envelopeUrl(session, `/${envelopeId}/recipients`));
  if (name === "list_documents") return apiGet(session, envelopeUrl(session, `/${envelopeId}/documents`));
  throw new Error(`Unknown DocuSign tool: ${name}`);
}

function sendResponse(response: JsonRpcResponse): void { process.stdout.write(`${JSON.stringify(response)}\n`); }
async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;
  if (method === "notifications/initialized") return;
  if (method === "initialize") { sendResponse({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mana-docusign", version: "1.0.0" } } }); return; }
  if (method === "tools/list") { sendResponse({ jsonrpc: "2.0", id, result: { tools: DOCUSIGN_TOOLS } }); return; }
  if (method === "tools/call") {
    try { const result = await handleDocuSignTool(String(params?.name || ""), asObject(params?.arguments)); sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true } }); }
    return;
  }
  sendResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

export function startDocuSignMcpServer(): void {
  const rl = createInterface({ input: process.stdin }); const pendingRequests = new Set<Promise<void>>();
  rl.on("line", (line) => { try { const pending = handleRequest(JSON.parse(line) as JsonRpcRequest); pendingRequests.add(pending); void pending.finally(() => pendingRequests.delete(pending)); } catch { /* Ignore stdio noise. */ } });
  rl.on("close", () => void Promise.allSettled([...pendingRequests]).then(() => process.exit(0)));
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) startDocuSignMcpServer();
