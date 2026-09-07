#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

const hookUrl = process.env.BRAINBASE_JUDGMENT_HOOK_URL
  || "https://brainbase-mcp.internal/host/judgment/hook";
const turnDir = process.env.BRAINBASE_JUDGMENT_TURN_DIR || "/tmp/mana-judgment-turns";
const MAX_HOOK_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_JUDGMENT_REQUEST_CHARS = 4_000;
const JUDGMENT_RECEIPT_PREFIX = "__MANA_JUDGMENT_RECEIPT_V1__:";
const VERIFIED_ANSWER_PREFIX = "__MANA_VERIFIED_ANSWER_V1__:";
const JUDGMENT_AUDIT_PREFIXES = ["🧠 判断参照:", "⚠️ 判断参照:"];
const BRAINBASE_AUDIT_PREFIXES = ["📚 Brainbase", "⚠️ Brainbase"];
const AUDIT_PREFIXES = [...JUDGMENT_AUDIT_PREFIXES, ...BRAINBASE_AUDIT_PREFIXES, "🔁 ", "🛠️ "];
const RECOVERABLE_BRAINBASE_TOOLS = new Set([
  "mcp__brainbase__brainbase_resolve_turn",
  "mcp__brainbase__brainbase_judgment_state_record",
]);

// Meeting-minutes generation is a non-interactive, schema-constrained batch
// operation. Its audit boundary is the Worker-issued context receipt, so an
// organization-managed interactive Hook must not rewrite or block its result.
// Keep the Hook enabled for every other runtime purpose.
if (process.env.MANA_DISABLE_INTERACTIVE_JUDGMENT_HOOK === "1") {
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_HOOK_PAYLOAD_BYTES) throw new Error("judgment_hook_payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function auditLinesFromText(value) {
  if (typeof value !== "string") return [];
  return value.split(/\r?\n/).filter((line) =>
    AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
}

function isInternalJudgmentStateTool(payload) {
  const toolName = payload.tool_name ?? payload.toolName;
  return toolName === "brainbase_judgment_state_record"
    || toolName === "mcp__brainbase__brainbase_judgment_state_record";
}

function isResolveTurnTool(payload) {
  const toolName = payload.tool_name ?? payload.toolName;
  return toolName === "brainbase_resolve_turn"
    || toolName === "mcp__brainbase__brainbase_resolve_turn";
}

function isBrainbaseTool(payload) {
  const toolName = payload.tool_name ?? payload.toolName;
  return typeof toolName === "string"
    && (toolName.startsWith("mcp__brainbase__") || toolName.startsWith("brainbase_"));
}

function repairedStopAnswer(answer, auditLines) {
  const bodyLines = typeof answer === "string" ? answer.split(/\r?\n/) : [];
  const bodyWithoutAudit = bodyLines.filter((line) =>
    !AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
  while (bodyWithoutAudit[0] === "") bodyWithoutAudit.shift();
  return [...auditLines, ...bodyWithoutAudit].join("\n");
}

function stopRepairRequiresModelAction(reason) {
  if (typeof reason !== "string") return false;
  return /(?:mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|brainbase_[a-z0-9_]+).{0,120}(?:実行|呼び出|tool call|call)/is.test(reason)
    || /(?:実行|呼び出|tool call|call).{0,120}(?:mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|brainbase_[a-z0-9_]+)/is.test(reason);
}

async function fetchHookEnvelope(payload) {
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MANA_TENANT_BOUNDARY_HANDLE ? {
        "x-mana-tenant-boundary-handle": process.env.MANA_TENANT_BOUNDARY_HANDLE,
      } : {}),
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) {
    let upstreamCode = "";
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && typeof parsed.error === "string"
          && /^[a-z0-9_]{1,80}$/.test(parsed.error)) upstreamCode = `_${parsed.error}`;
    } catch { /* Preserve the status-only fail-closed reason for non-JSON responses. */ }
    throw new Error(`judgment_hook_http_${response.status}${upstreamCode}`);
  }
  return JSON.parse(body);
}

