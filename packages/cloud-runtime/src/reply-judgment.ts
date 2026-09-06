import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";

const JUDGMENT_AUDIT_PREFIX = "🧠 判断参照:";
const JUDGMENT_WARNING_PREFIX = "⚠️ 判断参照:";
const BRAINBASE_AUDIT_PREFIX = "📚 Brainbase";
const BRAINBASE_WARNING_PREFIX = "⚠️ Brainbase";
const BRAINBASE_INCOMPLETE_AUDIT_PREFIXES = [
  "📚 Brainbase監査未完了:",
  "⚠️ Brainbase監査未完了:",
];
const BRAINBASE_NO_REFERENCE_AUDIT_PREFIX = "📚 Brainbase未参照:";
// Only these Host-owned operation labels can prove a Brainbase tool event.
// Keep the allowlist finite so generic or incomplete warning text cannot
// satisfy an evidence check merely by sharing the Brainbase prefix.
const BRAINBASE_COMPLETED_AUDIT_PATTERN = /^(?:📚|⚠️) Brainbase(?:参照先|検索|取得|書込|呼出):\s*\S/u;
const CONTINUATION_AUDIT_PREFIX = "🔁 ";
const STOP_REPAIR_AUDIT_PREFIX = "🛠️ ";
const JUDGMENT_RECEIPT_PREFIX = "__MANA_JUDGMENT_RECEIPT_V1__:";
const VERIFIED_ANSWER_PREFIX = "__MANA_VERIFIED_ANSWER_V1__:";

interface StreamEvent extends Record<string, unknown> {
  type?: string;
  subtype?: string;
  hook_event?: string;
  session_id?: string;
  sessionId?: string;
  result?: unknown;
  output?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  permission_denials?: unknown;
  message?: { content?: unknown };
}

interface CliPermissionDenial {
  toolUseId: string;
  toolName: string;
}

interface EmbeddedHookReceipt {
  schema_version: "mana_judgment_hook_receipt.v1";
  hook_event_name: "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "Stop";
  session_id: string;
  turn_id: string;
  host_receipt_id?: string;
  route_resolution_sha256?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_receipts?: Array<{
    tool_use_id: string;
    tool_name: string;
    outcome: "success" | "error";
  }>;
}

export type ReplyJudgmentAuditMismatchReason =
  | "missing_posttool_receipt"
  | "tool_use_id_mismatch"
  | "tool_name_mismatch";

/**
 * Content-free diagnostics for a failed PostToolUse binding.
 *
 * This object is intentionally limited to counts and categorical reasons. It
 * must never become a second stream of prompts, tool inputs, or identifiers.
 */
export interface ReplyJudgmentAuditDiagnostics {
  schemaVersion: "reply_judgment_audit_diagnostics.v1";
  scope: "posttool_receipt_binding";
  reasonCodes: ReplyJudgmentAuditMismatchReason[];
  expectedCallCount: number;
  postToolReceiptCount: number;
  boundReceiptCount: number;
  missingReceiptCount: number;
  toolUseIdMismatchCount: number;
  toolNameMismatchCount: number;
}

export class ReplyJudgmentParseError extends Error {
  constructor(
    message: string,
    readonly auditDiagnostics?: ReplyJudgmentAuditDiagnostics,
  ) {
    super(message);
    this.name = "ReplyJudgmentParseError";
  }
}

export function getReplyJudgmentAuditDiagnostics(
  error: unknown,
): ReplyJudgmentAuditDiagnostics | undefined {
  return error instanceof ReplyJudgmentParseError ? error.auditDiagnostics : undefined;
}

export interface ReplyJudgmentResult {
  reply: string;
  sessionId: string;
  turnId: string;
  hostReceiptId?: string;
  routeResolutionSha256?: string;
  auditLines: string[];
  toolJournal: Array<{ sequence: number; toolUseId: string; toolName: string; outcome: "success" | "error" }>;
  userPromptSubmit: "completed";
  stop: "completed";
}

export interface ReplyJudgmentAttempt {
  attemptId: string;
  status: "started" | "audited" | "failed" | "completed";
  startedAt: string;
  auditedAt?: string;
  failedAt?: string;
  completedAt?: string;
  failureCode?: string;
  claudeSessionId?: string;
  brainbaseTurnId?: string;
  hostReceiptId?: string;
  routeResolutionSha256?: string;
  userPromptSubmit?: "completed";
  stop?: "completed";
  auditLines?: string[];
  toolJournal?: ReplyJudgmentResult["toolJournal"];
  responseTs?: string;
}

export interface ReplyJudgmentEpisode {
  schemaVersion: "reply_judgment_episode.v1";
  eventId: string;
  tenantId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  attempts: ReplyJudgmentAttempt[];
}

function episodePath(eventId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) throw new Error("event_id_invalid");
  return `/judgment-episodes/${eventId}.json`;
}

