/**
 * Bounded, redacted execution diagnostics for a meeting-minutes Claude run.
 *
 * The runner is deliberately kept as source text because it runs in the
 * tenant container, while this module is bundled into the Cloudflare worker.
 * The runner never writes request bodies, prompts, arbitrary provider errors,
 * or child output text to its trace stream.
 */

export const MEETING_MINUTES_TRACE_RUNNER_PATH = "/tmp/meeting-minutes-trace-runner.mjs" as const;
export const MEETING_MINUTES_TRACE_PREFIX = "MANA_MINUTES_TRACE " as const;
export const MEETING_MINUTES_TRACE_SCHEMA_VERSION = "meeting_minutes_execution_trace.v1" as const;
export const MEETING_MINUTES_TRACE_MAX_EVENTS = 128 as const;

const TRACE_EVENT_NAMES = [
  "runner_started",
  "runner_error",
  "runner_finished",
  "stdout_event",
  "upstream_request_start",
  "upstream_response_headers",
  "upstream_response_first_body_chunk",
  "upstream_response_last_body_chunk",
  "upstream_response_end",
  "upstream_response_error",
  "upstream_sse_event",
  "upstream_response_progress",
  "child_spawn",
  "child_error",
  "child_exit",
  "child_close",
  "proxy_close_start",
  "proxy_close_error",
  "proxy_close_end",
] as const;

export type MeetingMinutesExecutionTraceEventName = typeof TRACE_EVENT_NAMES[number];
export type MeetingMinutesExecutionTraceEffort = "low" | "medium" | "high" | "max" | "xhigh";
export type MeetingMinutesExecutionTraceThinkingType = "enabled" | "disabled" | "adaptive";
export type MeetingMinutesExecutionTraceDeltaType = "text_delta" | "thinking_delta" | "input_json_delta";

export interface MeetingMinutesExecutionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface MeetingMinutesExecutionTraceEvent {
  event: MeetingMinutesExecutionTraceEventName;
  elapsedMs: number;
  requestIndex?: number;
  requestCount?: number;
  requestBytes?: number;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path?: "/v1/messages";
  model?: string;
  thinkingType?: MeetingMinutesExecutionTraceThinkingType;
  thinkingBudgetTokens?: number;
  maxTokens?: number;
  effort?: MeetingMinutesExecutionTraceEffort;
  statusCode?: number;
  headersObserved?: true;
  contentType?: "application/json" | "text/event-stream" | "text/plain";
  bodyBytes?: number;
  usage?: MeetingMinutesExecutionUsage;
  sseType?: "message_start" | "message_delta" | "message_stop";
  deltaType?: MeetingMinutesExecutionTraceDeltaType;
  textChars?: number;
  thinkingChars?: number;
  partialJsonChars?: number;
  type?: "system" | "assistant" | "user" | "result" | "error";
  subtype?:
    | "init"
    | "hook_response"
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "max_turns_reached"
    | "error_max_budget_usd"
    | "message_start"
    | "message_delta"
    | "message_stop"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "tool_use"
    | "api_error"
    | "rate_limit_error";
  toolName?:
    | "mcp__brainbase__brainbase_get_meeting_minutes_context"
    | "mcp__brainbase__brainbase_resolve_turn"
    | "mcp__brainbase__brainbase_judgment_state_record"
    | "mcp__brainbase__brainbase_knowledge_resolve"
    | "mcp__brainbase__brainbase_bootstrap_config"
    | "mcp__task-write__task_write"
    | "mcp__task-search__task_search"
    | "mcp__google-drive__search";
  exitCode?: number;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGABRT" | "SIGQUIT";
  errorCode?:
    | "provider_fetch_failed"
    | "provider_stream_failed"
    | "child_spawn_failed"
    | "proxy_close_failed"
    | "runner_failed";
}

export interface MeetingMinutesExecutionTrace {
  schemaVersion: typeof MEETING_MINUTES_TRACE_SCHEMA_VERSION;
  requestCount: number;
  events: MeetingMinutesExecutionTraceEvent[];
}

