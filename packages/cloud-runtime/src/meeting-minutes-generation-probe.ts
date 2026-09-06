import {
  assertMeetingMinutesContextUsable,
  bindGeneratedMeetingMinutesContext,
  validateMeetingMinutesContextReceipt,
} from "./meeting-minutes-brainbase-context.js";
import type {
  AuditedGeneratedMeetingMinutes,
  MeetingMinutesContextMode,
  MeetingMinutesContextReceipt,
  MeetingMinutesDestination,
  MeetingMinutesGenerationDiagnostics,
  MeetingMinutesRun,
} from "./meeting-minutes-contracts.js";

export const MEETING_MINUTES_GENERATION_PROBE = "meeting-minutes-generation" as const;
export type MeetingMinutesGenerationProbeStage = "download" | "context" | "generation" | "completed";

export interface MeetingMinutesGenerationProbeResult {
  ok: boolean;
  probe: typeof MEETING_MINUTES_GENERATION_PROBE;
  runId: string;
  stage: MeetingMinutesGenerationProbeStage;
  code: string | null;
  durationMs: number | null;
  progress: {
    downloaded: boolean;
    transcriptVerified: boolean | null;
    contextResolved: boolean;
    generationStarted: boolean;
    generationCompleted: boolean;
  };
  generation: SafeMeetingMinutesGenerationDiagnostics | null;
  result: {
    taskCount: number;
    sourceRefCount: number;
    decisionCandidateCount: number;
    titleChars: number;
    overviewChars: number;
    bodyChars: number;
  } | null;
}

export interface SafeMeetingMinutesGenerationDiagnostics {
  outcome: MeetingMinutesGenerationDiagnostics["outcome"] | null;
  model: string | null;
  timeoutMs: number | null;
  elapsedMs: number | null;
  exitCode: number | null;
  stderrCode: MeetingMinutesGenerationDiagnostics["stderrCode"] | null;
  progress: {
    prompt_written: boolean | null;
    exec_started: boolean | null;
    stdout_observed: boolean | null;
    hook_observed: boolean | null;
    result_observed: boolean | null;
  };
  stdoutBytes: number | null;
  streamEventCount: number | null;
}

export interface MeetingMinutesGenerationProbeDependencies {
  download(fileId: string): Promise<string>;
  resolveContext(
    identity: MeetingMinutesContextReceipt["identity"],
    receiptId?: string,
    projectId?: string,
  ): Promise<MeetingMinutesContextReceipt>;
  generate(
    transcript: string,
    destination: MeetingMinutesDestination,
    context: MeetingMinutesContextReceipt,
    mode: MeetingMinutesContextMode,
    observe?: (diagnostics: MeetingMinutesGenerationDiagnostics) => Promise<void>,
  ): Promise<AuditedGeneratedMeetingMinutes>;
  contextMode: MeetingMinutesContextMode;
}

const SAFE_ERROR_CODES = new Set([
  "meeting_minutes_generation_probe_failed", "meeting_minutes_destination_missing",
  "meeting_minutes_transcript_empty", "meeting_minutes_transcript_changed",
  "meeting_minutes_context_identity_missing", "meeting_minutes_context_receipt_missing",
  "meeting_minutes_context_invalid_receipt", "meeting_minutes_context_identity_mismatch",
  "meeting_minutes_context_changed", "meeting_minutes_context_partial",
  "meeting_minutes_context_unavailable", "meeting_minutes_context_output_mismatch",
  "meeting_minutes_context_source_ref_unknown", "meeting_minutes_context_attestation_mismatch",
  "meeting_minutes_context_mode_invalid", "meeting_minutes_generation_failed",
  "meeting_minutes_generation_invalid", "meeting_minutes_generation_result_error",
  "meeting_minutes_generation_result_missing", "meeting_minutes_generation_stream_malformed",
  "meeting_minutes_generation_stream_too_large", "meeting_minutes_generation_stream_too_many_events",
]);
const GENERATION_OUTCOMES = new Set<MeetingMinutesGenerationDiagnostics["outcome"]>([
  "success", "timeout", "nonzero_exit", "transport_failure",
]);
const STDERR_CODES = new Set<MeetingMinutesGenerationDiagnostics["stderrCode"]>([
  "TIMEOUT", "RATE_LIMITED", "AUTHENTICATION_FAILED", "HOOK_FAILED", "CLI_ERROR", "UNKNOWN",
]);
const SAFE_MODELS = new Set(["sonnet", "opus"]);

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value)
    ? value : null;
}

function safeModel(value: unknown): string | null {
  return typeof value === "string" && SAFE_MODELS.has(value) ? value : null;
}