async function readText(fs: WorkspaceFs, path: string): Promise<string> {
  const value = await fs.readFile(path);
  return typeof value === "string" ? value : new Response(value).text();
}

export async function readReplyJudgmentEpisode(
  fs: WorkspaceFs,
  eventId: string,
): Promise<ReplyJudgmentEpisode | undefined> {
  const path = episodePath(eventId);
  await fs.mkdir("/judgment-episodes", { recursive: true });
  if (!(await fs.ls("/judgment-episodes")).includes(path)) return undefined;
  const value = JSON.parse(await readText(fs, path)) as ReplyJudgmentEpisode;
  if (value.schemaVersion !== "reply_judgment_episode.v1" || value.eventId !== eventId
      || !Array.isArray(value.attempts)) throw new Error("reply_judgment_episode_invalid");
  return value;
}

async function writeEpisode(fs: WorkspaceFs, episode: ReplyJudgmentEpisode): Promise<void> {
  await fs.mkdir("/judgment-episodes", { recursive: true });
  await fs.writeFile(episodePath(episode.eventId), JSON.stringify(episode));
}

export async function isReplyJudgmentCompleted(
  fs: WorkspaceFs,
  eventId: string,
): Promise<boolean> {
  const episode = await readReplyJudgmentEpisode(fs, eventId);
  return episode?.attempts.some((attempt) => attempt.status === "completed") ?? false;
}

export async function startReplyJudgmentAttempt(
  fs: WorkspaceFs,
  event: SlackQueueEvent,
  startedAt: string,
): Promise<string> {
  const current = await readReplyJudgmentEpisode(fs, event.eventId);
  const episode: ReplyJudgmentEpisode = current ?? {
    schemaVersion: "reply_judgment_episode.v1",
    eventId: event.eventId,
    tenantId: event.tenantId,
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    attempts: [],
  };
  if (episode.tenantId !== event.tenantId || episode.workspaceId !== event.workspaceId
      || episode.channelId !== event.channelId
      || episode.threadTs !== event.threadTs) throw new Error("reply_judgment_episode_identity_mismatch");
  const attemptId = crypto.randomUUID();
  episode.attempts.push({ attemptId, status: "started", startedAt });
  await writeEpisode(fs, episode);
  return attemptId;
}

async function updateAttempt(
  fs: WorkspaceFs,
  eventId: string,
  attemptId: string,
  update: (attempt: ReplyJudgmentAttempt) => void,
): Promise<void> {
  const episode = await readReplyJudgmentEpisode(fs, eventId);
  const attempt = episode?.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!episode || !attempt) throw new Error("reply_judgment_attempt_missing");
  update(attempt);
  await writeEpisode(fs, episode);
}

export async function auditReplyJudgmentAttempt(
  fs: WorkspaceFs,
  eventId: string,
  attemptId: string,
  result: ReplyJudgmentResult,
  auditedAt: string,
): Promise<void> {
  await updateAttempt(fs, eventId, attemptId, (attempt) => {
    if (attempt.status !== "started") throw new Error("reply_judgment_attempt_state_invalid");
    Object.assign(attempt, {
      status: "audited",
      auditedAt,
      claudeSessionId: result.sessionId,
      brainbaseTurnId: result.turnId,
      ...(result.hostReceiptId ? { hostReceiptId: result.hostReceiptId } : {}),
      ...(result.routeResolutionSha256 ? { routeResolutionSha256: result.routeResolutionSha256 } : {}),
      userPromptSubmit: result.userPromptSubmit,
      stop: result.stop,
      auditLines: result.auditLines,
      toolJournal: result.toolJournal,
    });
  });
}

export async function completeReplyJudgmentAttempt(
  fs: WorkspaceFs,
  eventId: string,
  attemptId: string,
  responseTs: string,
  completedAt: string,
): Promise<void> {
  await updateAttempt(fs, eventId, attemptId, (attempt) => {
    if (attempt.status !== "audited") throw new Error("reply_judgment_attempt_state_invalid");
    Object.assign(attempt, { status: "completed", responseTs, completedAt });
  });
}

export async function failReplyJudgmentAttempt(
  fs: WorkspaceFs,
  eventId: string,
  attemptId: string,
  failureCode: string,
  failedAt: string,
): Promise<void> {
  await updateAttempt(fs, eventId, attemptId, (attempt) => {
    if (attempt.status === "completed") return;
    Object.assign(attempt, { status: "failed", failureCode, failedAt });
  });
}

function parseEvents(stdout: string): StreamEvent[] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("reply_judgment_stream_empty");
  return lines.map((line) => {
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error();
      return event;
    } catch {
      let reason = "text";
      if (line.codePointAt(0) === 0xfeff) reason = "bom";
      else if (/^\x1b\[[0-9;?]*[ -/]*[@-~]/.test(line)) reason = "ansi";
      else {
        const firstObject = line.indexOf("{");
        const lastObject = line.lastIndexOf("}");
        if (firstObject > 0 && lastObject > firstObject) reason = "json_prefixed";
        else if (firstObject === 0 && lastObject >= 0 && lastObject < line.length - 1) reason = "json_suffixed";
      }
      throw new Error(`reply_judgment_stream_invalid_${reason}`);
    }
  });
}