async function validatedOutput(envelope, payload, {
  allowStopRepair = true,
  onStopRepair,
} = {}) {
  if (!envelope || typeof envelope !== "object" || envelope.schema_version !== "1"
      || envelope.accepted !== true || envelope.hook_event_name !== payload.hook_event_name
      || envelope.session_id !== payload.session_id || envelope.turn_id !== payload.turn_id
      || !envelope.output || typeof envelope.output !== "object" || Array.isArray(envelope.output)) {
    throw new Error("judgment_hook_response_invalid");
  }
  const isPostToolEvent = payload.hook_event_name === "PostToolUse"
    || payload.hook_event_name === "PostToolUseFailure";
  if (isPostToolEvent
      && (typeof payload.tool_use_id !== "string" || !payload.tool_use_id.trim()
        || typeof payload.tool_name !== "string" || !payload.tool_name.trim())) {
    throw new Error("judgment_hook_tool_identity_missing");
  }
  if (isPostToolEvent && !isInternalJudgmentStateTool(payload)
      && (typeof envelope.output.systemMessage !== "string" || !envelope.output.systemMessage.trim())) {
    throw new Error("judgment_hook_audit_not_recorded");
  }
  const hookSpecificOutput = envelope.output.hookSpecificOutput;
  if (payload.hook_event_name === "UserPromptSubmit"
      && (typeof envelope.receipt_id !== "string" || !envelope.receipt_id.trim()
        || typeof envelope.route_resolution_sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(envelope.route_resolution_sha256)
        || !hookSpecificOutput || typeof hookSpecificOutput !== "object"
        || Array.isArray(hookSpecificOutput)
        || hookSpecificOutput.hookEventName !== "UserPromptSubmit"
        || typeof hookSpecificOutput.additionalContext !== "string"
        || !hookSpecificOutput.additionalContext.trim())) {
    throw new Error("judgment_hook_route_receipt_missing");
  }
  const routeResolutionSha256 = payload.hook_event_name === "UserPromptSubmit"
    ? envelope.route_resolution_sha256
    : undefined;
  const { manaJudgmentReceipt: _unsupportedReceipt, ...documentedOutput } = envelope.output;
  const stopToolReceipts = payload.hook_event_name === "Stop"
    ? await completedToolReceipts(payload)
    : undefined;
  const receipt = {
    schema_version: "mana_judgment_hook_receipt.v1",
    hook_event_name: payload.hook_event_name,
    session_id: payload.session_id,
    turn_id: payload.turn_id,
    ...(typeof envelope.receipt_id === "string" && envelope.receipt_id.trim()
      ? { host_receipt_id: envelope.receipt_id } : {}),
    ...(routeResolutionSha256 ? { route_resolution_sha256: routeResolutionSha256 } : {}),
    ...(isPostToolEvent ? {
      tool_use_id: payload.tool_use_id,
      tool_name: payload.tool_name,
    } : {}),
    ...(stopToolReceipts ? { tool_receipts: stopToolReceipts } : {}),
  };
  // UserPromptSubmit and Stop systemMessages are interactive response-rewrite
  // instructions. Passing either back into a schema-constrained runtime turn can
  // replace structured_output with audit prose. PostToolUse and
  // PostToolUseFailure carry the non-empty Host audit required by this contract,
  // except for the already-exempt internal state-record control-plane call.
  const receiptMarker = `${JUDGMENT_RECEIPT_PREFIX}${JSON.stringify(receipt)}`;
  const existingSystemMessage = typeof documentedOutput.systemMessage === "string"
    ? documentedOutput.systemMessage.trim()
    : "";
  if (payload.hook_event_name === "UserPromptSubmit") {
    const canonicalContext = documentedOutput.hookSpecificOutput.additionalContext.trim();
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        // This Hook is used only by interactive reply turns. Preserve the Host's
        // canonical routing context and append the machine receipt used by the
        // runtime validator; replacing the context makes the final audit block
        // impossible to produce.
        additionalContext: [canonicalContext, receiptMarker].join("\n"),
      },
      systemMessage: receiptMarker,
    };
  }
  if (payload.hook_event_name === "Stop") {
    if (documentedOutput.decision === "block"
        && typeof documentedOutput.reason === "string"
        && documentedOutput.reason.trim()) {
      const requiredAuditLines = auditLinesFromText(documentedOutput.reason);
      const hasJudgmentAudit = requiredAuditLines.some((line) =>
        JUDGMENT_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
      const hasBrainbaseAudit = requiredAuditLines.some((line) =>
        BRAINBASE_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
      if (allowStopRepair && hasJudgmentAudit && hasBrainbaseAudit
          && !stopRepairRequiresModelAction(documentedOutput.reason)) {
        // Claude Code's non-interactive --print mode can return immediately after
        // a blocking Stop hook instead of sampling a second assistant message.
        // The authenticated Host reason contains the exact bounded audit repair.
        // Apply it once, then submit the repaired answer to the same Host turn;
        // only the second Host acceptance is exposed to the stream validator.
        const repairedPayload = {
          ...payload,
          // This is the wrapper-owned second Host attempt. Mark it active so a
          // remaining block is rejected as exhausted instead of starting a
          // second repair cycle. validatedOutput also disables local recursion.
          stop_hook_active: true,
          last_assistant_message: repairedStopAnswer(
            payload.last_assistant_message,
            requiredAuditLines,
          ),
        };
        await onStopRepair?.();
        const repairedEnvelope = await fetchHookEnvelope(repairedPayload);
        const repairedOutput = await validatedOutput(
          repairedEnvelope,
          repairedPayload,
          { allowStopRepair: false },
        );
        if (repairedOutput.decision === "block") {
          throw new Error("judgment_hook_stop_repair_incomplete");
        }
        return repairedOutput;
      }
      return {
        decision: "block",
        reason: documentedOutput.reason.trim(),
        systemMessage: receiptMarker,
      };
    }
    let stopSystemMessage = existingSystemMessage;
    const verifiedAnswer = typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message : "";
    const explicitFinalReceipt = documentedOutput.schema_version === "brainbase-judgment-final-v1"
      && documentedOutput.completion_status === "complete";
    // The Host validates last_assistant_message itself. Its systemMessage is a
    // display surface and may contain either the completed audit block or only
    // a completion notice, depending on the HTTP adapter. Bind audit lines to
    // the exact submitted answer for every non-blocking Stop acceptance.
    const verifiedAuditLines = auditLinesFromText(verifiedAnswer);
    const hasJudgmentAudit = verifiedAuditLines.some((line) =>
      JUDGMENT_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
    const hasBrainbaseAudit = verifiedAuditLines.some((line) =>
      BRAINBASE_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix))
      && !line.startsWith("📚 Brainbase監査未完了:"));
    const remoteAuditLines = auditLinesFromText(existingSystemMessage);
    const remoteHasJudgmentAudit = remoteAuditLines.some((line) =>
      JUDGMENT_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
    const remoteHasBrainbaseAudit = remoteAuditLines.some((line) =>
      BRAINBASE_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix))
      && !line.startsWith("📚 Brainbase監査未完了:"));
    if (allowStopRepair && !documentedOutput.decision
        && (!hasJudgmentAudit || !hasBrainbaseAudit)
        && remoteHasJudgmentAudit && remoteHasBrainbaseAudit) {
      // Some production Host adapters return a completed audit block as a
      // non-blocking systemMessage while Claude's submitted answer still lacks
      // that block. Resubmit the repaired answer once so the answer exposed to
      // Slack is itself Host-accepted rather than locally synthesized.
      const repairedPayload = {
        ...payload,
        stop_hook_active: true,
        last_assistant_message: repairedStopAnswer(verifiedAnswer, remoteAuditLines),
      };
      await onStopRepair?.();
      const repairedEnvelope = await fetchHookEnvelope(repairedPayload);
      const repairedOutput = await validatedOutput(
        repairedEnvelope,
        repairedPayload,
        { allowStopRepair: false },
      );
      if (repairedOutput.decision === "block") {
        throw new Error("judgment_hook_stop_repair_incomplete");
      }
      return repairedOutput;
    }
    // A non-blocking, identity-bound response proves that this exact
    // last_assistant_message passed Host validation. The final receipt remains
    // in the Host journal and need not be duplicated by the HTTP adapter.
    const canonicalRemoteCompletion = !documentedOutput.decision
      && hasJudgmentAudit && hasBrainbaseAudit;
    if (explicitFinalReceipt || canonicalRemoteCompletion) {
      // A completed Host receipt binds answer_digest to last_assistant_message
      // and proves the exact audit prefix. Recover those already-verified lines
      // for the runtime stream instead of replacing them with an incomplete
      // fallback that would make every successful repair fail closed.
      const verifiedAnswerDigest = createHash("sha256").update(verifiedAnswer).digest("hex");
      if (explicitFinalReceipt && (typeof documentedOutput.answer_digest !== "string"
          || documentedOutput.answer_digest !== verifiedAnswerDigest)) {
        throw new Error("judgment_hook_final_answer_digest_mismatch");
      }
      if (!hasJudgmentAudit || !hasBrainbaseAudit) {
        throw new Error("judgment_hook_final_audit_missing");
      }
      stopSystemMessage = verifiedAuditLines.join("\n");
      const verifiedAnswerMarker = `${VERIFIED_ANSWER_PREFIX}${JSON.stringify({
        answer: verifiedAnswer,
        answer_digest: verifiedAnswerDigest,
      })}`;
      return {
        // Claude Code --print can finish successfully after a Stop hook without
        // emitting its usual result event. Preserve the exact Host-verified
        // answer in the supported systemMessage field so the Worker can recover
        // it without trusting an unverified model fragment.
        systemMessage: [stopSystemMessage, receiptMarker, verifiedAnswerMarker]
          .filter(Boolean).join("\n"),
      };
    }
    if (!stopSystemMessage) throw new Error("judgment_hook_stop_output_invalid");
    return {
      // Stop carries the canonical final audit block. Keep it so Claude can
      // place the audit lines at the beginning of the final response, while the
      // receipt remains available to the stream validator.
      systemMessage: [stopSystemMessage, receiptMarker]
        .filter(Boolean).join("\n"),
    };
  }
  return {
    ...documentedOutput,
    // Claude Code documents systemMessage as Hook output. Keep the machine
    // receipt inside that supported field so --include-hook-events preserves it.
    systemMessage: [existingSystemMessage, receiptMarker]
      .filter(Boolean).join("\n"),
  };
}

