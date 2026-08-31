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

function validatedOutput(envelope, payload) {
  if (!envelope || typeof envelope !== "object" || envelope.schema_version !== "1"
      || envelope.accepted !== true || envelope.hook_event_name !== payload.hook_event_name
      || envelope.session_id !== payload.session_id || envelope.turn_id !== payload.turn_id
      || !envelope.output || typeof envelope.output !== "object" || Array.isArray(envelope.output)) {
    throw new Error("judgment_hook_response_invalid");
  }
  if (payload.hook_event_name === "PostToolUse"
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
  const existingSystemMessage = payload.hook_event_name === "PostToolUse"
    && typeof documentedOutput.systemMessage === "string"
    ? documentedOutput.systemMessage.trim()
    : "";
  if (payload.hook_event_name === "UserPromptSubmit") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        // The upstream context is written for an interactive assistant turn and
        // can replace the schema-constrained meeting-minutes response. The
        // signed route receipt is the only context the runtime needs here.
        additionalContext: receiptMarker,
      },
      systemMessage: receiptMarker,
    };
  }
  if (payload.hook_event_name === "Stop") {
    return { systemMessage: receiptMarker };
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
  const output = validatedOutput(JSON.parse(body), payload);
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // Claude Code reserves exit 2 for a blocking Hook failure. Other non-zero
  // exits are diagnostic only and would allow an unmanaged model call.
  process.exitCode = 2;
}