function contentItems(event: StreamEvent): Array<Record<string, unknown>> {
  const content = event.message?.content;
  return Array.isArray(content)
    ? content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function parseHookOutput(event: StreamEvent): Record<string, unknown> {
  for (const candidate of [event.stdout, event.output]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try the next representation */ }
  }
  throw new Error("reply_judgment_hook_output_invalid");
}

function hookReceipt(event: StreamEvent): { output: Record<string, unknown>; receipt: EmbeddedHookReceipt } {
  if (event.type !== "system" || event.subtype !== "hook_response" || event.exit_code !== 0
      || event.outcome !== "success") {
    const diagnosticText = [event.stderr, event.stdout, event.output]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const safeReason = diagnosticText.match(/\bjudgment_hook_(?:http_\d{3}|[a-z0-9_]+)\b/)?.[0];
    throw new Error(safeReason
      ? `reply_judgment_hook_failed_${safeReason}`
      : "reply_judgment_hook_failed");
  }
  const output = parseHookOutput(event);
  const receiptLines = typeof output.systemMessage === "string"
    ? output.systemMessage.split(/\r?\n/).filter((line) => line.startsWith(JUDGMENT_RECEIPT_PREFIX))
    : [];
  let receipt: Partial<EmbeddedHookReceipt> | undefined;
  if (receiptLines.length === 1) {
    try {
      receipt = JSON.parse(receiptLines[0]!.slice(JUDGMENT_RECEIPT_PREFIX.length)) as Partial<EmbeddedHookReceipt>;
    } catch { /* rejected below */ }
  }
  if (!receipt || receipt.schema_version !== "mana_judgment_hook_receipt.v1"
      || receipt.hook_event_name !== event.hook_event || typeof receipt.session_id !== "string"
      || typeof receipt.turn_id !== "string" || !receipt.turn_id) {
    throw new Error("reply_judgment_hook_receipt_invalid");
  }
  return { output, receipt: receipt as EmbeddedHookReceipt };
}

function auditLines(output: Record<string, unknown>): string[] {
  if (typeof output.systemMessage !== "string") return [];
  return output.systemMessage.split(/\r?\n/)
    .filter(isAuditLine);
}

function auditLinesInReply(reply: string): string[] {
  return reply.split(/\r?\n/)
    .filter(isAuditLine);
}

function isAuditLine(line: string): boolean {
  return line.startsWith(JUDGMENT_AUDIT_PREFIX)
    || line.startsWith(JUDGMENT_WARNING_PREFIX)
    || line.startsWith(BRAINBASE_AUDIT_PREFIX)
    || line.startsWith(BRAINBASE_WARNING_PREFIX)
    || line.startsWith(CONTINUATION_AUDIT_PREFIX)
    || line.startsWith(STOP_REPAIR_AUDIT_PREFIX);
}

function completedBrainbaseAuditLines(lines: string[]): string[] {
  return lines.filter(isCompletedBrainbaseAuditLine);
}

function toolBrainbaseAuditLines(lines: string[]): string[] {
  return lines.filter(isCompletedBrainbaseAuditLine);
}

function isCompletedBrainbaseAuditLine(line: string): boolean {
  return BRAINBASE_COMPLETED_AUDIT_PATTERN.test(line);
}

function hasBrainbaseAuditLine(lines: string[]): boolean {
  return lines.some((line) => isCompletedBrainbaseAuditLine(line)
    || line.startsWith(BRAINBASE_NO_REFERENCE_AUDIT_PREFIX));
}

function isBrainbaseEvidenceTool(name: string): boolean {
  // These tools manage the Judgment lifecycle itself. They prove that the
  // turn was classified/state-recorded, but they are not a Brainbase source
  // read and therefore must not be paired with a knowledge-reference audit.
  return name !== "mcp__brainbase__brainbase_resolve_turn"
    && name !== "mcp__brainbase__brainbase_judgment_state_record";
}

function isDirectBrainbaseTool(name: string): boolean {
  return name.startsWith("mcp__brainbase__");
}