function statePath(payload) {
  const identity = String(payload.session_id || payload.transcript_path || "missing-session");
  return join(turnDir, `${createHash("sha256").update(identity).digest("hex")}.json`);
}

async function persistTurnState(path, state) {
  await mkdir(turnDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

async function withTurnStateLock(path, operation) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await operation();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await delay(10);
    }
  }
  throw new Error("judgment_turn_state_lock_timeout");
}

async function updateTurnState(payload, update) {
  const path = statePath(payload);
  return withTurnStateLock(path, async () => {
    const { stored } = await readTurnState(payload);
    if (stored.turn_id !== payload.turn_id) throw new Error("judgment_turn_identity_mismatch");
    const next = await update(stored);
    if (next !== undefined) await persistTurnState(path, next);
    return next;
  });
}

async function readTurnState(payload) {
  const path = statePath(payload);
  try {
    const stored = JSON.parse(await readFile(path, "utf8"));
    if (typeof stored.turn_id === "string" && stored.turn_id) {
      return { path, stored };
    }
  } catch { /* fail closed below */ }
  throw new Error("judgment_turn_identity_missing");
}

async function transcriptBoundary(payload) {
  const transcriptPath = typeof payload.transcript_path === "string"
    ? payload.transcript_path.trim() : "";
  if (!transcriptPath) return {};
  try {
    const info = await stat(transcriptPath);
    if (!info.isFile()) throw new Error("judgment_hook_transcript_boundary_invalid");
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error("judgment_hook_transcript_too_large");
    }
    return {
      transcript_path: transcriptPath,
      transcript_start_offset: info.size,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { transcript_path: transcriptPath, transcript_start_offset: 0 };
    }
    if (error instanceof Error && error.message.startsWith("judgment_hook_")) throw error;
    throw new Error("judgment_hook_transcript_boundary_unreadable");
  }
}

