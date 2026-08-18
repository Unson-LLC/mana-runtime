export const CONTRACT_LEDGER_SYNC_KIND = "contract_ledger_sync" as const;
export const CONTRACT_LEDGER_APPROVAL_KIND = "contract_ledger_approval" as const;
export const CONTRACT_LEDGER_APPROVE_ACTION_ID = "mana_contract_ledger_approve";
export const CONTRACT_LEDGER_REJECT_ACTION_ID = "mana_contract_ledger_reject";

export type ContractLedgerWriteMode = "audit" | "existing" | "full";

export interface ContractLedgerSyncEvent {
  kind: typeof CONTRACT_LEDGER_SYNC_KIND;
  runId: string;
  fromDate: string;
  targetAt: string;
  idempotencyKey: string;
}

export interface ContractLedgerCandidateEvent {
  kind: "contract_ledger_candidate";
  runId: string;
  envelope: ContractEnvelope;
  proposedRow: string[];
}

export interface ContractLedgerApprovalEvent {
  kind: typeof CONTRACT_LEDGER_APPROVAL_KIND;
  runId: string;
  envelopeId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export interface ContractLedgerSyncReceipt {
  runId: string;
  idempotencyKey: string;
  targetFrom: string;
  targetTo: string;
  mode: ContractLedgerWriteMode;
  status: "succeeded" | "partial" | "failed" | "already_completed";
  fetchedCount: number;
  updatedCount: number;
  candidateCount: number;
  excludedCount: number;
  failedCount: number;
  envelopeIds: string[];
  ledgerResults: Array<{ envelopeId: string; outcome: string; rowNumber?: number }>;
  failures: Array<{ stage: string; envelopeId?: string; reason: string }>;
  startedAt: string;
  finishedAt: string;
}

export interface ContractEnvelope {
  envelopeId: string;
  status: string;
  subject: string;
  senderEmail: string;
  counterparty: string;
  sentAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface ContractLedgerConfig {
  enabled: boolean;
  writeMode: ContractLedgerWriteMode;
  spreadsheetId: string;
  sheetName: string;
  legalChannelId: string;
  fromDate: string;
  approverUserIds: ReadonlySet<string>;
}

export interface ContractLedgerEnvironment {
  CONTRACT_LEDGER_ENABLED?: string;
  CONTRACT_LEDGER_WRITE_MODE?: string;
  CONTRACT_LEDGER_SPREADSHEET_ID?: string;
  CONTRACT_LEDGER_SHEET_NAME?: string;
  CONTRACT_LEDGER_LEGAL_CHANNEL_ID?: string;
  CONTRACT_LEDGER_FROM_DATE?: string;
  CONTRACT_LEDGER_APPROVER_USER_IDS?: string;
  CONTRACT_LEDGER_TRIGGER_TOKEN?: string;
  DOCUSIGN_INTEGRATION_KEY?: string;
  DOCUSIGN_USER_ID?: string;
  DOCUSIGN_RSA_PRIVATE_KEY_BASE64?: string;
  DOCUSIGN_AUTH_SERVER?: string;
  DOCUSIGN_EXPECTED_EMAIL?: string;
  DOCUSIGN_ACCOUNT_ID?: string;
  DOCUSIGN_BASE_URI?: string;
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  CONTRACT_LEDGER_SYNCS: Queue<ContractLedgerSyncEvent | ContractLedgerApprovalEvent>;
  CONTRACT_LEDGER_STATE: { idFromName(name: string): unknown; get(id: unknown): ContractLedgerStateStore };
}

export interface CandidateRecord {
  event: ContractLedgerCandidateEvent;
  status: "pending" | "applying" | "approved" | "rejected";
  notifiedAt?: string;
  messageTs?: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

export class ContractLedgerStateStore {
  constructor(private readonly state: { storage: DurableObjectStorage }) {}

