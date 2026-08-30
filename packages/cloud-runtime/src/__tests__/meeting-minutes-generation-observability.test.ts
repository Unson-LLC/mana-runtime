import { generateMeetingMinutesInSandbox } from "../meeting-minutes-generator.js";
import { resumeMeetingMinutesRun, startMeetingMinutesRuns } from "../meeting-minutes-pipeline.js";
import { loadMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { MeetingMinutesDestination, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const destination: MeetingMinutesDestination = {
  id: "mana", projectId: "mana", contextProjectCode: "mana", taskProjectCodes: ["mana"],
  taskBoardTargetId: "minutes-mana", name: "mana", organization: { id: "unson", name: "雲孫" },
  slackChannelId: "CDEST", github: { owner: "Unson-LLC", repo: "mana" },
};
const context = {
  schema_version: "meeting_minutes_context_receipt.v1" as const, receipt_id: "receipt-1",
  identity: { run_id: "Ev1_F1", project_code: "mana", transcript_sha256: "a".repeat(64) },
  status: "resolved" as const, checksum: "b".repeat(64), resolved_at: "2026-08-18T10:00:00.000Z",
  context: { source_refs: [], open_tasks: [] },
};
const event: SlackQueueEvent = {
  tenantId: "unson", eventId: "Ev1", workspaceId: "T1", channelId: "CROUTER", threadTs: "1.1",
  messageTs: "1.1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
  files: [{ id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 100 }],
};
const selection: MeetingMinutesSelection = {
  kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "mana", workspaceId: "T1",
  appId: "A1", channelId: "CROUTER", threadTs: "1.1", userId: "U1", actionTs: "2.1",
};
const judgmentAuditLines = [
  "🧠 判断参照: 「議事録を生成する」を参照 → general/answer ✓",
  "📚 Brainbase未参照: 必須参照なし・実呼び出し0回 ✓",
];

function hook(event: "UserPromptSubmit" | "Stop") {
  const receipt = { schema_version: "mana_judgment_hook_receipt.v1", hook_event_name: event,
    session_id: "session-1", turn_id: "turn-1", host_receipt_id: `host-${event}`,
    ...(event === "UserPromptSubmit" ? { route_resolution_sha256: "c".repeat(64) } : {}) };
  return { type: "system", subtype: "hook_response", hook_event: event, exit_code: 0, outcome: "success",
    stdout: JSON.stringify({ systemMessage: [
      ...(event === "Stop" ? judgmentAuditLines : []),
      `__MANA_JUDGMENT_RECEIPT_V1__:${JSON.stringify(receipt)}`,
    ].join("\n") }) };
}

function successfulStream() {
  return [
    { type: "system", subtype: "init", session_id: "session-1" }, hook("UserPromptSubmit"), hook("Stop"),
    { type: "result", session_id: "session-1", result: `${judgmentAuditLines.join("\n")}\n${JSON.stringify({
      title: "定例", overview: "概要", body: "本文", tasks: [], used_source_refs: [], decision_candidates: [],
    })}` },
  ].map((item) => JSON.stringify(item)).join("\n");
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

describe("meeting minutes generation observability contract (RED)", () => {
  afterEach(() => vi.useRealTimers());

  it("returns safe success telemetry without persisting transcript or audited stream contents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-18T10:00:00.000Z");
    const stdout = successfulStream();
    const sandbox = { writeFile: vi.fn(), exec: vi.fn(async () => {
      vi.setSystemTime("2026-08-18T10:00:02.500Z");
      return { success: true, stdout, stderr: "" };
    }), destroy: vi.fn().mockResolvedValue(undefined) };

    const generated = asRecord(await generateMeetingMinutesInSandbox(
      "TRANSCRIPT_SECRET_123", destination, context, "required", { model: "opus", effort: "xhigh" }, sandbox,
      "tenant-boundary-handle",
    ));
    expect(generated.generationDiagnostics).toMatchObject({
      model: "sonnet", timeoutMs: 780_000, outcome: "success", elapsedMs: 2_500,
      progress: { prompt_written: true, exec_started: true, stdout_observed: true,
        hook_observed: true, result_observed: true },
    });
    expect(generated.generationDiagnostics.stdoutBytes).toBeGreaterThan(0);
    expect(generated.generationDiagnostics.streamEventCount).toBeGreaterThan(0);
    expect(JSON.stringify(generated.generationDiagnostics)).not.toContain("TRANSCRIPT_SECRET_123");
    expect(JSON.stringify(generated.generationDiagnostics)).not.toContain(stdout);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("classifies a normalized timeout and retains only safe execution metadata", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: false, exitCode: 124,
      outcome: "timeout", elapsedMs: 780_000, stderr: "command timed out after 780000ms Bearer TIMEOUT_SECRET",
      stdout: "PARTIAL_STDOUT_SECRET" }), destroy: vi.fn().mockResolvedValue(undefined) };
    let failure: unknown;
    try {
      await generateMeetingMinutesInSandbox("TRANSCRIPT_SECRET", destination, context, "required",
        { model: "opus", effort: "xhigh" }, sandbox, "tenant-boundary-handle");
    } catch (error) { failure = error; }
    const diagnostics = asRecord(failure).generationDiagnostics;
    expect(diagnostics).toMatchObject({ outcome: "timeout", elapsedMs: 780_000, exitCode: 124,
      stderrCode: "TIMEOUT", model: "sonnet", timeoutMs: 780_000 });
    expect(JSON.stringify(diagnostics)).not.toMatch(/TIMEOUT_SECRET|PARTIAL_STDOUT_SECRET|TRANSCRIPT_SECRET/);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("classifies a thrown Sandbox timeout without leaking its message or using the context timeout code", async () => {
    const timeout = new Error("timed out with Bearer THROW_TIMEOUT_SECRET");
    timeout.name = "TimeoutError";
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockRejectedValue(timeout),
      destroy: vi.fn().mockResolvedValue(undefined) };
    let failure: unknown;
    try {
      await generateMeetingMinutesInSandbox("TRANSCRIPT_SECRET", destination, context, "required",
        { model: "opus", effort: "xhigh" }, sandbox, "tenant-boundary-handle");
    } catch (error) { failure = error; }
    const diagnostics = asRecord(failure).generationDiagnostics;
    expect(failure).toMatchObject({ message: "meeting_minutes_generation_failed" });
    expect(diagnostics).toMatchObject({ outcome: "timeout", stderrCode: "TIMEOUT",
      progress: { prompt_written: true, exec_started: true } });
    expect(JSON.stringify(diagnostics)).not.toMatch(/THROW_TIMEOUT_SECRET|TRANSCRIPT_SECRET/);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    [1, "rate_limit_error", "RATE_LIMITED"],
    [2, "judgment_hook_http_503_judgment_hook_unavailable", "HOOK_FAILED"],
    [7, "Authorization: Bearer sk-secret; user@example.com; arbitrary_internal_code_X", "UNKNOWN"],
  ])("allowlists nonzero exit stderr classification (exit %i)", async (exitCode, stderr, stderrCode) => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: false, exitCode, stderr,
      stdout: "PARTIAL_STDOUT_SECRET" }), destroy: vi.fn().mockResolvedValue(undefined) };
    let failure: unknown;
    try {
      await generateMeetingMinutesInSandbox("TRANSCRIPT_SECRET", destination, context, "required",
        { model: "opus", effort: "xhigh" }, sandbox, "tenant-boundary-handle");
    } catch (error) { failure = error; }
    const diagnostics = asRecord(failure).generationDiagnostics;
    expect(diagnostics).toMatchObject({ outcome: "nonzero_exit", exitCode, stderrCode });
    expect(JSON.stringify(diagnostics)).not.toMatch(/sk-secret|user@example.com|arbitrary_internal_code_X|PARTIAL_STDOUT_SECRET/);
  });

  it("durably checkpoints exec_started before an unresolved sandbox execution can finish", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    let rejectGeneration!: (error: Error) => void;
    const generate = vi.fn(async (_transcript, _destination, _context, _mode, observe) => {
      await observe?.({ schemaVersion: "meeting_minutes_generation_diagnostics.v1",
        startedAt: "2026-08-18T10:00:00.000Z", model: "sonnet", timeoutMs: 780_000,
        progress: { prompt_written: true, exec_started: true } });
      return new Promise<never>((_, reject) => { rejectGeneration = reject; });
    });
    const processing = resumeMeetingMinutesRun(fs, selection, {
      destinations: [destination], contextMode: "required", resolveContext: vi.fn(async () => context),
      download: vi.fn().mockResolvedValue("TRANSCRIPT_SECRET"), postProcessingStatus: vi.fn().mockResolvedValue("3.1"),
      generate, saveGitHub: vi.fn(), createTask: vi.fn(), postParent: vi.fn(), postThreadChunk: vi.fn(),
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

    const started = await loadMeetingMinutesRun(fs, selection.runId);
    const generation = asRecord(started?.diagnostics).generation;
    expect(generation).toMatchObject({
      startedAt: expect.any(String), model: "sonnet", timeoutMs: 780_000,
      progress: { prompt_written: true, exec_started: true },
    });
    expect(generation).not.toHaveProperty("finishedAt");
    expect(generation).not.toHaveProperty("outcome");
    expect(JSON.stringify(started)).not.toContain("TRANSCRIPT_SECRET");

    rejectGeneration(new Error("test_cleanup"));
    await expect(processing).rejects.toThrow("test_cleanup");
  });
});