async function resolveTurnId(payload) {
  const path = statePath(payload);
  if (payload.hook_event_name === "UserPromptSubmit") {
    const turnId = randomUUID();
    const boundary = await transcriptBoundary(payload);
    await persistTurnState(path, {
      turn_id: turnId,
      resolve_turn_completed: false,
      stop_repair_requested: false,
      ...boundary,
    });
    return turnId;
  }
  const { stored } = await readTurnState(payload);
  return stored.turn_id;
}

async function stopRepairActive(payload) {
  const { stored } = await readTurnState(payload);
  if (stored.turn_id !== payload.turn_id) throw new Error("judgment_turn_identity_mismatch");
  return stored.stop_repair_requested === true;
}

async function markStopRepairRequested(payload) {
  await updateTurnState(payload, (stored) => ({ ...stored, stop_repair_requested: true }));
}

async function requireResolveTurnFirst(payload) {
  const { path, stored } = await readTurnState(payload);
  if (stored.turn_id !== payload.turn_id) throw new Error("judgment_turn_identity_mismatch");
  if (stored.resolve_turn_completed === true) {
    if (isResolveTurnTool(payload)) throw new Error("judgment_resolve_turn_duplicate");
    return;
  }
  if (isResolveTurnTool(payload)) return;
  throw new Error(
    "judgment_resolve_turn_required_first: mcp__brainbase__brainbase_resolve_turnを最初に実行してください",
  );
}