  async claimRun(key: string): Promise<"claimed" | "completed" | "in_progress"> {
    return this.state.storage.transaction(async (tx) => {
      const current = await tx.get<{ status: string; claimedAt?: string }>(`run:${key}`);
      if (current?.status === "completed") return "completed";
      const claimedAt = current?.claimedAt ? new Date(current.claimedAt).getTime() : Number.NaN;
      if (current?.status === "running" && Number.isFinite(claimedAt) && Date.now() - claimedAt < 5 * 60_000) {
        return "in_progress";
      }
      await tx.put(`run:${key}`, { status: "running", claimedAt: new Date().toISOString() });
      return "claimed";
    });
  }

  async completeRun(key: string, receipt: ContractLedgerSyncReceipt): Promise<void> {
    await this.state.storage.put({ [`run:${key}`]: { status: "completed", receipt }, "last-receipt": receipt,
      "last-success-position": receipt.targetTo });
  }

  async failRun(key: string, receipt: ContractLedgerSyncReceipt): Promise<void> {
    await this.state.storage.put({ [`run:${key}`]: { status: "failed", receipt }, "last-receipt": receipt });
  }

  async releaseRun(key: string): Promise<void> {
    const current = await this.state.storage.get<{ status: string }>(`run:${key}`);
    if (current?.status === "running") await this.state.storage.delete(`run:${key}`);
  }

  async saveCandidate(candidate: ContractLedgerCandidateEvent): Promise<{ created: boolean; record: CandidateRecord }> {
    return this.state.storage.transaction(async (tx) => {
      const key = `candidate:${candidate.envelope.envelopeId}`;
      const existing = await tx.get<CandidateRecord>(key);
      if (existing) return { created: false, record: existing };
      const record: CandidateRecord = { event: candidate, status: "pending" };
      await tx.put(key, record);
      return { created: true, record };
    });
  }

  async markCandidateNotified(envelopeId: string, messageTs: string): Promise<void> {
    const key = `candidate:${envelopeId}`;
    const current = await this.state.storage.get<CandidateRecord>(key);
    if (!current) throw new Error("contract_candidate_missing");
    await this.state.storage.put(key, { ...current, notifiedAt: new Date().toISOString(), messageTs });
  }

  async candidate(envelopeId: string): Promise<CandidateRecord | undefined> {
    return this.state.storage.get<CandidateRecord>(`candidate:${envelopeId}`);
  }

  async claimDecision(event: ContractLedgerApprovalEvent): Promise<{ apply: boolean; record: CandidateRecord }> {
    return this.state.storage.transaction(async (tx) => {
      const key = `candidate:${event.envelopeId}`;
      const current = await tx.get<CandidateRecord>(key);
      if (!current) throw new Error("contract_candidate_missing");
      if (current.status === "approved" || current.status === "rejected") return { apply: false, record: current };
      const next: CandidateRecord = { ...current, status: event.decision === "approved" ? "applying" : "rejected",
        decidedBy: event.decidedBy, decidedAt: event.decidedAt, reason: event.reason };
      await tx.put(key, next);
      return { apply: event.decision === "approved", record: next };
    });
  }