const EVENT_NAME_SET = new Set<string>(TRACE_EVENT_NAMES);
const EVENT_NAME_ALIASES: Readonly<Record<string, MeetingMinutesExecutionTraceEventName>> = Object.freeze({
  request_start: "upstream_request_start",
  response_headers: "upstream_response_headers",
  response_first_body_chunk: "upstream_response_first_body_chunk",
  response_last_body_chunk: "upstream_response_last_body_chunk",
  response_end: "upstream_response_end",
  response_error: "upstream_response_error",
  proxy_close_started: "proxy_close_start",
  proxy_close_finished: "proxy_close_end",
});
const SAFE_METHODS = new Set<MeetingMinutesExecutionTraceEvent["method"]>([
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS",
]);
const SAFE_CONTENT_TYPES = new Set<MeetingMinutesExecutionTraceEvent["contentType"]>([
  "application/json", "text/event-stream", "text/plain",
]);
const SAFE_EFFORTS = new Set<MeetingMinutesExecutionTraceEffort>(["low", "medium", "high", "max", "xhigh"]);
const SAFE_THINKING_TYPES = new Set<MeetingMinutesExecutionTraceThinkingType>(["enabled", "disabled", "adaptive"]);
const SAFE_DELTA_TYPES = new Set<MeetingMinutesExecutionTraceDeltaType>([
  "text_delta", "thinking_delta", "input_json_delta",
]);
const SAFE_STDOUT_TYPES = new Set<NonNullable<MeetingMinutesExecutionTraceEvent["type"]>>([
  "system", "assistant", "user", "result", "error",
]);
const SAFE_STDOUT_SUBTYPES = new Set<NonNullable<MeetingMinutesExecutionTraceEvent["subtype"]>>([
  "init", "hook_response", "success", "error_during_execution", "error_max_turns", "max_turns_reached",
  "error_max_budget_usd", "message_start", "message_delta", "message_stop", "content_block_start",
  "content_block_delta", "content_block_stop", "tool_use", "api_error", "rate_limit_error",
]);
const SAFE_TOOL_NAMES = new Set<NonNullable<MeetingMinutesExecutionTraceEvent["toolName"]>>([
  "mcp__brainbase__brainbase_get_meeting_minutes_context",
  "mcp__brainbase__brainbase_resolve_turn",
  "mcp__brainbase__brainbase_judgment_state_record",
  "mcp__brainbase__brainbase_knowledge_resolve",
  "mcp__brainbase__brainbase_bootstrap_config",
  "mcp__task-write__task_write",
  "mcp__task-search__task_search",
  "mcp__google-drive__search",
]);
const SAFE_SIGNALS = new Set<NonNullable<MeetingMinutesExecutionTraceEvent["signal"]>>([
  "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGQUIT",
]);
const SAFE_ERROR_CODES = new Set<NonNullable<MeetingMinutesExecutionTraceEvent["errorCode"]>>([
  "provider_fetch_failed", "provider_stream_failed", "child_spawn_failed", "proxy_close_failed", "runner_failed",
]);
const MAX_SAFE_DIAGNOSTIC_NUMBER = 1_000_000_000;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstValue(input: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in input ? input[camel] : input[snake];
}

function safeNonNegativeInteger(value: unknown, max = MAX_SAFE_DIAGNOSTIC_NUMBER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function safeElapsedMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SAFE_DIAGNOSTIC_NUMBER) {
    return undefined;
  }
  return Math.round(value);
}

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  if (value === "sonnet" || value === "opus" || value === "haiku") return value;
  return /^(?:claude-(?:[0-9]+-){0,2}(?:sonnet|opus|haiku)(?:-[A-Za-z0-9]+){0,8})$/u.test(value)
    ? value : undefined;
}