async function markResolveTurnCompleted(payload) {
  await updateTurnState(payload, (stored) => ({ ...stored, resolve_turn_completed: true }));
}

async function recordCompletedToolReceipt(payload) {
  const toolUseId = payload.tool_use_id;
  const toolName = payload.tool_name;
  if (typeof toolUseId !== "string" || !toolUseId.trim()
      || typeof toolName !== "string" || !toolName.trim()) {
    throw new Error("judgment_hook_tool_identity_missing");
  }
  const outcome = payload.hook_event_name === "PostToolUse" ? "success" : "error";
  await updateTurnState(payload, (stored) => {
    const current = Array.isArray(stored.tool_receipts) ? stored.tool_receipts : [];
    const existing = current.find((entry) => entry?.tool_use_id === toolUseId);
    if (existing) {
      if (existing.tool_name !== toolName || existing.outcome !== outcome) {
        throw new Error("judgment_hook_tool_receipt_conflict");
      }
      return undefined;
    }
    return {
      ...stored,
      tool_receipts: [...current, {
        tool_use_id: toolUseId,
        tool_name: toolName,
        outcome,
      }],
    };
  });
}

async function completedToolReceipts(payload) {
  const { stored } = await readTurnState(payload);
  if (stored.turn_id !== payload.turn_id) throw new Error("judgment_turn_identity_mismatch");
  return Array.isArray(stored.tool_receipts) ? stored.tool_receipts : [];
}

function transcriptBlocks(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)
      && Object.hasOwn(message, "content")) {
    return Array.isArray(message.content)
      ? message.content : [message.content];
  }
  if (Object.hasOwn(record, "content")) {
    return Array.isArray(record.content) ? record.content : [record.content];
  }
  return [];
}

