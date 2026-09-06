import { describe, expect, it, vi } from "vitest";

import { runMeetingMinutesGenerationProbe } from "../meeting-minutes-generation-probe.js";
import type {
  AuditedGeneratedMeetingMinutes,
  MeetingMinutesContextReceipt,
  MeetingMinutesDestination,
  MeetingMinutesRun,
} from "../meeting-minutes-contracts.js";

const destination: MeetingMinutesDestination = {
  id: "mana", projectId: "project-mana", contextProjectCode: "mana", taskProjectCodes: ["mana"],
  taskBoardTargetId: "board-mana", name: "Mana", organization: { id: "unson", name: "Unson" },
  slackChannelId: "CDEST", github: { owner: "Unson-LLC", repo: "mana" },
};
const transcript = "CONFIDENT_TRANSCRIPT_CONTENT";
const sourceRef = { type: "decision", id: "decision-1" };

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function receiptFor(runId: string, value = transcript): Promise<MeetingMinutesContextReceipt> {
  return {
    schema_version: "meeting_minutes_context_receipt.v1", receipt_id: "receipt-1",
    identity: { run_id: runId, project_code: "mana", transcript_sha256: await digest(value) },
    status: "resolved", checksum: "checksum-1", resolved_at: "2026-09-06T00:00:00.000Z",
    context: { source_refs: [sourceRef], open_tasks: [] },
  };
}

