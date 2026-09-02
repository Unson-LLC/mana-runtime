#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hookUrl = process.env.BRAINBASE_JUDGMENT_HOOK_URL
  || "https://brainbase-mcp.internal/host/judgment/hook";
const turnDir = process.env.BRAINBASE_JUDGMENT_TURN_DIR || "/tmp/mana-judgment-turns";
const MAX_HOOK_PAYLOAD_BYTES = 1024 * 1024;
const MAX_JUDGMENT_REQUEST_CHARS = 4_000;
const JUDGMENT_RECEIPT_PREFIX = "__MANA_JUDGMENT_RECEIPT_V1__:";
const VERIFIED_ANSWER_PREFIX = "__MANA_VERIFIED_ANSWER_V1__:";
const JUDGMENT_AUDIT_PREFIXES = ["🧠 判断参照:", "⚠️ 判断参照:"];
const BRAINBASE_AUDIT_PREFIXES = ["📚 Brainbase", "⚠️ Brainbase"];
const AUDIT_PREFIXES = [...JUDGMENT_AUDIT_PREFIXES, ...BRAINBASE_AUDIT_PREFIXES, "🔁 ", "🛠️ "];

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

function repairedStopAnswer(answer, auditLines) {
  const bodyLines = typeof answer === "string" ? answer.split(/\r?\n/) : [];
  const bodyWithoutAudit = bodyLines.filter((line) =>
    !AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
  while (bodyWithoutAudit[0] === "") bodyWithoutAudit.shift();
  return [...auditLines, ...bodyWithoutAudit].join("\n");
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

async function validatedOutput(envelope, payload, { allowStopRepair = true } = {}) {
  if (!envelope || typeof envelope !== "object" || envelope.schema_version !== "1"
      || envelope.accepted !== true || envelope.hook_event_name !== payload.hook_event_name
      || envelope.session_id !== payload.session_id || envelope.turn_id !== payload.turn_id
      || !envelope.output || typeof envelope.output !== "object" || Array.isArray(envelope.output)) {
    throw new Error("judgment_hook_response_invalid");
  }
  if (payload.hook_event_name === "PostToolUse"
      && !isInternalJudgmentStateTool(payload)
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
  const receipt = {
    schema_version: "mana_judgment_hook_receipt.v1",
    hook_event_name: payload.hook_event_name,
    session_id: payload.session_id,
    turn_id: payload.turn_id,
    ...(typeof envelope.receipt_id === "string" && envelope.receipt_id.trim()
      ? { host_receipt_id: envelope.receipt_id } : {}),
    ...(routeResolutionSha256 ? { route_resolution_sha256: routeResolutionSha256 } : {}),
  };
  // UserPromptSubmit and Stop systemMessages are interactive response-rewrite
  // instructions. Passing either back into a schema-constrained runtime turn can
  // replace structured_output with audit prose. PostToolUse is the one lifecycle
  // event whose non-empty audit message is part of the validated contract.
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
      if (allowStopRepair && hasJudgmentAudit && hasBrainbaseAudit) {
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
    const verifiedAuditLines = auditLinesFromText(
      explicitFinalReceipt ? verifiedAnswer : existingSystemMessage,
    );
    const hasJudgmentAudit = verifiedAuditLines.some((line) =>
      JUDGMENT_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix)));
    const hasBrainbaseAudit = verifiedAuditLines.some((line) =>
      BRAINBASE_AUDIT_PREFIXES.some((prefix) => line.startsWith(prefix))
      && !line.startsWith("📚 Brainbase監査未完了:"));
    // The production Brainbase HTTP adapter returns the canonical completed
    // Stop audit surface while retaining the final receipt in the Host journal.
    // A non-blocking, identity-bound response containing both required audit
    // namespaces therefore proves that this exact last_assistant_message passed
    // Host validation, even though the transport does not duplicate the final.
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

async function persistTurn(path, turnId) {
  await mkdir(turnDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ turn_id: turnId }), { mode: 0o600 });
  await rename(temporary, path);
}

async function resolveTurnId(payload) {
  const path = statePath(payload);
  if (payload.hook_event_name === "UserPromptSubmit") {
    const turnId = randomUUID();
    await persistTurn(path, turnId);
    return turnId;
  }
  try {
    const stored = JSON.parse(await readFile(path, "utf8"));
    if (typeof stored.turn_id === "string" && stored.turn_id) return stored.turn_id;
  } catch { /* fail closed below */ }
  throw new Error("judgment_turn_identity_missing");
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
  // This forwarder owns the bounded Stop repair cycle. Claude's
  // stop_hook_active flag describes Claude's own Hook retry state, not the
  // authenticated Host attempt made here. Always open Host validation as the
  // first attempt; validatedOutput marks only its one synthetic retry active.
  const hostPayload = payload.hook_event_name === "Stop"
    ? { ...payload, stop_hook_active: false }
    : payload;
  const output = await validatedOutput(await fetchHookEnvelope(hostPayload), hostPayload);
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // Claude Code reserves exit 2 for a blocking Hook failure. Other non-zero
  // exits are diagnostic only and would allow an unmanaged model call.
  process.exitCode = 2;
}