function buildAuditBindingDiagnostics(
  executedCalls: ReadonlyArray<{ id: string; name: string }>,
  postToolReceipts: ReadonlyArray<{ receipt: EmbeddedHookReceipt }>,
): ReplyJudgmentAuditDiagnostics {
  let boundReceiptCount = 0;
  let missingReceiptCount = 0;
  let toolUseIdMismatchCount = 0;
  let toolNameMismatchCount = 0;

  for (const call of executedCalls) {
    const idMatches = postToolReceipts.filter((hook) => hook.receipt.tool_use_id === call.id);
    if (idMatches.length === 0) {
      // A matching name or the same total count does not prove that this call's
      // id was used. Treat an unbound id as missing rather than guessing an id
      // mismatch from unrelated receipt metadata.
      missingReceiptCount += 1;
      continue;
    }
    if (idMatches.some((hook) => hook.receipt.tool_name === call.name)) {
      boundReceiptCount += 1;
    } else {
      toolNameMismatchCount += 1;
    }
  }

  const reasonCodes: ReplyJudgmentAuditMismatchReason[] = [];
  if (missingReceiptCount > 0) reasonCodes.push("missing_posttool_receipt");
  if (toolUseIdMismatchCount > 0) reasonCodes.push("tool_use_id_mismatch");
  if (toolNameMismatchCount > 0) reasonCodes.push("tool_name_mismatch");

  return {
    schemaVersion: "reply_judgment_audit_diagnostics.v1",
    scope: "posttool_receipt_binding",
    reasonCodes,
    expectedCallCount: executedCalls.length,
    postToolReceiptCount: postToolReceipts.length,
    boundReceiptCount,
    missingReceiptCount,
    toolUseIdMismatchCount,
    toolNameMismatchCount,
  };
}

function stopToolReceiptHooks(
  stopHook: { index: number; output: Record<string, unknown>; receipt: EmbeddedHookReceipt },
  calls: ReadonlyArray<{ index: number; id: string; name: string }>,
  results: ReadonlyMap<string, { index: number; outcome: "success" | "error" }>,
  deniedCallIds: ReadonlySet<string>,
): Array<{ index: number; output: Record<string, unknown>; receipt: EmbeddedHookReceipt }> {
  const journal = stopHook.receipt.tool_receipts;
  if (journal === undefined) return [];
  if (!Array.isArray(journal)) {
    throw new Error("reply_judgment_tool_audit_mismatch_stop_tool_receipts_invalid");
  }
  const seen = new Map<string, { toolName: string; outcome: "success" | "error" }>();
  return journal.map((entry) => {
    if (!entry || typeof entry !== "object"
        || typeof entry.tool_use_id !== "string" || !entry.tool_use_id.trim()
        || typeof entry.tool_name !== "string" || !entry.tool_name.startsWith("mcp__brainbase__")
        || (entry.outcome !== "success" && entry.outcome !== "error")) {
      throw new Error("reply_judgment_tool_audit_mismatch_stop_tool_receipts_invalid");
    }
    const existing = seen.get(entry.tool_use_id);
    if (existing) {
      if (existing.toolName !== entry.tool_name || existing.outcome !== entry.outcome) {
        throw new Error("reply_judgment_tool_audit_mismatch_stop_tool_receipts_conflict");
      }
      throw new Error("reply_judgment_tool_audit_mismatch_stop_tool_receipts_duplicate");
    }
    seen.set(entry.tool_use_id, { toolName: entry.tool_name, outcome: entry.outcome });
    const matchingCalls = calls.filter((call) => call.id === entry.tool_use_id);
    const result = results.get(entry.tool_use_id);
    if (matchingCalls.length !== 1 || matchingCalls[0]!.name !== entry.tool_name
        || deniedCallIds.has(entry.tool_use_id) || !result || result.outcome !== entry.outcome) {
      throw new Error("reply_judgment_tool_audit_mismatch_stop_tool_receipts_identity_mismatch");
    }
    return {
      // The Stop Hook is invoked after every completed tool callback. Give its
      // cumulative identities a position immediately before Stop so existing
      // lifecycle ordering checks remain fail-closed.
      index: stopHook.index - 0.5,
      output: stopHook.output,
      receipt: {
        ...stopHook.receipt,
        hook_event_name: entry.outcome === "success" ? "PostToolUse" : "PostToolUseFailure",
        tool_use_id: entry.tool_use_id,
        tool_name: entry.tool_name,
        tool_receipts: undefined,
      },
    };
  });
}

function verifiedAnswer(output: Record<string, unknown>): string | undefined {
  if (typeof output.systemMessage !== "string") return undefined;
  const markers = output.systemMessage.split(/\r?\n/)
    .filter((line) => line.startsWith(VERIFIED_ANSWER_PREFIX));
  if (markers.length !== 1) return undefined;
  try {
    const parsed = JSON.parse(markers[0]!.slice(VERIFIED_ANSWER_PREFIX.length)) as Record<string, unknown>;
    return typeof parsed.answer === "string" && parsed.answer.trim()
      && typeof parsed.answer_digest === "string" && /^[a-f0-9]{64}$/.test(parsed.answer_digest)
      ? parsed.answer.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function currentAttemptEvents(events: StreamEvent[]): StreamEvent[] {
  // `claude --resume` can replay earlier assistant and tool-result items before
  // emitting this attempt's UserPromptSubmit Hook. The latest submit event is
  // the authenticated boundary for the current attempt; treating replayed
  // history as current executions would require receipts that belong to an
  // earlier attempt and can turn a valid retry into silence.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "system" && event.subtype === "hook_response"
        && event.hook_event === "UserPromptSubmit") {
      return events.slice(index);
    }
  }
  throw new Error("reply_judgment_lifecycle_incomplete");
}