export function sanitizeMeetingMinutesGenerationDiagnostics(value: unknown): SafeMeetingMinutesGenerationDiagnostics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<MeetingMinutesGenerationDiagnostics>;
  const progress = input.progress && typeof input.progress === "object" && !Array.isArray(input.progress)
    ? input.progress : undefined;
  const bool = (item: unknown): boolean | null => typeof item === "boolean" ? item : null;
  return {
    outcome: GENERATION_OUTCOMES.has(input.outcome) ? input.outcome! : null,
    model: safeModel(input.model), timeoutMs: safeNumber(input.timeoutMs), elapsedMs: safeNumber(input.elapsedMs),
    exitCode: typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode) ? input.exitCode : null,
    stderrCode: STDERR_CODES.has(input.stderrCode) ? input.stderrCode! : null,
    progress: {
      prompt_written: bool(progress && "prompt_written" in progress ? progress.prompt_written : undefined),
      exec_started: bool(progress && "exec_started" in progress ? progress.exec_started : undefined),
      stdout_observed: bool(progress && "stdout_observed" in progress ? progress.stdout_observed : undefined),
      hook_observed: bool(progress && "hook_observed" in progress ? progress.hook_observed : undefined),
      result_observed: bool(progress && "result_observed" in progress ? progress.result_observed : undefined),
    },
    stdoutBytes: safeNumber(input.stdoutBytes), streamEventCount: safeNumber(input.streamEventCount),
  };
}

async function transcriptDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR_CODES.has(message) ? message : "meeting_minutes_generation_probe_failed";
}

function failureResult(
  runId: string, stage: MeetingMinutesGenerationProbeStage, code: string,
  startedAt: number, progress: MeetingMinutesGenerationProbeResult["progress"], diagnostics?: unknown,
): MeetingMinutesGenerationProbeResult {
  return {
    ok: false, probe: MEETING_MINUTES_GENERATION_PROBE, runId, stage, code,
    durationMs: safeNumber(Math.max(0, Date.now() - startedAt)), progress,
    generation: sanitizeMeetingMinutesGenerationDiagnostics(diagnostics), result: null,
  };
}

export async function runMeetingMinutesGenerationProbe(
  run: MeetingMinutesRun,
  dependencies: MeetingMinutesGenerationProbeDependencies,
): Promise<MeetingMinutesGenerationProbeResult> {
  const startedAt = Date.now();
  const progress = { downloaded: false, transcriptVerified: null as boolean | null, contextResolved: false,
    generationStarted: false, generationCompleted: false };
  let stage: MeetingMinutesGenerationProbeStage = "download";
  let diagnostics: unknown;
  try {
    if (!run.destination) throw new Error("meeting_minutes_destination_missing");
    stage = "download";
    const transcript = await dependencies.download(run.file.id);
    progress.downloaded = true;
    if (!transcript.trim()) throw new Error("meeting_minutes_transcript_empty");
    const transcriptSha256 = await transcriptDigest(transcript);
    if (run.transcriptSha256 && run.transcriptSha256 !== transcriptSha256) {
      progress.transcriptVerified = false;
      throw new Error("meeting_minutes_transcript_changed");
    }
    progress.transcriptVerified = run.transcriptSha256 ? true : null;
    stage = "context";
    const identity = { run_id: run.runId, project_code: run.destination.contextProjectCode, transcript_sha256: transcriptSha256 };
    if (!run.context?.receiptId) throw new Error("meeting_minutes_context_receipt_missing");
    const contextValue = run.context.receipt ?? await dependencies.resolveContext(
      identity, run.context.receiptId, run.destination.projectId,
    );
    const context = validateMeetingMinutesContextReceipt(contextValue, identity);
    if (run.context && (run.context.receiptId !== context.receipt_id || run.context.checksum !== context.checksum)) {
      throw new Error("meeting_minutes_context_changed");
    }
    assertMeetingMinutesContextUsable(context, dependencies.contextMode);
    progress.contextResolved = true;
    stage = "generation";
    progress.generationStarted = true;
    // Keep the diagnostic path observational even if an adapter mutates its inputs.
    const generationDestination = structuredClone(run.destination);
    const generationContext = structuredClone(context);
    const generated = await dependencies.generate(transcript, generationDestination, generationContext, dependencies.contextMode,
      async (value) => { diagnostics = value; });
    diagnostics = generated.generationDiagnostics ?? diagnostics;
    const bound = bindGeneratedMeetingMinutesContext(generated, generationContext, dependencies.contextMode);
    progress.generationCompleted = true;
    return {
      ok: true, probe: MEETING_MINUTES_GENERATION_PROBE, runId: run.runId, stage: "completed", code: null,
      durationMs: safeNumber(Math.max(0, Date.now() - startedAt)), progress,
      generation: sanitizeMeetingMinutesGenerationDiagnostics(diagnostics),
      result: {
        taskCount: bound.tasks?.length ?? 0, sourceRefCount: bound.used_source_refs?.length ?? 0,
        decisionCandidateCount: bound.decision_candidates?.length ?? 0,
        titleChars: bound.title.length, overviewChars: bound.overview.length, bodyChars: bound.body.length,
      },
    };
  } catch (error) {
    if (error && typeof error === "object" && "generationDiagnostics" in error) {
      diagnostics = (error as { generationDiagnostics?: unknown }).generationDiagnostics;
    }
    return failureResult(run.runId, stage, errorCode(error), startedAt, progress, diagnostics);
  }
}