  async completeApproval(envelopeId: string): Promise<void> {
    const key = `candidate:${envelopeId}`;
    const current = await this.state.storage.get<CandidateRecord>(key);
    if (!current) throw new Error("contract_candidate_missing");
    await this.state.storage.put(key, { ...current, status: "approved" });
  }
}

export function contractLedgerConfig(env: ContractLedgerEnvironment): ContractLedgerConfig {
  const rawMode = env.CONTRACT_LEDGER_WRITE_MODE?.trim();
  const writeMode: ContractLedgerWriteMode = rawMode === "existing" || rawMode === "full" ? rawMode : "audit";
  return {
    enabled: env.CONTRACT_LEDGER_ENABLED === "true",
    writeMode,
    spreadsheetId: env.CONTRACT_LEDGER_SPREADSHEET_ID?.trim() ?? "",
    sheetName: env.CONTRACT_LEDGER_SHEET_NAME?.trim() || "契約台帳",
    legalChannelId: env.CONTRACT_LEDGER_LEGAL_CHANNEL_ID?.trim() ?? "",
    fromDate: env.CONTRACT_LEDGER_FROM_DATE?.trim() || `${new Date().getUTCFullYear()}-01-01`,
    approverUserIds: new Set((env.CONTRACT_LEDGER_APPROVER_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
  };
}

export function isContractLedgerEvent(value: unknown): value is ContractLedgerSyncEvent | ContractLedgerApprovalEvent {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === CONTRACT_LEDGER_SYNC_KIND || kind === CONTRACT_LEDGER_APPROVAL_KIND;
}

export function scheduledContractLedgerEvent(now = new Date(), fromDate?: string): ContractLedgerSyncEvent {
  const targetAt = now.toISOString();
  const day = targetAt.slice(0, 10);
  return { kind: CONTRACT_LEDGER_SYNC_KIND, runId: `contract-ledger-${day}`,
    fromDate: fromDate || `${now.getUTCFullYear()}-01-01`, targetAt, idempotencyKey: `contract-ledger:${day}` };
}

export async function enqueueScheduledContractLedgerSync(
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: ContractLedgerEnvironment,
): Promise<boolean> {
  const config = contractLedgerConfig(env);
  if (controller.cron !== "0 0 * * 1-5" || !config.enabled) return false;
  await env.CONTRACT_LEDGER_SYNCS.send(scheduledContractLedgerEvent(new Date(controller.scheduledTime), config.fromDate));
  return true;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function privateKeyBytes(encoded: string): Uint8Array {
  const normalized = encoded.includes("BEGIN")
    ? encoded.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "")
    : encoded.replace(/\s/g, "");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

export async function createDocuSignJwt(env: ContractLedgerEnvironment, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!env.DOCUSIGN_INTEGRATION_KEY || !env.DOCUSIGN_USER_ID || !env.DOCUSIGN_RSA_PRIVATE_KEY_BASE64) {
    throw new Error("docusign_jwt_not_configured");
  }
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iss: env.DOCUSIGN_INTEGRATION_KEY,
    sub: env.DOCUSIGN_USER_ID, aud: env.DOCUSIGN_AUTH_SERVER || "account.docusign.com",
    iat: nowSeconds, exp: nowSeconds + 3600, scope: "signature impersonation" })));
  const input = `${header}.${payload}`;
  const keyBytes = privateKeyBytes(env.DOCUSIGN_RSA_PRIVATE_KEY_BASE64);
  const keyData = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("pkcs8", keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64Url(signature)}`;
}

async function docusignContext(env: ContractLedgerEnvironment, fetchImpl: typeof fetch): Promise<{ token: string; accountId: string; baseUri: string }> {
  const authServer = env.DOCUSIGN_AUTH_SERVER || "account.docusign.com";
  const jwt = await createDocuSignJwt(env);
  const tokenResponse = await fetchImpl(`https://${authServer}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const tokenBody = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(`docusign_auth_failed:${tokenBody.error || tokenResponse.status}`);
  const userResponse = await fetchImpl(`https://${authServer}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokenBody.access_token}` } });
  const user = await userResponse.json() as { email?: string; accounts?: Array<{ account_id: string; base_uri: string; is_default?: boolean }> };
  if (!userResponse.ok) throw new Error(`docusign_userinfo_failed:${userResponse.status}`);
  if ((env.DOCUSIGN_EXPECTED_EMAIL || "info@unson.jp").toLowerCase() !== user.email?.toLowerCase()) {
    throw new Error("docusign_expected_email_mismatch");
  }
  const account = user.accounts?.find((item) => item.account_id === env.DOCUSIGN_ACCOUNT_ID) ??
    user.accounts?.find((item) => item.is_default) ?? user.accounts?.[0];
  const accountId = env.DOCUSIGN_ACCOUNT_ID || account?.account_id;
  const baseUri = env.DOCUSIGN_BASE_URI || account?.base_uri;
  if (!accountId || !baseUri) throw new Error("docusign_account_missing");
  return { token: tokenBody.access_token, accountId, baseUri };
}