export function parseReplyJudgmentStream(stdout: string): ReplyJudgmentResult {
  const events = currentAttemptEvents(parseEvents(stdout));
  const hooks: Array<{ index: number; output: Record<string, unknown>; receipt: EmbeddedHookReceipt }> = [];
  const calls: Array<{ index: number; id: string; name: string }> = [];
  const results = new Map<string, { index: number; outcome: "success" | "error" }>();
  const resultCounts = new Map<string, number>();
  let final: { index: number; reply: string; sessionId: string } | undefined;
  let terminalPermissionDenials: CliPermissionDenial[] = [];

  events.forEach((event, index) => {
    if (event.type === "system" && event.subtype === "hook_response"
        && (event.hook_event === "UserPromptSubmit"
          || event.hook_event === "PostToolUse"
          || event.hook_event === "PostToolUseFailure"
          || event.hook_event === "Stop")) {
      const parsed = hookReceipt(event);
      hooks.push({ index, ...parsed });
    }
    for (const item of contentItems(event)) {
      if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string"
          && item.name.startsWith("mcp__brainbase__")) calls.push({ index, id: item.id, name: item.name });
      if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
        resultCounts.set(item.tool_use_id, (resultCounts.get(item.tool_use_id) ?? 0) + 1);
        results.set(item.tool_use_id, { index, outcome: item.is_error === true ? "error" : "success" });
      }
    }
    if (event.type === "result") {
      // permission_denials is terminal CLI metadata, independent from whether
      // the CLI supplied a reply body. A verified Stop answer may legitimately
      // replace an empty or omitted body, but an exact PreToolUse denial must
      // still be excluded from PostTool receipt accounting.
      if (event.permission_denials !== undefined) {
        if (!Array.isArray(event.permission_denials)) {
          throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_invalid");
        }
        terminalPermissionDenials = event.permission_denials.map((raw): CliPermissionDenial => {
          if (!raw || typeof raw !== "object") {
            throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_invalid");
          }
          const denial = raw as Record<string, unknown>;
          if (typeof denial.tool_use_id !== "string" || !denial.tool_use_id.trim()
              || typeof denial.tool_name !== "string" || !denial.tool_name.trim()) {
            throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_invalid");
          }
          return { toolUseId: denial.tool_use_id, toolName: denial.tool_name };
        });
      } else {
        terminalPermissionDenials = [];
      }
    }
    if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
      const sessionId = event.session_id ?? event.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw new Error("reply_judgment_session_missing");
      final = { index, reply: event.result.trim(), sessionId };
    }
  });

  const promptHooks = hooks.filter((hook) => hook.receipt.hook_event_name === "UserPromptSubmit");
  const postToolHookCandidates = hooks.filter((hook) =>
    hook.receipt.hook_event_name === "PostToolUse"
    || hook.receipt.hook_event_name === "PostToolUseFailure");
  const hasToolUseId = (hook: typeof postToolHookCandidates[number]): boolean =>
    typeof hook.receipt.tool_use_id === "string" && Boolean(hook.receipt.tool_use_id.trim());
  const hasToolName = (hook: typeof postToolHookCandidates[number]): boolean =>
    typeof hook.receipt.tool_name === "string" && Boolean(hook.receipt.tool_name.trim());
  if (postToolHookCandidates.some((hook) => !hasToolUseId(hook) || !hasToolName(hook))) {
    throw new Error("reply_judgment_tool_audit_mismatch_posttool_identity_missing");
  }
  const stopHooks = hooks.filter((hook) => hook.receipt.hook_event_name === "Stop");
  const deniedCallIds = new Set<string>();
  for (const denial of terminalPermissionDenials) {
    const matchingCalls = calls.filter((call) => call.id === denial.toolUseId);
    const matchingBrainbaseCall = matchingCalls.find((call) => call.name.startsWith("mcp__brainbase__"));
    if (!matchingBrainbaseCall) {
      if (denial.toolName.startsWith("mcp__brainbase__")) {
        throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_identity_mismatch");
      }
      continue;
    }
    if (matchingCalls.length !== 1 || matchingBrainbaseCall.name !== denial.toolName) {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_tool_name_mismatch");
    }
    const result = results.get(matchingBrainbaseCall.id);
    if (resultCounts.get(matchingBrainbaseCall.id) !== 1) {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_result_conflict");
    }
    if (!result || result.outcome !== "error") {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_result_outcome_mismatch");
    }
    if (result.index <= matchingBrainbaseCall.index
        || (stopHooks.length > 0 && result.index >= stopHooks.at(-1)!.index)) {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_event_order_invalid");
    }
    if (postToolHookCandidates.some((hook) => hook.receipt.tool_use_id === matchingBrainbaseCall.id)) {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_posttool_receipt_conflict");
    }
    if (deniedCallIds.has(matchingBrainbaseCall.id)) {
      throw new Error("reply_judgment_tool_audit_mismatch_permission_denial_identity_conflict");
    }
    deniedCallIds.add(matchingBrainbaseCall.id);
  }
  // A rejected PreToolUse attempt is a guard decision, not an executed MCP
  // call. Claude still emits an error tool_result for it, so exclusion requires
  // an exact identity match in the CLI-owned terminal permission_denials list.
  // Every executed direct Brainbase call must have an authenticated PostToolUse
  // or PostToolUseFailure receipt whose kind matches the result outcome. Other
  // MCP servers have their own lifecycle and are outside the Brainbase Hook
  // matcher and receipt contract.
  const executedCalls = calls.filter((call) => results.has(call.id) && !deniedCallIds.has(call.id));
  const controlPlaneExecutedCalls = executedCalls.filter((call) =>
    isDirectBrainbaseTool(call.name) && !isBrainbaseEvidenceTool(call.name));
  const controlPlaneHooks = postToolHookCandidates.filter((hook) =>
    hasToolUseId(hook) && hasToolName(hook)
      && isDirectBrainbaseTool(hook.receipt.tool_name!)
      && !isBrainbaseEvidenceTool(hook.receipt.tool_name!));
  // Missing lifecycle PostTool receipts are tolerated for the affected Claude
  // Code releases. If one is emitted, it is still authenticated against the
  // CLI stream so a stale or conflicting receipt cannot be accepted silently.
  const controlHooksByToolUseId = new Map<string, typeof controlPlaneHooks[number]>();
  for (const hook of controlPlaneHooks) {
    const toolUseId = hook.receipt.tool_use_id!;
    const existing = controlHooksByToolUseId.get(toolUseId);
    if (existing) {
      if (existing.receipt.tool_name !== hook.receipt.tool_name
          || existing.receipt.hook_event_name !== hook.receipt.hook_event_name
          || existing.receipt.host_receipt_id !== hook.receipt.host_receipt_id
          || JSON.stringify(auditLines(existing.output)) !== JSON.stringify(auditLines(hook.output))) {
        throw new Error("reply_judgment_tool_audit_mismatch_posttool_receipt_conflict");
      }
      continue;
    }
    controlHooksByToolUseId.set(toolUseId, hook);
  }
  for (const hook of controlHooksByToolUseId.values()) {
    const call = controlPlaneExecutedCalls.find((candidate) =>
      candidate.id === hook.receipt.tool_use_id && candidate.name === hook.receipt.tool_name);
    if (!call) {
      throw new ReplyJudgmentParseError(
        "reply_judgment_tool_audit_mismatch_posttool_receipt_binding_missing",
        buildAuditBindingDiagnostics(controlPlaneExecutedCalls, controlPlaneHooks),
      );
    }
    const result = results.get(call.id);
    const expectedHookEvent = result?.outcome === "success" ? "PostToolUse" : "PostToolUseFailure";
    if (!result || hook.receipt.hook_event_name !== expectedHookEvent) {
      throw new Error("reply_judgment_tool_audit_mismatch_posttool_result_outcome_mismatch");
    }
    if (hook.index <= call.index || result.index <= call.index) {
      throw new Error("reply_judgment_tool_audit_mismatch_posttool_event_order_invalid");
    }
  }
  // Claude Code 2.1.x can omit PostToolUse entirely for MCP calls even though
  // the tool call and result are both present in its stream. Judgment
  // lifecycle tools are independently bound by the UserPromptSubmit/Stop Host
  // receipts, so do not turn that upstream omission into Slack silence. Real
  // Brainbase reads and writes remain fail-closed and still require their
  // identity-bound PostToolUse receipt below.
  const auditedExecutedCalls = executedCalls.filter((call) =>
    isDirectBrainbaseTool(call.name) && isBrainbaseEvidenceTool(call.name));
  // The reply Hook may be configured broadly while a task-write MCP is
  // enabled. Only a PostTool receipt for an executed direct Brainbase call is
  // part of this contract; unrelated receipts must not change binding counts
  // or sequence checks. Keep same-ID Brainbase name mismatches in the scoped
  // set so the later exact-name check still fails closed.
  const brainbaseIdentityBoundHooks = postToolHookCandidates.filter((hook) => {
    if (!hasToolUseId(hook) || !hasToolName(hook)) return false;
    return (isDirectBrainbaseTool(hook.receipt.tool_name!)
        && isBrainbaseEvidenceTool(hook.receipt.tool_name!))
      || auditedExecutedCalls.some((call) => call.id === hook.receipt.tool_use_id);
  });
  if (brainbaseIdentityBoundHooks.some((hook) => isBrainbaseEvidenceTool(hook.receipt.tool_name!)
      && toolBrainbaseAuditLines(auditLines(hook.output)).length === 0)) {
    throw new Error("reply_judgment_tool_audit_mismatch_evidence_audit_missing");
  }
  if (promptHooks.length !== 1 || stopHooks.length < 1) throw new Error("reply_judgment_lifecycle_incomplete");
  if (typeof promptHooks[0]!.receipt.host_receipt_id !== "string"
      || !promptHooks[0]!.receipt.host_receipt_id.trim()
      || !/^[a-f0-9]{64}$/.test(promptHooks[0]!.receipt.route_resolution_sha256 ?? "")) {
    throw new Error("reply_judgment_route_receipt_missing");
  }
  const successfulStop = stopHooks.at(-1)!;
  const stopJournalHooks = stopToolReceiptHooks(
    successfulStop,
    calls,
    results,
    deniedCallIds,
  );
  const authenticatedToolHooks = [...brainbaseIdentityBoundHooks];
  const emittedToolUseIds = new Set(authenticatedToolHooks.map((hook) => hook.receipt.tool_use_id));
  for (const hook of stopJournalHooks) {
    if (!emittedToolUseIds.has(hook.receipt.tool_use_id)) authenticatedToolHooks.push(hook);
  }
  const hostVerifiedAnswer = verifiedAnswer(successfulStop.output);
  if (!final && hostVerifiedAnswer) {
    final = {
      index: successfulStop.index + 0.5,
      reply: hostVerifiedAnswer,
      sessionId: successfulStop.receipt.session_id,
    };
  }
  if (!final) throw new Error("reply_judgment_result_missing");
  if (hostVerifiedAnswer && final.reply.trim() !== hostVerifiedAnswer) {
    // A bounded Stop repair can complete after Claude Code has already emitted
    // the pre-repair result event. The authenticated Stop marker is the exact
    // answer accepted by the Host, so it is canonical over that stale model
    // result. Keep the original result index for lifecycle ordering while
    // exposing only the Host-accepted answer to Slack.
    final.reply = hostVerifiedAnswer;
  }
  if (promptHooks[0]!.index >= final.index || successfulStop.index >= final.index) {
    throw new Error("reply_judgment_event_order_invalid");
  }
  const allReceipts = hooks.map((hook) => hook.receipt);
  const turnId = allReceipts[0]!.turn_id;
  if (allReceipts.some((receipt) => receipt.session_id !== final!.sessionId || receipt.turn_id !== turnId)) {
    throw new Error("reply_judgment_identity_mismatch");
  }
  let boundPostToolHooks: typeof authenticatedToolHooks;
  if (authenticatedToolHooks.length > 0) {
    const hooksByToolUseId = new Map<string, typeof authenticatedToolHooks[number]>();
    for (const hook of authenticatedToolHooks) {
      const toolUseId = hook.receipt.tool_use_id!;
      const existing = hooksByToolUseId.get(toolUseId);
      if (existing) {
        if (existing.receipt.tool_name !== hook.receipt.tool_name
            || existing.receipt.hook_event_name !== hook.receipt.hook_event_name
            || existing.receipt.host_receipt_id !== hook.receipt.host_receipt_id
            || JSON.stringify(auditLines(existing.output)) !== JSON.stringify(auditLines(hook.output))) {
          throw new Error("reply_judgment_tool_audit_mismatch_posttool_receipt_conflict");
        }
        continue;
      }
      hooksByToolUseId.set(toolUseId, hook);
    }
    boundPostToolHooks = auditedExecutedCalls.map((call) => {
      const hook = hooksByToolUseId.get(call.id);
      if (!hook || hook.receipt.tool_name !== call.name) {
        throw new ReplyJudgmentParseError(
          "reply_judgment_tool_audit_mismatch_posttool_receipt_binding_missing",
          buildAuditBindingDiagnostics(auditedExecutedCalls, authenticatedToolHooks),
        );
      }
      return hook;
    });
    if (hooksByToolUseId.size !== auditedExecutedCalls.length) {
      throw new Error("reply_judgment_tool_audit_mismatch_posttool_receipt_count_mismatch");
    }
  } else {
    if (auditedExecutedCalls.length > 0) {
      throw new ReplyJudgmentParseError(
        "reply_judgment_tool_audit_mismatch_posttool_receipt_missing",
        buildAuditBindingDiagnostics(auditedExecutedCalls, authenticatedToolHooks),
      );
    }
    boundPostToolHooks = authenticatedToolHooks;
  }

  auditedExecutedCalls.forEach((call, sequence) => {
    const result = results.get(call.id);
    const audit = boundPostToolHooks[sequence];
    if (!result || result.index <= call.index || !audit || audit.index <= call.index) {
      throw new Error("reply_judgment_tool_audit_mismatch_posttool_event_order_invalid");
    }
    if (promptHooks[0]!.index >= call.index || result.index >= successfulStop.index
        || audit.index >= successfulStop.index) {
      throw new Error("reply_judgment_event_order_invalid");
    }
    const expectedHookEvent = result.outcome === "success" ? "PostToolUse" : "PostToolUseFailure";
    if (audit.receipt.hook_event_name !== expectedHookEvent) {
      throw new Error("reply_judgment_tool_audit_mismatch_posttool_result_outcome_mismatch");
    }
  });
  // Control-plane receipts can carry the Host's cumulative audit text after
  // an evidence call. Authenticate every Brainbase receipt first, then omit
  // lifecycle-only calls from the source-read journal by tool identity.
  const evidenceCalls = auditedExecutedCalls.filter((call) => isBrainbaseEvidenceTool(call.name));
  const toolJournal = evidenceCalls.map((call, sequence) => {
    const result = results.get(call.id)!;
    return { sequence: sequence + 1, toolUseId: call.id, toolName: call.name, outcome: result.outcome };
  });
  // A failed optional call is still an authenticated, audited execution. The
  // Host-owned Stop contract decides whether that failure leaves a mandatory
  // capability unsatisfied. Rejecting every failed tool here would override a
  // completed Host decision and turn a valid answer into Slack silence.

  // A successful Stop is the Host's completed-episode receipt. UserPromptSubmit
  // only carries model context, while PostToolUse emits incremental journal
  // lines; neither is the canonical final audit block in the real CLI stream.
  let expectedAuditLines = auditLines(successfulStop.output);
  const judgmentAuditLines = expectedAuditLines.filter((line) =>
    line.startsWith(JUDGMENT_AUDIT_PREFIX) || line.startsWith(JUDGMENT_WARNING_PREFIX));
  if (judgmentAuditLines.length !== 1
      || !hasBrainbaseAuditLine(expectedAuditLines)) {
    throw new Error("reply_judgment_audit_lines_missing");
  }
  if (expectedAuditLines.some((line) => BRAINBASE_INCOMPLETE_AUDIT_PREFIXES
    .some((prefix) => line.startsWith(prefix)))) {
    // Stop is the canonical completed-episode receipt. Incremental PostToolUse
    // receipts prove individual calls, but cannot upgrade an explicitly
    // incomplete final audit into a completed Judgment episode.
    throw new Error("reply_judgment_audit_lines_missing");
  }
  if (evidenceCalls.length > 0) {
    // PostToolUse can carry either the latest audit line or a cumulative Host
    // journal. Evidence receipts without a completed audit line were rejected
    // before identity binding; Stop may summarize the completed receipts.
    const completedStopAuditLines = completedBrainbaseAuditLines(expectedAuditLines);
    // The Host may collapse several tool-level receipts into a smaller final
    // summary. Per-call completeness is proven above by PostToolUse; Stop only
    // needs to carry at least one completed Brainbase audit line.
    if (completedStopAuditLines.length === 0) {
      throw new Error("reply_judgment_tool_audit_mismatch_stop_evidence_audit_missing");
    }
  } else if (completedBrainbaseAuditLines(expectedAuditLines).length > 0) {
    throw new Error("reply_judgment_tool_audit_mismatch_unexpected_stop_evidence_audit");
  }
  let actualAuditLines = auditLinesInReply(final.reply);
  if (actualAuditLines.length === 0) {
    // Stop output is trusted Host data. Prepend it deterministically when the
    // model follows a user's "reply only with ..." instruction and omits the
    // audit block; model compliance must not turn a valid reply into silence.
    final.reply = [...expectedAuditLines, final.reply].join("\n");
    actualAuditLines = expectedAuditLines;
  }
  if (JSON.stringify(actualAuditLines) !== JSON.stringify(expectedAuditLines)) {
    throw new Error("reply_judgment_audit_lines_mismatch");
  }
  const leadingLines = final.reply.split(/\r?\n/).slice(0, expectedAuditLines.length);
  if (JSON.stringify(leadingLines) !== JSON.stringify(expectedAuditLines)) {
    throw new Error("reply_judgment_audit_lines_not_leading");
  }

  const first = promptHooks[0]!.receipt;
  return {
    reply: final.reply,
    sessionId: final.sessionId,
    turnId,
    ...(first.host_receipt_id ? { hostReceiptId: first.host_receipt_id } : {}),
    ...(first.route_resolution_sha256 ? { routeResolutionSha256: first.route_resolution_sha256 } : {}),
    auditLines: expectedAuditLines,
    toolJournal,
    userPromptSubmit: "completed",
    stop: "completed",
  };
}
