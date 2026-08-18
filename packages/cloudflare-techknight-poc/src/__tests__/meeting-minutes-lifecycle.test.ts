import { processMeetingMinutesSelectionWithStatus } from "../meeting-minutes-lifecycle.js";
import { startMeetingMinutesRuns } from "../meeting-minutes-pipeline.js";
import { loadMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { GeneratedMeetingMinutes, MeetingMinutesContextReceipt, MeetingMinutesDestination,
  MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const destination: MeetingMinutesDestination = { id: "mana", projectId: "mana", contextProjectCode: "mana",
  taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana", name: "mana",
  organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } };
const event: SlackQueueEvent = { tenantId: "unson", eventId: "Ev1", workspaceId: "T1", channelId: "CROUTER",
  threadTs: "1.1", messageTs: "1.1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
  files: [{ id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 100 }] };
const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "mana",
  workspaceId: "T1", channelId: "CROUTER", userId: "U1", actionTs: "2.1" };

async function setup() {
  const fs = new MemoryFs();
  await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", destinations: [destination],
    requestDestination: vi.fn().mockResolvedValue("2.1") });
  return fs;
}
function resume(overrides: Record<string, unknown> = {}) {
  const overriddenGenerate = overrides.generate as ((...args: unknown[]) => Promise<GeneratedMeetingMinutes>) | undefined;
  const defaultGenerate = vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" });
  const generate = vi.fn(async (transcript: string, target: MeetingMinutesDestination,
    context: MeetingMinutesContextReceipt, mode: string) => ({
    ...await (overriddenGenerate ?? defaultGenerate)(transcript, target, context, mode),
    brainbase_context_attestation: {
      schema_version: "meeting_minutes_context_attestation.v1" as const,
      tool_name: "mcp__brainbase__brainbase_get_meeting_minutes_context" as const,
      receipt_id: context.receipt_id, checksum: context.checksum,
      run_id: context.identity.run_id, project_code: context.identity.project_code,
      transcript_sha256: context.identity.transcript_sha256, session_id: "session-test",
    },
  }));
  return { contextMode: "observe" as const,
    resolveContext: vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-1", identity, status: "resolved" as const, checksum: "checksum-1",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } })),
    postProcessingStatus: vi.fn().mockResolvedValue("3.1"), download: vi.fn().mockResolvedValue("transcript"),
    createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    saveGitHub: vi.fn().mockResolvedValue({ transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "mu" }),
    postParent: vi.fn().mockResolvedValue("10.1"), postThreadChunk: vi.fn().mockResolvedValue("10.2"),
    ...overrides, generate };
}
const config = { enabled: true, routerChannelId: "CROUTER", destinations: [destination], operatorUserIds: new Set(["U1"]) };

describe("meeting minutes source status lifecycle", () => {
  it("projects completed only after the durable run completes", async () => {
    const fs = await setup(); const updateStatus = vi.fn().mockResolvedValue(undefined);
    const run = await processMeetingMinutesSelectionWithStatus(fs, selection, config, resume(), { updateStatus });
    expect(run.status).toBe("completed");
    expect(updateStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), "completed");
  });

  it("projects failed and preserves Queue retry when processing fails", async () => {
    const fs = await setup(); const updateStatus = vi.fn().mockResolvedValue(undefined);
    await expect(processMeetingMinutesSelectionWithStatus(fs, selection, config,
      resume({ saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) }), { updateStatus })).rejects.toThrow("github down");
    expect(updateStatus).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.any(Object) }), "failed");
  });

  it("projects completed with a task warning instead of retrying the whole minutes run", async () => {
    const fs = await setup(); const updateStatus = vi.fn().mockResolvedValue(undefined);
    const run = await processMeetingMinutesSelectionWithStatus(fs, selection, config, resume({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask: vi.fn().mockRejectedValue(new Error("project_code_not_allowed")),
    }), { updateStatus });
    expect(run).toMatchObject({ status: "completed",
      taskRegistration: { failure: { index: 0, message: "project_code_not_allowed" } },
      diagnostics: { stage: "task_registration", code: "TASK_PROJECT_CODE_NOT_ALLOWED", retryable: false } });
    expect(run).not.toHaveProperty("failure");
    expect(updateStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), "completed");
    expect(updateStatus).not.toHaveBeenCalledWith(expect.anything(), "failed");
  });

  it("retries only the completion projection without repeating completed work", async () => {
    const fs = await setup(); const logProjectionError = vi.fn();
    const operations = resume();
    const updateStatus = vi.fn().mockRejectedValueOnce(new Error("slack update down")).mockResolvedValue(undefined);
    await expect(processMeetingMinutesSelectionWithStatus(fs, selection, config, operations, {
      updateStatus, logProjectionError,
    })).rejects.toThrow("slack update down");
    const run = await processMeetingMinutesSelectionWithStatus(fs, selection, config, operations, { updateStatus, logProjectionError });
    expect(run.status).toBe("completed");
    expect(operations.generate).toHaveBeenCalledTimes(1);
    expect(operations.saveGitHub).toHaveBeenCalledTimes(1);
    expect(operations.postParent).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledTimes(2);
    expect(logProjectionError).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed",
      runId: selection.runId, stage: "status_projection", code: "STATUS_PROJECTION_FAILED" }));
    expect(JSON.stringify(logProjectionError.mock.calls)).not.toContain("slack update down");
  });

  it("preserves the processing error when the failure projection also fails", async () => {
    const fs = await setup(); const logProjectionError = vi.fn();
    await expect(processMeetingMinutesSelectionWithStatus(fs, selection, config,
      resume({ saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) }), {
        updateStatus: vi.fn().mockRejectedValue(new Error("slack update down")), logProjectionError,
      })).rejects.toThrow("github down");
    expect(logProjectionError).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed",
      stage: "status_projection", code: "STATUS_PROJECTION_FAILED" }));
    const persisted = await loadMeetingMinutesRun(fs, selection.runId);
    expect(persisted).toMatchObject({ status: "failed", diagnostics: { stage: "github_save", code: "GITHUB_SAVE_FAILED" },
      projectionFailure: { stage: "status_projection", code: "STATUS_PROJECTION_FAILED" } });
    expect(JSON.stringify(logProjectionError.mock.calls)).not.toContain("slack update down");
  });
});