export async function fetchAllContractEnvelopes(env: ContractLedgerEnvironment, fromDate: string,
  fetchImpl: typeof fetch = fetch): Promise<ContractEnvelope[]> {
  const context = await docusignContext(env, fetchImpl);
  const envelopes: ContractEnvelope[] = [];
  let startPosition = 0;
  for (;;) {
    const query = new URLSearchParams({ from_date: fromDate, count: "100", start_position: String(startPosition),
      order: "desc", order_by: "last_modified", include: "recipients" });
    const response = await fetchImpl(`${context.baseUri}/restapi/v2.1/accounts/${context.accountId}/envelopes?${query}`,
      { headers: { authorization: `Bearer ${context.token}` } });
    const body = await response.json() as { envelopes?: Array<Record<string, any>>; nextUri?: string };
    if (!response.ok) throw new Error(`docusign_envelopes_failed:${response.status}`);
    const page = body.envelopes ?? [];
    envelopes.push(...page.map((item) => {
      const senderEmail = String(item.sender?.email ?? "");
      const signers = Array.isArray(item.recipients?.signers) ? item.recipients.signers as Array<Record<string, unknown>> : [];
      const counterparty = signers.find((signer) => String(signer.email ?? "").toLowerCase() !== senderEmail.toLowerCase());
      return { envelopeId: String(item.envelopeId ?? ""), status: String(item.status ?? ""),
        subject: String(item.emailSubject ?? ""), senderEmail, counterparty: String(counterparty?.name ?? "未確認"),
        sentAt: item.sentDateTime, completedAt: item.completedDateTime, updatedAt: item.lastModifiedDateTime };
    }));
    if (!body.nextUri || page.length === 0) break;
    startPosition += page.length;
  }
  return envelopes;
}

function cleanSubject(subject = ""): string { return subject.replace(/^Docusignで送信:\s*/i, "").trim(); }
export function inferContractType(subject = ""): string {
  if (/債務確認|返済合意/.test(subject)) return "債務確認・返済合意";
  if (/借用書/.test(subject)) return "借用書";
  if (/業務委託/.test(subject) && /変更覚書/.test(subject)) return "業務委託・変更覚書";
  if (/業務委託/.test(subject)) return "業務委託";
  return "未確認";
}
export function contractStatusLabel(status: string): string {
  if (status === "completed") return "完了";
  if (status === "voided") return "取消";
  if (["sent", "delivered", "created"].includes(status)) return "署名が必要";
  return status || "未確認";
}
export function formatContractLedgerDate(value?: string): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric",
    day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}/${Number(values.month)}/${Number(values.day)} ${Number(values.hour)}:${values.minute}`;
}

export function buildContractLedgerPlan(ledgerValues: string[][], envelopes: ContractEnvelope[], year: number) {
  const rowsByEnvelope = new Map<string, { row: string[]; rowNumber: number }>();
  ledgerValues.slice(1).forEach((row, index) => { if (row[1]) rowsByEnvelope.set(row[1], { row, rowNumber: index + 2 }); });
  let sequence = ledgerValues.slice(1).reduce((max, row) => {
    const match = String(row[0] || "").match(new RegExp(`^DS-${year}-(\\d+)$`)); return Math.max(max, Number(match?.[1] ?? 0));
  }, 0) + 1;
  const updates: Array<{ envelopeId: string; rowNumber: number; status: string; updatedAt: string }> = [];
  const candidates: ContractLedgerCandidateEvent[] = [];
  const excluded: string[] = [];
  for (const envelope of envelopes) {
    if (!envelope.envelopeId || /\btest\b|テスト/i.test(envelope.subject)) { excluded.push(envelope.envelopeId); continue; }
    const status = contractStatusLabel(envelope.status);
    const updatedAt = formatContractLedgerDate(envelope.completedAt || envelope.updatedAt || envelope.sentAt);
    const existing = rowsByEnvelope.get(envelope.envelopeId);
    if (existing) {
      if (existing.row[5] !== status || existing.row[6] !== updatedAt) updates.push({ envelopeId: envelope.envelopeId,
        rowNumber: existing.rowNumber, status, updatedAt });
      continue;
    }
    if (envelope.status === "voided") { excluded.push(envelope.envelopeId); continue; }
    const subject = cleanSubject(envelope.subject);
    const row = [`DS-${year}-${String(sequence++).padStart(3, "0")}`, envelope.envelopeId,
      envelope.counterparty || "未確認", subject, inferContractType(subject), status, updatedAt,
      `=HYPERLINK("https://apps.docusign.com/send/documents/details/${envelope.envelopeId}","DocuSignで開く")`,
      "", "", "", "KEIGO SATO", "", "一部要確認", "法務チャンネル承認後にDocuSignから登録"];
    candidates.push({ kind: "contract_ledger_candidate", runId: "", envelope, proposedRow: row });
  }
  return { updates, candidates, excluded };
}

async function mcpTool(env: ContractLedgerEnvironment, name: string, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<any> {
  if (!env.GOOGLE_DRIVE_MCP_BASE_URL || !env.GOOGLE_DRIVE_MCP_TOKEN) throw new Error("contract_ledger_google_mcp_not_configured");
  const response = await fetchImpl(`${env.GOOGLE_DRIVE_MCP_BASE_URL.replace(/\/$/, "")}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${env.GOOGLE_DRIVE_MCP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json() as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(`contract_ledger_google_mcp_failed:${body.error?.message || response.status}`);
  const text = body.result?.content?.find((item) => item.text)?.text;
  return text ? JSON.parse(text) : body.result;
}