function safeUsage(value: unknown): MeetingMinutesExecutionUsage | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const output: MeetingMinutesExecutionUsage = {};
  const fields: ReadonlyArray<[keyof MeetingMinutesExecutionUsage, string, string]> = [
    ["inputTokens", "inputTokens", "input_tokens"],
    ["outputTokens", "outputTokens", "output_tokens"],
    ["cacheCreationInputTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
    ["cacheReadInputTokens", "cacheReadInputTokens", "cache_read_input_tokens"],
  ];
  for (const [target, camel, snake] of fields) {
    const item = safeNonNegativeInteger(firstValue(input, camel, snake), 100_000_000);
    if (item !== undefined) output[target] = item;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function safeEventName(value: unknown): MeetingMinutesExecutionTraceEventName | undefined {
  if (typeof value !== "string") return undefined;
  if (EVENT_NAME_SET.has(value)) return value as MeetingMinutesExecutionTraceEventName;
  return EVENT_NAME_ALIASES[value];
}

function sanitizeTraceEvent(value: unknown): MeetingMinutesExecutionTraceEvent | null {
  const input = objectValue(value);
  if (!input) return null;
  const event = safeEventName(input.event);
  const elapsedMs = safeElapsedMs(firstValue(input, "elapsedMs", "elapsed_ms"));
  if (!event || elapsedMs === undefined) return null;
  const output: MeetingMinutesExecutionTraceEvent = { event, elapsedMs };
  const requestIndex = safeNonNegativeInteger(firstValue(input, "requestIndex", "request_index"), 1_000_000);
  const requestCount = safeNonNegativeInteger(firstValue(input, "requestCount", "request_count"), 1_000_000);
  const requestBytes = safeNonNegativeInteger(firstValue(input, "requestBytes", "request_bytes"));
  const method = firstValue(input, "method", "method");
  const path = firstValue(input, "path", "path");
  const model = firstValue(input, "model", "model");
  const thinkingType = firstValue(input, "thinkingType", "thinking_type");
  const thinkingBudgetTokens = safeNonNegativeInteger(
    firstValue(input, "thinkingBudgetTokens", "thinking_budget_tokens"), 100_000_000,
  );
  const maxTokens = safeNonNegativeInteger(firstValue(input, "maxTokens", "max_tokens"), 100_000_000);
  const effort = firstValue(input, "effort", "effort");
  const statusCode = safeNonNegativeInteger(firstValue(input, "statusCode", "status_code"), 599);
  const contentType = firstValue(input, "contentType", "content_type");
  const bodyBytes = safeNonNegativeInteger(firstValue(input, "bodyBytes", "body_bytes"));
  const sseType = firstValue(input, "sseType", "sse_type");
  const deltaType = firstValue(input, "deltaType", "delta_type");
  const textChars = safeNonNegativeInteger(firstValue(input, "textChars", "text_chars"), 100_000_000);
  const thinkingChars = safeNonNegativeInteger(firstValue(input, "thinkingChars", "thinking_chars"), 100_000_000);
  const partialJsonChars = safeNonNegativeInteger(
    firstValue(input, "partialJsonChars", "partial_json_chars"), 100_000_000,
  );
  const type = firstValue(input, "type", "type");
  const subtype = firstValue(input, "subtype", "subtype");
  const toolName = firstValue(input, "toolName", "tool_name");
  const exitCode = firstValue(input, "exitCode", "exit_code");
  const signal = firstValue(input, "signal", "signal");
  const errorCode = firstValue(input, "errorCode", "error_code");
  const usage = safeUsage(input.usage);

  if (requestIndex !== undefined) output.requestIndex = requestIndex;
  if (requestCount !== undefined) output.requestCount = requestCount;
  if (requestBytes !== undefined) output.requestBytes = requestBytes;
  if (SAFE_METHODS.has(method as MeetingMinutesExecutionTraceEvent["method"])) {
    output.method = method as MeetingMinutesExecutionTraceEvent["method"];
  }
  if (path === "/v1/messages") output.path = path;
  const safeModelValue = safeModel(model);
  if (safeModelValue !== undefined) output.model = safeModelValue;
  if (SAFE_THINKING_TYPES.has(thinkingType as MeetingMinutesExecutionTraceThinkingType)) {
    output.thinkingType = thinkingType as MeetingMinutesExecutionTraceThinkingType;
  }
  if (thinkingBudgetTokens !== undefined) output.thinkingBudgetTokens = thinkingBudgetTokens;
  if (maxTokens !== undefined) output.maxTokens = maxTokens;
  if (SAFE_EFFORTS.has(effort as MeetingMinutesExecutionTraceEffort)) {
    output.effort = effort as MeetingMinutesExecutionTraceEffort;
  }
  if (statusCode !== undefined && statusCode >= 100) output.statusCode = statusCode;
  if (input.headersObserved === true || input.headers_observed === true) output.headersObserved = true;
  if (SAFE_CONTENT_TYPES.has(contentType as MeetingMinutesExecutionTraceEvent["contentType"])) {
    output.contentType = contentType as MeetingMinutesExecutionTraceEvent["contentType"];
  }
  if (bodyBytes !== undefined) output.bodyBytes = bodyBytes;
  if (sseType === "message_start" || sseType === "message_delta" || sseType === "message_stop") {
    output.sseType = sseType;
  }
  if (SAFE_DELTA_TYPES.has(deltaType as MeetingMinutesExecutionTraceDeltaType)) {
    output.deltaType = deltaType as MeetingMinutesExecutionTraceDeltaType;
  }
  if (textChars !== undefined) output.textChars = textChars;
  if (thinkingChars !== undefined) output.thinkingChars = thinkingChars;
  if (partialJsonChars !== undefined) output.partialJsonChars = partialJsonChars;
  if (SAFE_STDOUT_TYPES.has(type as NonNullable<MeetingMinutesExecutionTraceEvent["type"]>)) {
    output.type = type as MeetingMinutesExecutionTraceEvent["type"];
  }
  if (SAFE_STDOUT_SUBTYPES.has(subtype as NonNullable<MeetingMinutesExecutionTraceEvent["subtype"]>)) {
    output.subtype = subtype as MeetingMinutesExecutionTraceEvent["subtype"];
  }
  if (SAFE_TOOL_NAMES.has(toolName as NonNullable<MeetingMinutesExecutionTraceEvent["toolName"]>)) {
    output.toolName = toolName as MeetingMinutesExecutionTraceEvent["toolName"];
  }
  const safeExitCode = typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255
    ? exitCode : undefined;
  if (safeExitCode !== undefined) output.exitCode = safeExitCode;
  if (SAFE_SIGNALS.has(signal as NonNullable<MeetingMinutesExecutionTraceEvent["signal"]>)) {
    output.signal = signal as MeetingMinutesExecutionTraceEvent["signal"];
  }
  if (SAFE_ERROR_CODES.has(errorCode as NonNullable<MeetingMinutesExecutionTraceEvent["errorCode"]>)) {
    output.errorCode = errorCode as MeetingMinutesExecutionTraceEvent["errorCode"];
  }
  if (usage !== undefined) output.usage = usage;
  return output;
}

function traceRequestCount(events: MeetingMinutesExecutionTraceEvent[], input: Record<string, unknown>): number {
  let count = 0;
  for (const event of events) {
    if (event.event === "upstream_request_start") count += 1;
    if (event.requestCount !== undefined) count = Math.max(count, event.requestCount);
    if (event.requestIndex !== undefined) count = Math.max(count, event.requestIndex);
  }
  const supplied = safeNonNegativeInteger(firstValue(input, "requestCount", "request_count"), 1_000_000);
  return Math.max(count, supplied ?? 0);
}

/** Re-sanitize a trace before it is attached to a worker diagnostic/result. */
export function sanitizeMeetingMinutesExecutionTrace(value: unknown): MeetingMinutesExecutionTrace | null {
  const input = objectValue(value);
  if (!input) return null;
  const rawEvents = Array.isArray(input.events) ? input.events : input.event !== undefined ? [input] : [];
  const events: MeetingMinutesExecutionTraceEvent[] = [];
  for (const rawEvent of rawEvents) {
    const event = sanitizeTraceEvent(rawEvent);
    if (event) events.push(event);
  }
  const boundedEvents = events.slice(-MEETING_MINUTES_TRACE_MAX_EVENTS);
  if (boundedEvents.length === 0) return null;
  return {
    schemaVersion: MEETING_MINUTES_TRACE_SCHEMA_VERSION,
    requestCount: traceRequestCount(boundedEvents, input),
    events: boundedEvents,
  };
}

/** Parse only fixed-prefix trace lines from mixed child stderr. */
export function parseMeetingMinutesExecutionTrace(stderr: string): MeetingMinutesExecutionTrace | null {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  const rawEvents: unknown[] = [];
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.startsWith(MEETING_MINUTES_TRACE_PREFIX)) continue;
    const payload = line.slice(MEETING_MINUTES_TRACE_PREFIX.length);
    try {
      const parsed: unknown = JSON.parse(payload);
      if (rawEvents.length >= MEETING_MINUTES_TRACE_MAX_EVENTS) rawEvents.shift();
      rawEvents.push(parsed);
    } catch {
      // Child stderr is intentionally mixed in. Ignore malformed trace lines.
    }
  }
  return sanitizeMeetingMinutesExecutionTrace({ events: rawEvents });
}