function runFor(runId: string, receipt?: MeetingMinutesContextReceipt): MeetingMinutesRun {
  return {
    version: 1, runId, eventId: "event-1", workspaceId: "workspace-1", sourceAppId: "app-1",
    sourceChannelId: "CROUTER", sourceThreadTs: "100.200", sourceMessageTs: "100.200",
    file: { id: "file-1", name: "minutes.txt", mimetype: "text/plain", size: transcript.length }, status: "failed",
    destination, ...(receipt ? { transcriptSha256: receipt.identity.transcript_sha256,
      context: { receiptId: receipt.receipt_id, checksum: receipt.checksum, status: receipt.status,
        mode: "required" as const, sourceRefs: receipt.context.source_refs, resolvedAt: receipt.resolved_at,
        receipt } } : {}),
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

function generatedFor(receipt: MeetingMinutesContextReceipt): AuditedGeneratedMeetingMinutes {
  const generated = {
    title: "会議の決定", overview: "概要", body: "本文", tasks: [{ title: "確認する" }],
    used_source_refs: [sourceRef], decision_candidates: [{ title: "決定", source_ref_ids: [sourceRef.id] }],
    brainbase_context_attestation: { schema_version: "meeting_minutes_context_attestation.v2" as const,
      source: "worker_context_receipt" as const, receipt_id: receipt.receipt_id, checksum: receipt.checksum,
      run_id: receipt.identity.run_id, project_code: receipt.identity.project_code,
      transcript_sha256: receipt.identity.transcript_sha256, session_id: "probe-session" },
  } as AuditedGeneratedMeetingMinutes;
  Object.defineProperty(generated, "generationDiagnostics", { enumerable: false, value: {
    schemaVersion: "meeting_minutes_generation_diagnostics.v1", startedAt: "2026-09-06T00:00:00.000Z",
    model: "sonnet", timeoutMs: 780_000, elapsedMs: 2_750, outcome: "success", progress: {
      prompt_written: true, exec_started: true, stdout_observed: true, hook_observed: true, result_observed: true,
    }, stdoutBytes: 123, streamEventCount: 4,
  } });
  return generated;
}

function dependencies(overrides: Partial<Parameters<typeof runMeetingMinutesGenerationProbe>[1]> = {}) {
  return {
    contextMode: "required" as const,
    download: vi.fn(async () => transcript),
    resolveContext: vi.fn(async (identity) => receiptFor(identity.run_id)),
    generate: vi.fn(async (_text, _destination, context) => generatedFor(context)),
    ...overrides,
  };
}

describe("runMeetingMinutesGenerationProbe", () => {
  it("reuses the saved receipt, reads no write dependencies, and exposes non-enumerable diagnostics safely", async () => {
    const receipt = await receiptFor("run-1");
    const run = runFor("run-1", receipt);
    const before = structuredClone(run);
    const deps = dependencies();

    const result = await runMeetingMinutesGenerationProbe(run, deps);

    expect(result).toMatchObject({ ok: true, stage: "completed", code: null,
      progress: { downloaded: true, transcriptVerified: true, contextResolved: true,
        generationStarted: true, generationCompleted: true },
      result: { taskCount: 1, sourceRefCount: 1, decisionCandidateCount: 1,
        titleChars: 5, overviewChars: 2, bodyChars: 2 },
      generation: { outcome: "success", model: "sonnet", elapsedMs: 2_750,
        timeoutMs: 780_000, stdoutBytes: 123, streamEventCount: 4 },
    });
    expect(deps.download).toHaveBeenCalledWith("file-1");
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(transcript);
    expect(JSON.stringify(result)).not.toContain("receipt-1");
    expect(run).toEqual(before);
  });

  it("resolves context for a legacy run without persisting the computed identity", async () => {
    const run = runFor("legacy-run");
    const resolveContext = vi.fn(async (identity: MeetingMinutesContextReceipt["identity"]) =>
      receiptFor(identity.run_id));
    const deps = dependencies({ resolveContext });

    const result = await runMeetingMinutesGenerationProbe(run, deps);

    expect(result.ok).toBe(true);
    expect(result.progress.transcriptVerified).toBeNull();
    expect(resolveContext).toHaveBeenCalledOnce();
    expect(resolveContext.mock.calls[0]?.[0]).toEqual({
      run_id: "legacy-run", project_code: "mana", transcript_sha256: await digest(transcript),
    });
    expect(run.context).toBeUndefined();
    expect(run.transcriptSha256).toBeUndefined();
  });

  it("rejects a changed transcript before resolving context or generating", async () => {
    const run = runFor("run-2");
    run.transcriptSha256 = "0".repeat(64);
    const deps = dependencies();

    const result = await runMeetingMinutesGenerationProbe(run, deps);

    expect(result).toMatchObject({ ok: false, stage: "download", code: "meeting_minutes_transcript_changed",
      progress: { downloaded: true, transcriptVerified: false, contextResolved: false,
        generationStarted: false, generationCompleted: false }, result: null, generation: null });
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("sanitizes generator failures and keeps raw output, transcript, and secret messages out", async () => {
    const run = runFor("run-3", await receiptFor("run-3"));
    const deps = dependencies({
      generate: vi.fn(async (_text, _destination, _context, _mode, observe) => {
        await observe?.({
          schemaVersion: "meeting_minutes_generation_diagnostics.v1", startedAt: "now", model: "sonnet",
          timeoutMs: 780_000, elapsedMs: 12, outcome: "transport_failure", progress: {
            prompt_written: true, exec_started: true,
          },
        });
        const error = new Error("Bearer TOP_SECRET raw stdout CONFIDENT_TRANSCRIPT_CONTENT");
        Object.assign(error, { generationDiagnostics: {
          schemaVersion: "meeting_minutes_generation_diagnostics.v1", startedAt: "now", model: "Bearer MODEL_SECRET",
          timeoutMs: 780_000, elapsedMs: 780_001, outcome: "nonzero_exit", exitCode: 124,
          stderrCode: "UNKNOWN", stdout: "RAW_STDOUT_SECRET", stderr: "RAW_STDERR_SECRET",
          progress: { prompt_written: true, exec_started: true },
        } });
        throw error;
      }),
    });

    const result = await runMeetingMinutesGenerationProbe(run, deps);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ ok: false, stage: "generation", code: "meeting_minutes_generation_probe_failed",
      progress: { downloaded: true, transcriptVerified: true, contextResolved: true,
        generationStarted: true, generationCompleted: false }, generation: {
        outcome: "nonzero_exit", model: null, elapsedMs: 780_001, exitCode: 124,
        stderrCode: "UNKNOWN", stdoutBytes: null, streamEventCount: null,
        progress: { prompt_written: true, exec_started: true, stdout_observed: null,
          hook_observed: null, result_observed: null },
      } });
    expect(serialized).not.toMatch(/TOP_SECRET|MODEL_SECRET|RAW_STDOUT_SECRET|RAW_STDERR_SECRET|CONFIDENT_TRANSCRIPT_CONTENT/);
  });
});