async function readLedger(env: ContractLedgerEnvironment, config: ContractLedgerConfig, fetchImpl: typeof fetch): Promise<string[][]> {
  const result = await mcpTool(env, "get_sheet_values", { spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A1:O10000` }, fetchImpl);
  const values = result?.values ?? result?.data?.values ?? [];
  if (!Array.isArray(values) || values[0]?.[1] !== "Envelope ID") throw new Error("contract_ledger_schema_mismatch");
  return values;
}

async function writeRange(env: ContractLedgerEnvironment, config: ContractLedgerConfig, range: string, values: string[][],
  fetchImpl: typeof fetch): Promise<void> {
  await mcpTool(env, "write_sheet_values", { spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!${range}`, values }, fetchImpl);
}

async function slackPost(env: ContractLedgerEnvironment, channel: string, text: string, blocks: unknown[] | undefined,
  fetchImpl: typeof fetch): Promise<string> {
  if (!env.SLACK_BOT_TOKEN) throw new Error("contract_ledger_slack_not_configured");
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", { method: "POST",
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ channel, text, ...(blocks ? { blocks } : {}) }) });
  const body = await response.json() as { ok?: boolean; ts?: string; error?: string };
  if (!response.ok || !body.ok || !body.ts) throw new Error(`contract_ledger_slack_failed:${body.error || response.status}`);
  return body.ts;
}

function candidateBlocks(candidate: ContractLedgerCandidateEvent): unknown[] {
  const envelope = candidate.envelope;
  const value = JSON.stringify({ envelopeId: envelope.envelopeId, runId: candidate.runId });
  return [{ type: "section", text: { type: "mrkdwn", text: `*新規契約の台帳追加承認*\n*件名:* ${envelope.subject || "未確認"}\n*取引先:* ${envelope.counterparty}\n*送信日:* ${formatContractLedgerDate(envelope.sentAt)}\n*状態:* ${contractStatusLabel(envelope.status)}\n*推定契約種別:* ${inferContractType(envelope.subject)}\n<https://apps.docusign.com/send/documents/details/${envelope.envelopeId}|DocuSignで確認>` } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "台帳へ追加" },
      action_id: CONTRACT_LEDGER_APPROVE_ACTION_ID, value }, { type: "button", style: "danger",
      text: { type: "plain_text", text: "除外" }, action_id: CONTRACT_LEDGER_REJECT_ACTION_ID, value }] }];
}