export const MEETING_MINUTES_TRACE_RUNNER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startTenantAnthropicProxy } from "/opt/mana/tenant-claude-runner.mjs";

const TRACE_PREFIX = "MANA_MINUTES_TRACE ";
const TRACE_SCHEMA_VERSION = "meeting_minutes_execution_trace.v1";
const MAX_TRACE_EVENTS = 128;
const PROGRESS_INTERVAL_MS = 10000;
const TRACE_EVENT_NAMES = new Set([
  "runner_started", "runner_error", "runner_finished", "stdout_event",
  "upstream_request_start", "upstream_response_headers", "upstream_response_first_body_chunk",
  "upstream_response_last_body_chunk", "upstream_response_end", "upstream_response_error", "upstream_sse_event",
  "upstream_response_progress",
  "child_spawn", "child_error", "child_exit", "child_close", "proxy_close_start",
  "proxy_close_error", "proxy_close_end",
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SAFE_EFFORTS = new Set(["low", "medium", "high", "max", "xhigh"]);
const SAFE_THINKING_TYPES = new Set(["enabled", "disabled", "adaptive"]);
const SAFE_DELTA_TYPES = new Set(["text_delta", "thinking_delta", "input_json_delta"]);
const SAFE_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGQUIT"]);
const SAFE_STDOUT_TYPES = new Set(["system", "assistant", "user", "result", "error"]);
const SAFE_SSE_TYPES = new Set(["message_start", "message_delta", "message_stop"]);
const SAFE_STDOUT_SUBTYPES = new Set([
  "init", "hook_response", "success", "error_during_execution", "error_max_turns", "max_turns_reached",
  "error_max_budget_usd", "message_start", "message_delta", "message_stop", "content_block_start",
  "content_block_delta", "content_block_stop", "tool_use", "api_error", "rate_limit_error",
]);
const SAFE_TOOL_NAMES = new Set([
  "mcp__brainbase__brainbase_get_meeting_minutes_context", "mcp__brainbase__brainbase_resolve_turn",
  "mcp__brainbase__brainbase_judgment_state_record", "mcp__brainbase__brainbase_knowledge_resolve",
  "mcp__brainbase__brainbase_bootstrap_config", "mcp__task-write__task_write", "mcp__task-search__task_search",
  "mcp__google-drive__search",
]);
const SAFE_CONTENT_TYPES = new Set(["application/json", "text/event-stream", "text/plain"]);
const SAFE_ERROR_CODES = new Set([
  "provider_fetch_failed", "provider_stream_failed", "child_spawn_failed", "proxy_close_failed", "runner_failed",
]);
const TRACE_STARTED_AT = performance.now();
const traceEvents = [];
let requestCount = 0;

function elapsedMs() {
  return Math.max(0, Math.round(performance.now() - TRACE_STARTED_AT));
}

function safeInteger(value, max = 1000000000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function safeModel(value) {
  if (typeof value !== "string" || value.length > 128) return undefined;
  if (value === "sonnet" || value === "opus" || value === "haiku") return value;
  return /^(?:claude-(?:[0-9]+-){0,2}(?:sonnet|opus|haiku)(?:-[A-Za-z0-9]+){0,8})$/u.test(value)
    ? value : undefined;
}

function byteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
}

function bodyText(value) {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  } catch {
    return "";
  }
  return "";
}

function requestMetadata(body) {
  const raw = bodyText(body);
  if (!raw || raw.length > 2000000) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    const model = safeModel(value.model);
    if (model) output.model = model;
    const thinking = value.thinking;
    if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
      if (SAFE_THINKING_TYPES.has(thinking.type)) output.thinkingType = thinking.type;
      const budget = safeInteger(thinking.budget_tokens, 100000000);
      if (budget !== undefined) output.thinkingBudgetTokens = budget;
    }
    const maxTokens = safeInteger(value.max_tokens, 100000000);
    if (maxTokens !== undefined) output.maxTokens = maxTokens;
    const outputConfig = value.output_config;
    const effort = value.effort ?? (outputConfig && typeof outputConfig === "object" ? outputConfig.effort : undefined);
    if (SAFE_EFFORTS.has(effort)) output.effort = effort;
    return output;
  } catch {
    return {};
  }
}