function transcriptToolResponse(resultBlock, record) {
  if (Object.hasOwn(record, "toolUseResult") && record.toolUseResult !== null
      && record.toolUseResult !== undefined) {
    if (Array.isArray(record.toolUseResult)) return { content: record.toolUseResult };
    if (record.toolUseResult && typeof record.toolUseResult === "object") {
      return record.toolUseResult;
    }
    throw new Error("judgment_hook_transcript_tool_response_invalid");
  }
  if (!Object.hasOwn(resultBlock, "content")) {
    throw new Error("judgment_hook_transcript_tool_response_missing");
  }
  if (Array.isArray(resultBlock.content)) return { content: resultBlock.content };
  if (resultBlock.content && typeof resultBlock.content === "object") return resultBlock.content;
  if (typeof resultBlock.content === "string") {
    return { content: [{ type: "text", text: resultBlock.content }] };
  }
  throw new Error("judgment_hook_transcript_tool_response_invalid");
}

async function readTranscriptLifecycleCalls(payload, stored) {
  const transcriptPath = typeof payload.transcript_path === "string"
    ? payload.transcript_path.trim() : "";
  if (!transcriptPath) return [];
  if (stored.transcript_path !== transcriptPath
      || !Number.isSafeInteger(stored.transcript_start_offset)
      || stored.transcript_start_offset < 0) {
    throw new Error("judgment_hook_transcript_boundary_missing");
  }
  let contents;
  try {
    contents = await readFile(transcriptPath);
  } catch {
    throw new Error("judgment_hook_transcript_unreadable");
  }
  if (contents.length > MAX_TRANSCRIPT_BYTES) throw new Error("judgment_hook_transcript_too_large");
  if (stored.transcript_start_offset > contents.length) {
    throw new Error("judgment_hook_transcript_truncated");
  }
  const suffix = contents.subarray(stored.transcript_start_offset).toString("utf8");
  const calls = new Map();
  const results = new Map();
  for (const line of suffix.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("judgment_hook_transcript_invalid");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("judgment_hook_transcript_invalid");
    }
    for (const block of transcriptBlocks(record)) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      if (block.type === "tool_use" && RECOVERABLE_BRAINBASE_TOOLS.has(block.name)) {
        if (typeof block.id !== "string" || !block.id.trim()) {
          throw new Error("judgment_hook_transcript_tool_identity_missing");
        }
        if (!Object.hasOwn(block, "input")) {
          throw new Error("judgment_hook_transcript_tool_input_missing");
        }
        if (calls.has(block.id)) throw new Error("judgment_hook_transcript_tool_identity_conflict");
        calls.set(block.id, {
          tool_use_id: block.id,
          tool_name: block.name,
          tool_input: block.input,
        });
      }
      if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id.trim()) continue;
        if (results.has(block.tool_use_id)) {
          throw new Error("judgment_hook_transcript_tool_result_conflict");
        }
        results.set(block.tool_use_id, {
          tool_response: transcriptToolResponse(block, record),
          failed: block.is_error === true || block.isError === true,
        });
      }
    }
  }
  const recovered = [];
  for (const call of calls.values()) {
    const result = results.get(call.tool_use_id);
    if (!result) throw new Error("judgment_hook_transcript_tool_result_missing");
    if (result.failed) throw new Error("judgment_hook_transcript_tool_failed");
    recovered.push({ ...call, ...result });
  }
  return recovered;
}