function stateStub(env: ContractLedgerEnvironment): ContractLedgerStateStore {
  return env.CONTRACT_LEDGER_STATE.get(env.CONTRACT_LEDGER_STATE.idFromName("unson-contract-ledger"));
}

export async function processContractLedgerSync(event: ContractLedgerSyncEvent, env: ContractLedgerEnvironment,
  fetchImpl: typeof fetch = fetch): Promise<ContractLedgerSyncReceipt> {
  const config = contractLedgerConfig(env); const state = stateStub(env); const startedAt = new Date().toISOString();
  const empty = (): ContractLedgerSyncReceipt => ({ runId: event.runId, idempotencyKey: event.idempotencyKey,
    targetFrom: event.fromDate, targetTo: event.targetAt, mode: config.writeMode, status: "succeeded", fetchedCount: 0,
    updatedCount: 0, candidateCount: 0, excludedCount: 0, failedCount: 0, envelopeIds: [], ledgerResults: [],
    failures: [], startedAt, finishedAt: new Date().toISOString() });
  const claim = await state.claimRun(event.idempotencyKey);
  if (claim === "completed") return { ...empty(), status: "already_completed" };
  if (claim === "in_progress") throw new Error("contract_ledger_run_in_progress");
  const receipt = empty();
  try {
    if (!config.spreadsheetId || !config.legalChannelId) throw new Error("contract_ledger_config_incomplete");
    const [ledger, envelopes] = await Promise.all([readLedger(env, config, fetchImpl), fetchAllContractEnvelopes(env, event.fromDate, fetchImpl)]);
    const plan = buildContractLedgerPlan(ledger, envelopes, Number(event.targetAt.slice(0, 4)));
    receipt.fetchedCount = envelopes.length; receipt.envelopeIds = envelopes.map((item) => item.envelopeId);
    receipt.excludedCount = plan.excluded.length; receipt.candidateCount = plan.candidates.length;
    for (const update of plan.updates) {
      if (config.writeMode === "audit") { receipt.ledgerResults.push({ envelopeId: update.envelopeId, outcome: "audit_update", rowNumber: update.rowNumber }); continue; }
      await writeRange(env, config, `F${update.rowNumber}:G${update.rowNumber}`, [[update.status, update.updatedAt]], fetchImpl);
      receipt.updatedCount += 1; receipt.ledgerResults.push({ envelopeId: update.envelopeId, outcome: "updated", rowNumber: update.rowNumber });
    }
    for (const rawCandidate of plan.candidates) {
      const candidate = { ...rawCandidate, runId: event.runId };
      if (config.writeMode !== "full") { receipt.ledgerResults.push({ envelopeId: candidate.envelope.envelopeId, outcome: "audit_candidate" }); continue; }
      const saved = await state.saveCandidate(candidate);
      if (!saved.created || saved.record.notifiedAt || saved.record.status !== "pending") {
        receipt.ledgerResults.push({ envelopeId: candidate.envelope.envelopeId, outcome: `candidate_${saved.record.status}` }); continue;
      }
      const messageTs = await slackPost(env, config.legalChannelId, `新規契約の承認が必要です: ${candidate.envelope.subject}`,
        candidateBlocks(candidate), fetchImpl);
      await state.markCandidateNotified(candidate.envelope.envelopeId, messageTs);
      receipt.ledgerResults.push({ envelopeId: candidate.envelope.envelopeId, outcome: "approval_pending" });
    }
    receipt.finishedAt = new Date().toISOString(); await state.completeRun(event.idempotencyKey, receipt); return receipt;
  } catch (error) {
    receipt.status = receipt.updatedCount || receipt.candidateCount ? "partial" : "failed"; receipt.failedCount += 1;
    receipt.failures.push({ stage: "sync", reason: error instanceof Error ? error.message : "unexpected_error" });
    receipt.finishedAt = new Date().toISOString(); await state.failRun(event.idempotencyKey, receipt);
    if (config.legalChannelId) await slackPost(env, config.legalChannelId,
      `:warning: 契約台帳同期に失敗しました\n実行ID: ${event.runId}\n理由: ${receipt.failures[0]?.reason}`, undefined, fetchImpl).catch(() => undefined);
    throw error;
  }
}