function safeContentType(headers) {
  try {
    const value = headers.get("content-type");
    const contentType = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
    return SAFE_CONTENT_TYPES.has(contentType) ? contentType : undefined;
  } catch {
    return undefined;
  }
}

function safeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = {};
  const fields = [
    ["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"],
    ["cacheCreationInputTokens", "cache_creation_input_tokens"],
    ["cacheReadInputTokens", "cache_read_input_tokens"],
  ];
  for (const [camel, snake] of fields) {
    const item = safeInteger(value[camel] ?? value[snake], 100000000);
    if (item !== undefined) output[camel] = item;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function mergeUsage(current, next) {
  const safe = safeUsage(next);
  if (!safe) return current;
  const merged = { ...(current ?? {}) };
  for (const key of ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"]) {
    if (safe[key] !== undefined) merged[key] = Math.max(merged[key] ?? 0, safe[key]);
  }
  return merged;
}

function safeStringLength(value) {
  if (typeof value !== "string") return undefined;
  return Math.min(value.length, 100000000);
}

function safeDelta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = value.type;
  if (!SAFE_DELTA_TYPES.has(type)) return undefined;
  if (type === "text_delta") return { deltaType: type, textChars: safeStringLength(value.text) };
  if (type === "thinking_delta") return { deltaType: type, thinkingChars: safeStringLength(value.thinking) };
  return { deltaType: type, partialJsonChars: safeStringLength(value.partial_json) };
}