async function replayMissingLifecycleToolReceipts(payload) {
  if (payload.hook_event_name !== "Stop") return;
  const transcriptPath = typeof payload.transcript_path === "string"
    ? payload.transcript_path.trim() : "";
  if (!transcriptPath) return;
  const { stored } = await readTurnState(payload);
  if (stored.turn_id !== payload.turn_id) throw new Error("judgment_turn_identity_mismatch");
  const calls = await readTranscriptLifecycleCalls(payload, stored);
  const existing = Array.isArray(stored.tool_receipts) ? stored.tool_receipts : [];
  for (const call of calls) {
    const receipt = existing.find((entry) => entry?.tool_use_id === call.tool_use_id);
    if (receipt) {
      if (receipt.tool_name !== call.tool_name || receipt.outcome !== "success") {
        throw new Error("judgment_hook_tool_receipt_conflict");
      }
      continue;
    }
    const replayPayload = {
      hook_event_name: "PostToolUse",
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      turn_id: payload.turn_id,
      tool_use_id: call.tool_use_id,
      tool_name: call.tool_name,
      tool_input: call.tool_input,
      tool_response: call.tool_response,
    };
    const output = await validatedOutput(await fetchHookEnvelope(replayPayload), replayPayload);
    // Keep the local receipt durable after each Host call. If a subsequent
    // replay or Stop invocation is interrupted, this identity can be skipped
    // without sending a duplicate journal event to Brainbase.
    await recordCompletedToolReceipt(replayPayload);
    if (isResolveTurnTool(replayPayload)) await markResolveTurnCompleted(replayPayload);
    void output;
  }
}

try {
  const payload = await readStdin();
  const trustedRequest = process.env.MANA_JUDGMENT_REQUEST;
  if (payload.hook_event_name === "UserPromptSubmit" && trustedRequest !== undefined) {
    if (!trustedRequest.trim() || trustedRequest.length > MAX_JUDGMENT_REQUEST_CHARS) {
      throw new Error("judgment_request_invalid");
    }
    payload.prompt = trustedRequest;
  }
  payload.turn_id = await resolveTurnId(payload);
  if (payload.hook_event_name === "PreToolUse") {
    await requireResolveTurnFirst(payload);
    process.exit(0);
  }
  if ((payload.hook_event_name === "PostToolUse"
      || payload.hook_event_name === "PostToolUseFailure")
      && !isBrainbaseTool(payload)) {
    // The Claude matcher intentionally observes every tool so the first-tool
    // gate cannot be bypassed. Brainbase's Host journal, however, accepts only
    // Brainbase MCP lifecycle events. Do not forward unrelated tools and then
    // require a Brainbase audit line that the Host cannot produce.
    process.exit(0);
  }
  await replayMissingLifecycleToolReceipts(payload);
  // The wrapper owns Stop attempt identity. Claude's non-interactive runtime
  // may set stop_hook_active=true even on the first externally invoked Stop,
  // which would make the Host reject the repair before Claude can perform it.
  // Persist a repairable Host block, then mark only the next external Stop as
  // active. validatedOutput still marks its own bounded synthetic retry below.
  const stopRepairWasRequested = payload.hook_event_name === "Stop"
    ? await stopRepairActive(payload) : false;
  const hostPayload = payload.hook_event_name === "Stop"
    ? { ...payload, stop_hook_active: stopRepairWasRequested }
    : payload;
  const output = await validatedOutput(
    await fetchHookEnvelope(hostPayload),
    hostPayload,
    {
      allowStopRepair: !stopRepairWasRequested,
      ...(payload.hook_event_name === "Stop"
        ? { onStopRepair: () => markStopRepairRequested(payload) }
        : {}),
    },
  );
  if (payload.hook_event_name === "PostToolUse" || payload.hook_event_name === "PostToolUseFailure") {
    // Claude Code can omit an individual hook_response from stream-json even
    // after the Hook and Host both completed. Persist the Host-accepted
    // identity locally so the authenticated Stop receipt can prove the full
    // tool lifecycle without weakening fail-closed validation.
    await recordCompletedToolReceipt(payload);
  }
  if (payload.hook_event_name === "PostToolUse" && isResolveTurnTool(payload)) {
    // PostToolUse is emitted only after the MCP call completed. The Host has
    // now recorded the model-owned classification, so later tools may proceed.
    await markResolveTurnCompleted(payload);
  }
  if (payload.hook_event_name === "Stop" && output.decision === "block") {
    await markStopRepairRequested(payload);
  }
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // Claude Code reserves exit 2 for a blocking Hook failure. Other non-zero
  // exits are diagnostic only and would allow an unmanaged model call.
  process.exitCode = 2;
}