export async function processContractLedgerApproval(event: ContractLedgerApprovalEvent, env: ContractLedgerEnvironment,
  fetchImpl: typeof fetch = fetch): Promise<"applied" | "replayed" | "rejected"> {
  const config = contractLedgerConfig(env); const state = stateStub(env);
  const claim = await state.claimDecision(event);
  if (event.decision === "rejected") return "rejected";
  if (!claim.apply && claim.record.status === "approved") return "replayed";
  if (config.writeMode !== "full") throw new Error("contract_ledger_full_write_disabled");
  const ledger = await readLedger(env, config, fetchImpl);
  if (!ledger.slice(1).some((row) => row[1] === event.envelopeId)) {
    const year = new Date(claim.record.event.envelope.sentAt || event.decidedAt).getUTCFullYear();
    const next = ledger.slice(1).reduce((max, row) => {
      const match = String(row[0] || "").match(new RegExp(`^DS-${year}-(\\d+)$`));
      return Math.max(max, Number(match?.[1] ?? 0));
    }, 0) + 1;
    const row = [...claim.record.event.proposedRow];
    row[0] = `DS-${year}-${String(next).padStart(3, "0")}`;
    await writeRange(env, config, `A${ledger.length + 1}:O${ledger.length + 1}`, [row], fetchImpl);
    const verified = await readLedger(env, config, fetchImpl);
    if (!verified.slice(1).some((row) => row[1] === event.envelopeId)) throw new Error("contract_ledger_append_verification_failed");
  }
  await state.completeApproval(event.envelopeId); return "applied";
}

export async function notifyContractLedgerDeadLetter(event: ContractLedgerSyncEvent | ContractLedgerApprovalEvent,
  env: ContractLedgerEnvironment, fetchImpl: typeof fetch = fetch): Promise<void> {
  const config = contractLedgerConfig(env);
  await slackPost(env, config.legalChannelId,
    `:rotating_light: 契約台帳処理が再試行上限に到達しました\n実行ID: ${event.runId}\n処理種別: ${event.kind}`,
    undefined, fetchImpl);
}

export function parseContractLedgerSlackAction(payload: Record<string, unknown>, config: ContractLedgerConfig): ContractLedgerApprovalEvent | undefined {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = actions.length === 1 && actions[0] && typeof actions[0] === "object" ? actions[0] as Record<string, unknown> : undefined;
  const actionId = typeof action?.action_id === "string" ? action.action_id : "";
  if (actionId !== CONTRACT_LEDGER_APPROVE_ACTION_ID && actionId !== CONTRACT_LEDGER_REJECT_ACTION_ID) return undefined;
  const user = payload.user && typeof payload.user === "object" ? payload.user as Record<string, unknown> : {};
  const channel = payload.channel && typeof payload.channel === "object" ? payload.channel as Record<string, unknown> : {};
  const userId = typeof user.id === "string" ? user.id : ""; const channelId = typeof channel.id === "string" ? channel.id : "";
  if (!config.approverUserIds.has(userId)) throw new Error("contract_ledger_approver_forbidden");
  if (channelId !== config.legalChannelId) throw new Error("contract_ledger_channel_forbidden");
  let value: { envelopeId?: string; runId?: string } = {};
  try { value = JSON.parse(typeof action?.value === "string" ? action.value : "{}"); } catch { throw new Error("contract_ledger_action_invalid"); }
  if (!value.envelopeId || !value.runId) throw new Error("contract_ledger_action_invalid");
  return { kind: CONTRACT_LEDGER_APPROVAL_KIND, runId: value.runId, envelopeId: value.envelopeId,
    decision: actionId === CONTRACT_LEDGER_APPROVE_ACTION_ID ? "approved" : "rejected", decidedBy: userId,
    decidedAt: new Date().toISOString() };
}