function addChars(current, next) {
  if (!Number.isSafeInteger(next) || next < 0) return current;
  return Math.min(current + next, 1000000000);
}

function emit(event, fields = {}, elapsedOverride) {
  if (!TRACE_EVENT_NAMES.has(event)) return;
  const record = { schemaVersion: TRACE_SCHEMA_VERSION, event,
    elapsedMs: elapsedOverride === undefined ? elapsedMs() : elapsedOverride, requestCount, ...fields };
  traceEvents.push(record);
  if (traceEvents.length > MAX_TRACE_EVENTS) traceEvents.shift();
  try {
    process.stderr.write(TRACE_PREFIX + JSON.stringify(record) + "\n");
  } catch {
    // Diagnostics must never change the child/proxy result.
  }
}

function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new Uint8Array(Buffer.from(String(chunk)));
}

function safeStdoutEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = value.type;
  if (!SAFE_STDOUT_TYPES.has(type)) return undefined;
  const output = { type };
  if (SAFE_STDOUT_SUBTYPES.has(value.subtype)) output.subtype = value.subtype;
  const directToolName = value.tool_name ?? value.toolName;
  if (SAFE_TOOL_NAMES.has(directToolName)) output.toolName = directToolName;
  const message = value.message;
  const content = message && typeof message === "object" && Array.isArray(message.content) ? message.content : undefined;
  if (!output.toolName && content) {
    for (const item of content) {
      if (item && typeof item === "object" && SAFE_TOOL_NAMES.has(item.name)) {
        output.toolName = item.name;
        break;
      }
    }
  }
  const usage = safeUsage(value.usage ?? (message && typeof message === "object" ? message.usage : undefined));
  if (usage) output.usage = usage;
  return output;
}

function createStdoutObserver() {
  const decoder = new TextDecoder();
  let pending = "";
  const processLine = (line) => {
    if (!line) return;
    try {
      const event = safeStdoutEvent(JSON.parse(line));
      if (event) emit("stdout_event", event);
    } catch {
      // Forwarded child output is not necessarily JSON.
    }
  };
  return {
    chunk(chunk) {
      try { process.stdout.write(chunk); } catch { /* preserve child execution */ }
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 300000) pending = pending.slice(-300000);
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/u, "");
        pending = pending.slice(index + 1);
        processLine(line);
      }
    },
    finish() {
      pending += decoder.decode();
      processLine(pending.replace(/\r$/u, ""));
      pending = "";
    },
  };
}

function createObservedFetch() {
  return async function observedFetch(input, options = {}) {
    const requestIndex = ++requestCount;
    let pathname;
    try { pathname = new URL(String(input)).pathname; } catch { pathname = undefined; }
    const body = options.body;
    const metadata = requestMetadata(body);
    emit("upstream_request_start", {
      requestIndex, requestCount, requestBytes: byteLength(body),
      ...(SAFE_METHODS.has(options.method ?? "GET") ? { method: options.method ?? "GET" } : {}),
      ...(pathname === "/v1/messages" ? { path: pathname } : {}),
      ...metadata,
    });
    let response;
    try {
      response = await fetch(input, options);
    } catch {
      emit("upstream_response_error", { requestIndex, requestCount, errorCode: "provider_fetch_failed" });
      throw new Error("provider_fetch_failed");
    }
    emit("upstream_response_headers", {
      requestIndex, requestCount, headersObserved: true, statusCode: response.status,
      ...(safeContentType(response.headers) ? { contentType: safeContentType(response.headers) } : {}),
    });
    if (!response.body) {
      emit("upstream_response_end", { requestIndex, requestCount, bodyBytes: 0 });
      return response;
    }
    let bodyBytes = 0;
    let firstBodyChunk = false;
    let lastBodyChunkElapsedMs;
    let lastProgressElapsedMs = elapsedMs();
    let usage;
    let textChars = 0;
    let thinkingChars = 0;
    let partialJsonChars = 0;
    let ssePending = "";
    const decoder = new TextDecoder();
    const deltaFields = () => ({
      ...(textChars > 0 ? { textChars } : {}),
      ...(thinkingChars > 0 ? { thinkingChars } : {}),
      ...(partialJsonChars > 0 ? { partialJsonChars } : {}),
    });
    const emitProgressIfDue = () => {
      if (!firstBodyChunk) return;
      const currentElapsedMs = elapsedMs();
      if (currentElapsedMs - lastProgressElapsedMs < PROGRESS_INTERVAL_MS) return;
      lastProgressElapsedMs = currentElapsedMs;
      emit("upstream_response_progress", {
        requestIndex, requestCount, bodyBytes, ...deltaFields(),
      }, currentElapsedMs);
    };
    const observeSse = (chunk, flush = false) => {
      ssePending += decoder.decode(chunk, { stream: !flush });
      if (ssePending.length > 300000) ssePending = ssePending.slice(-300000);
      const processSseLine = (line) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === "object") {
            const parsedUsage = parsed.usage ?? (parsed.message && typeof parsed.message === "object" ? parsed.message.usage : undefined);
            usage = mergeUsage(usage, parsedUsage);
            const delta = parsed.type === "content_block_delta" ? safeDelta(parsed.delta) : undefined;
            if (delta?.textChars !== undefined) textChars = addChars(textChars, delta.textChars);
            if (delta?.thinkingChars !== undefined) thinkingChars = addChars(thinkingChars, delta.thinkingChars);
            if (delta?.partialJsonChars !== undefined) partialJsonChars = addChars(partialJsonChars, delta.partialJsonChars);
            if (SAFE_SSE_TYPES.has(parsed.type)) {
              const safeParsedUsage = safeUsage(parsedUsage);
              emit("upstream_sse_event", {
                requestIndex, requestCount,
                ...(SAFE_SSE_TYPES.has(parsed.type) ? { sseType: parsed.type } : {}),
                ...(delta?.deltaType ? { deltaType: delta.deltaType } : {}),
                ...(safeParsedUsage ? { usage: safeParsedUsage } : {}),
              });
            }
          }
        } catch {
          // SSE content is intentionally not retained in diagnostics.
        }
      };
      let newline;
      while ((newline = ssePending.indexOf("\n")) >= 0) {
        const line = ssePending.slice(0, newline).replace(/\r$/u, "");
        ssePending = ssePending.slice(newline + 1);
        processSseLine(line);
      }
      if (flush && ssePending) {
        processSseLine(ssePending.replace(/\r$/u, ""));
        ssePending = "";
      }
    };
    const observedBodySource = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const bytes = asBytes(chunk);
        bodyBytes += bytes.byteLength;
        if (!firstBodyChunk && bytes.byteLength > 0) {
          firstBodyChunk = true;
          emit("upstream_response_first_body_chunk", { requestIndex, requestCount, bodyBytes });
        }
        if (bytes.byteLength > 0) lastBodyChunkElapsedMs = elapsedMs();
        observeSse(bytes);
        if (bytes.byteLength > 0) emitProgressIfDue();
        controller.enqueue(chunk);
      },
      flush() {
        observeSse(new Uint8Array(), true);
        if (bodyBytes > 0) {
          emit("upstream_response_last_body_chunk", { requestIndex, requestCount, bodyBytes }, lastBodyChunkElapsedMs);
        }
        emit("upstream_response_end", {
          requestIndex, requestCount, bodyBytes, ...deltaFields(), ...(usage ? { usage } : {}),
        });
      },
    }));
    let transformedReader;
    const observedBody = new ReadableStream({
      start() {
        transformedReader = observedBodySource.getReader();
      },
      async pull(controller) {
        try {
          const next = await transformedReader.read();
          if (next.done) {
            controller.close();
            transformedReader.releaseLock();
            return;
          }
          controller.enqueue(next.value);
        } catch {
          emit("upstream_response_error", { requestIndex, requestCount, bodyBytes, errorCode: "provider_stream_failed" });
          controller.error(new Error("provider_stream_failed"));
        }
      },
      async cancel() {
        emit("upstream_response_error", { requestIndex, requestCount, bodyBytes, errorCode: "provider_stream_failed" });
        try { await transformedReader?.cancel(); } catch { /* preserve the original cancellation */ }
      },
    });
    return new Response(observedBody, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}

function exitFields(code, signal) {
  const fields = {};
  const exitCode = safeInteger(code, 255);
  if (exitCode !== undefined) fields.exitCode = exitCode;
  if (SAFE_SIGNALS.has(signal)) fields.signal = signal;
  return fields;
}

async function runChild(args, env) {
  const stdout = createStdoutObserver();
  const child = spawn("/usr/local/bin/claude", args, {
    env,
    stdio: ["inherit", "pipe", "inherit"],
  });
  child.stdout?.on("data", (chunk) => stdout.chunk(chunk));
  child.once("spawn", () => emit("child_spawn"));
  child.once("error", () => emit("child_error", { errorCode: "child_spawn_failed" }));
  return new Promise((resolve, reject) => {
    let rejected = false;
    child.once("error", () => {
      rejected = true;
      reject(new Error("child_spawn_failed"));
    });
    child.once("exit", (code, signal) => emit("child_exit", exitFields(code, signal)));
    child.once("close", (code, signal) => {
      stdout.finish();
      emit("child_close", exitFields(code, signal));
      if (!rejected) resolve(safeInteger(code, 255) ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const args = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
  if (args.length === 0) throw new Error("claude_arguments_required");
  emit("runner_started");
  const proxy = await startTenantAnthropicProxy({
    tenantBoundaryHandle: process.env.MANA_TENANT_BOUNDARY_HANDLE,
    fetchImpl: createObservedFetch(),
  });
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = proxy.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = "mana-runtime-trusted-forwarder";
  let exitCode;
  try {
    exitCode = await runChild(args, env);
  } finally {
    emit("proxy_close_start");
    try {
      await proxy.close();
      emit("proxy_close_end");
    } catch {
      emit("proxy_close_error", { errorCode: "proxy_close_failed" });
      throw new Error("proxy_close_failed");
    }
  }
  emit("runner_finished", { ...(exitCode === undefined ? {} : { exitCode }) });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    emit("runner_error", { errorCode: "runner_failed" });
    process.stderr.write("trusted_provider_runner_failed\n");
    process.exitCode = 1;
  });
}
`;
