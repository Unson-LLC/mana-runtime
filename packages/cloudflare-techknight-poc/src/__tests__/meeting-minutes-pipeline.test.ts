import { redoMeetingMinutesRun, resumeMeetingMinutesRun, startMeetingMinutesRuns } from "../meeting-minutes-pipeline.js";
import type { GeneratedMeetingMinutes, MeetingMinutesContextReceipt, MeetingMinutesDestination,
  MeetingMinutesRedo, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import { TaskApiError } from "@openryoko/task-runtime-core";

const destination: MeetingMinutesDestination = { id: "mana", projectId: "mana", contextProjectCode: "mana",
  taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana", name: "mana",
  organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } };
const event: SlackQueueEvent = { tenantId: "unson", eventId: "Ev1", workspaceId: "T1", channelId: "CROUTER",
  threadTs: "1.1", messageTs: "1.1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
  files: [{ id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 100 }] };
const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "mana",
  workspaceId: "T1", channelId: "CROUTER", userId: "U1", actionTs: "2.1" };
const redo: MeetingMinutesRedo = { kind: "meeting_minutes_redo", runId: "Ev1_F1", workspaceId: "T1",
  channelId: "CROUTER", userId: "U1", actionTs: "20.1" };
function audited(minutes: GeneratedMeetingMinutes, context: MeetingMinutesContextReceipt) {
  return { ...minutes, brainbase_context_attestation: {
    schema_version: "meeting_minutes_context_attestation.v1" as const,
    tool_name: "mcp__brainbase__brainbase_get_meeting_minutes_context" as const,
    receipt_id: context.receipt_id, checksum: context.checksum,
    run_id: context.identity.run_id, project_code: context.identity.project_code,
    transcript_sha256: context.identity.transcript_sha256, session_id: "session-test",
  } };
}
function resumeOptions(overrides: Record<string, unknown> = {}) {
  const overriddenGenerate = overrides.generate as ((...args: unknown[]) => Promise<GeneratedMeetingMinutes>) | undefined;
  const defaultGenerate = vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" });
  const generate = vi.fn(async (transcript: string, target: MeetingMinutesDestination,
    context: MeetingMinutesContextReceipt, mode: string) => audited(
    await (overriddenGenerate ?? defaultGenerate)(transcript, target, context, mode), context));
  return { destinations: [destination], contextMode: "observe" as const,
    resolveContext: vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-1", identity, status: "resolved" as const, checksum: "checksum-1",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } })),
    download: vi.fn().mockResolvedValue("transcript"),
    postProcessingStatus: vi.fn().mockResolvedValue("3.1"),
    createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    saveGitHub: vi.fn().mockResolvedValue({ transcriptPath: "docs/transcripts/a.txt", minutesPath: "docs/minutes/a.md",
      transcriptUrl: "https://github/t", minutesUrl: "https://github/m" }),
    postParent: vi.fn().mockResolvedValue("10.1"), postThreadChunk: vi.fn().mockResolvedValue("10.2"),
    ...overrides, generate };
}

describe("meeting minutes pipeline", () => {
  it("stops a placeholder generation before GitHub, Slack, task, or board side effects", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const saveGitHub = vi.fn(); const createTask = vi.fn(); const repairTaskBoard = vi.fn();
    const postParent = vi.fn(); const postThreadChunk = vi.fn();
    const options = resumeOptions({
      generate: vi.fn().mockRejectedValue(new Error("meeting_minutes_generation_placeholder_output")),
      saveGitHub, createTask, repairTaskBoard, postParent, postThreadChunk,
    });

    await expect(resumeMeetingMinutesRun(fs, selection, options))
      .rejects.toThrow("meeting_minutes_generation_placeholder_output");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      status: "failed",
      failure: { message: "meeting_minutes_generation_placeholder_output" },
    });
    expect(saveGitHub).not.toHaveBeenCalled(); expect(createTask).not.toHaveBeenCalled();
    expect(repairTaskBoard).not.toHaveBeenCalled(); expect(postParent).not.toHaveBeenCalled();
    expect(postThreadChunk).not.toHaveBeenCalled();
  });

  it("persists one processing reply before generation and reuses it on retry", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const postProcessingStatus = vi.fn().mockResolvedValue("3.1");
    const generate = vi.fn().mockRejectedValueOnce(new Error("generator down"))
      .mockResolvedValueOnce({ title: "定例", overview: "概要", body: "本文" });
    const options = resumeOptions({ postProcessingStatus, generate });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("generator down");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      status: "failed",
      failure: { stage: "routed", message: "generator down" },
    });
    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried.slack?.processingTs).toBe("3.1");
    expect(postProcessingStatus).toHaveBeenCalledTimes(1);
    expect(postProcessingStatus).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannelId: "CROUTER", sourceThreadTs: "1.1", destination: expect.objectContaining({ id: "mana" }),
    }));
  });

  it("uses the explicit Brainbase context project without changing task or destination identity", async () => {
    const fs = new MemoryFs();
    const kartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [kartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-kartz", identity, status: "resolved" as const, checksum: "checksum-kartz",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const options = resumeOptions({ destinations: [kartz], resolveContext });
    const run = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, options);
    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "unson" }), undefined);
    expect(run.destination).toMatchObject({ projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" });
  });

  it("refreshes a persisted Kartz run from the legacy context project before retrying", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "unson", taskProjectCodes: ["unson"],
      taskBoardTargetId: "minutes-kartz" };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [legacyKartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await expect(resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [legacyKartz],
      resolveContext: vi.fn().mockRejectedValue(new Error("meeting_minutes_context_request_failed:403")),
    }))).rejects.toThrow("meeting_minutes_context_request_failed:403");

    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-kartz-retry", identity, status: "resolved" as const, checksum: "checksum-kartz-retry",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const run = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [configuredKartz], resolveContext,
    }));

    expect(resolveContext).toHaveBeenLastCalledWith(expect.objectContaining({ project_code: "unson" }), undefined);
    expect(run.destination).toMatchObject({ projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" });
  });

  it("discards an unsaved legacy context and generation before retrying with the corrected project", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "kartz", taskProjectCodes: ["kartz"] };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [legacyKartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = await loadMeetingMinutesRun(fs, selection.runId);
    expect(persisted).toBeDefined();
    persisted!.destination = legacyKartz;
    persisted!.status = "failed";
    persisted!.transcriptSha256 = "54e6289e14c7b0e7ad9acc2dfc4c1e3d027d0eef7f5c4c3fe7c292761d0e06a6";
    persisted!.context = { receiptId: "receipt-legacy", checksum: "checksum-legacy", status: "resolved",
      mode: "observe", resolvedAt: "2026-08-15T00:00:00.000Z", sourceRefs: [] };
    persisted!.generated = audited({ title: "旧議事録", overview: "旧概要", body: "旧本文" }, {
      schema_version: "meeting_minutes_context_receipt.v1", receipt_id: "receipt-legacy",
      identity: { run_id: selection.runId, project_code: "unson",
        transcript_sha256: "54e6289e14c7b0e7ad9acc2dfc4c1e3d027d0eef7f5c4c3fe7c292761d0e06a6" },
      status: "resolved", checksum: "checksum-legacy", resolved_at: "2026-08-15T00:00:00.000Z",
      context: { source_refs: [], open_tasks: [] },
    });
    persisted!.failure = { stage: "routed", message: "meeting_minutes_context_project_changed" };
    await saveMeetingMinutesRun(fs, persisted!);

    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-kartz", identity, status: "resolved" as const, checksum: "checksum-kartz",
      resolved_at: "2026-08-16T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const generate = vi.fn().mockResolvedValue({ title: "新議事録", overview: "新概要", body: "新本文" });
    const run = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [configuredKartz], resolveContext, generate,
    }));

    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "kartz" }), undefined);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ status: "completed", context: { receiptId: "receipt-kartz" },
      destination: { contextProjectCode: "kartz", taskProjectCodes: ["kartz"] }, generated: { title: "新議事録" } });
  });

  it("keeps an immutable saved Receipt while correcting task bindings on an existing run", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "kartz", taskProjectCodes: ["kartz"] };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [legacyKartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskApiError(403, "project_code_not_allowed", "project code is not allowed"))
      .mockResolvedValueOnce({ id: "task-kartz" });
    const original = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [legacyKartz],
      generate: vi.fn().mockResolvedValue({ title: "Kartz定例", overview: "概要", body: "本文",
        tasks: [{ title: "確認する" }] }),
      createTask,
    }));
    expect(original).toMatchObject({ status: "completed", context: { receiptId: "receipt-1" },
      destination: { contextProjectCode: "unson" }, taskRegistration: { failure: { status: 403 } } });

    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-1", identity, status: "resolved" as const, checksum: "checksum-1",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const retried = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [configuredKartz], resolveContext, createTask,
    }));

    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "unson" }), "receipt-1");
    expect(createTask).toHaveBeenLastCalledWith(expect.objectContaining({ project_codes: ["kartz"] }), expect.any(String));
    expect(retried).toMatchObject({ status: "completed", context: { receiptId: "receipt-1" },
      destination: { contextProjectCode: "unson", taskProjectCodes: ["kartz"] } });
    expect(retried.taskRegistration).not.toHaveProperty("failure");
    expect(retried.github).toEqual(original.github);
  });

  it("creates one stable awaiting run and does not duplicate the selector", async () => {
    const fs = new MemoryFs(); const requestDestination = vi.fn().mockResolvedValue("2.1");
    const first = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", destinations: [destination], requestDestination });
    const second = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", destinations: [destination], requestDestination });
    expect(first[0]).toMatchObject({ runId: "Ev1_F1", status: "awaiting_destination" });
    expect(second[0]?.runId).toBe("Ev1_F1"); expect(requestDestination).toHaveBeenCalledTimes(1);
  });

  it("classifies once, persists the suggestion, and reuses it on event retry", async () => {
    const fs = new MemoryFs();
    const download = vi.fn().mockResolvedValue("SalesTailorの定例です");
    const classifyDestination = vi.fn().mockResolvedValue({ destinationId: "mana", reason: "案件名が一致" });
    const requestDestination = vi.fn().mockResolvedValue("2.1");
    const options = { enabled: true, routerChannelId: "CROUTER", destinations: [destination],
      download, classifyDestination, requestDestination };
    const first = await startMeetingMinutesRuns(fs, event, options);
    const second = await startMeetingMinutesRuns(fs, event, options);
    expect(first[0]?.routing).toEqual({ evaluated: true, suggestedDestinationId: "mana", reason: "案件名が一致" });
    expect(requestDestination).toHaveBeenCalledWith(expect.objectContaining({ routing: first[0]?.routing }), [destination]);
    expect(second[0]?.routing).toEqual(first[0]?.routing);
    expect(download).toHaveBeenCalledTimes(1);
    expect(classifyDestination).toHaveBeenCalledTimes(1);
  });

  it("falls back to the manual selector when classification cannot decide", async () => {
    const fs = new MemoryFs(); const requestDestination = vi.fn().mockResolvedValue("2.1");
    const run = (await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], download: vi.fn().mockResolvedValue("曖昧な会議"),
      classifyDestination: vi.fn().mockResolvedValue(null), requestDestination }))[0];
    expect(run?.routing).toEqual({ evaluated: true });
    expect(requestDestination).toHaveBeenCalledWith(expect.objectContaining({ routing: { evaluated: true } }), [destination]);
    expect(run?.status).toBe("awaiting_destination");
  });

  it("shares minutes before registering tasks with stable idempotency and trusted project scope", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const order: string[] = [];
    const createTask = vi.fn(async () => { order.push("task"); return { id: "task-42" }; });
    const repairTaskBoard = vi.fn(async () => { order.push("canvas"); });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20T00:00:00+09:00" },
      ] }),
      saveGitHub: vi.fn(async () => { order.push("github"); return { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "mu" }; }),
      createTask,
      repairTaskBoard,
      postParent: vi.fn(async () => { order.push("slack"); return "10.1"; }),
    });
    const run = await resumeMeetingMinutesRun(fs, selection, options);
    expect(order).toEqual(["github", "slack", "task", "canvas"]);
    expect(repairTaskBoard).toHaveBeenCalledWith("minutes-mana");
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "請求書を送る", project_codes: ["mana"] }),
      expect.stringMatching(/^meeting-minutes-/),
    );
    expect(run.taskRegistration?.registered).toEqual([{ index: 0, title: "請求書を送る", taskId: "task-42",
      projectCodes: ["mana"] }]);
    expect(options.postThreadChunk).toHaveBeenCalledWith(
      "CDEST", "10.1", "meeting.txt", expect.not.stringContaining("Brainbaseへタスクを1件登録しました"),
      expect.any(Number), expect.any(Number), expect.any(String),
    );
  });

  it("posts the parent summary, narrative chunks, then the task card last", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const visibleOrder: string[] = [];
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [{ title: "確認する" }] }),
      postParent: vi.fn(async () => { visibleOrder.push("parent"); return "10.1"; }),
      postThreadChunk: vi.fn(async () => { visibleOrder.push("chunk"); return "10.2"; }),
      postTaskCard: vi.fn(async () => { visibleOrder.push("task-card"); return "10.3"; }),
    });
    const run = await resumeMeetingMinutesRun(fs, selection, options);
    expect(visibleOrder).toEqual(["parent", "chunk", "task-card"]);
    expect(run.slack?.taskCardTs).toBe("10.3");
  });

  it("retries only the task card after it fails without duplicating narrative chunks", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const postParent = vi.fn().mockResolvedValue("10.1");
    const postThreadChunk = vi.fn().mockResolvedValue("10.2");
    const postTaskCard = vi.fn().mockRejectedValueOnce(new Error("task card down")).mockResolvedValueOnce("10.3");
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [{ title: "確認する" }] }),
      postParent, postThreadChunk, postTaskCard,
    });
    const deferred = await resumeMeetingMinutesRun(fs, selection, options);
    expect(deferred).toMatchObject({
      status: "completed", slack: { parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { failure: { stage: "task_card", message: "task card down" } },
    });

    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried).toMatchObject({ status: "completed", slack: { taskCardTs: "10.3", postedChunkIndexes: [0] } });
    expect(postParent).toHaveBeenCalledTimes(1);
    expect(postThreadChunk).toHaveBeenCalledTimes(1);
    expect(postTaskCard).toHaveBeenCalledTimes(2);
  });

  it("resolves a named assignee to the canonical person id before task creation", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValue({ id: "task-42" });
    const resolveAssignee = vi.fn().mockResolvedValue({ status: "resolved", personId: "per_umeda" });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", assignee_name: "梅田 遼" },
      ] }), createTask, resolveAssignee,
    }));
    expect(resolveAssignee).toHaveBeenCalledWith("梅田 遼", "mana");
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ assignee_person_id: "per_umeda" }), expect.any(String));
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty("assignee_name");
  });

  it.each(["unknown", "ambiguous"])("registers the task without guessing when named assignee is %s", async (status) => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValue({ id: "task-42" });
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", assignee_name: "梅田 遼" },
      ] }), createTask, resolveAssignee: vi.fn().mockResolvedValue({ status }),
    }));
    expect(run.status).toBe("completed");
    expect(createTask).toHaveBeenCalledWith(expect.not.objectContaining({
      assignee_name: expect.anything(), assignee_person_id: expect.anything(),
    }), expect.any(String));
  });

  it("completes the minutes and defers the task when the assignee graph is unavailable", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn();
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", assignee_name: "梅田 遼" },
      ] }), createTask, resolveAssignee: vi.fn().mockResolvedValue({ status: "unavailable" }),
    }));
    expect(run).toMatchObject({ status: "completed",
      taskRegistration: { failure: { index: 0, message: "meeting_minutes_assignee_unavailable" } } });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("accepts minutes with no explicit tasks without creating a task", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
    });
    const run = await resumeMeetingMinutesRun(fs, selection, options);
    expect(run.status).toBe("completed");
    expect(options.createTask).not.toHaveBeenCalled();
    expect(options.postThreadChunk).not.toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.stringContaining("Brainbaseタスク自動登録"), expect.any(String),
    );
  });

  it("retries only the unregistered tasks after a partial task API failure", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockResolvedValueOnce({ id: "task-1" })
      .mockRejectedValueOnce(new Error("task api down"))
      .mockResolvedValueOnce({ id: "task-2" });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "資料を更新する" }, { title: "請求書を送る" },
      ] }),
      createTask,
    });
    const first = await resumeMeetingMinutesRun(fs, selection, options);
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "completed",
      slack: { parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { failure: { index: 1, message: "task api down" } } });
    expect(first).not.toHaveProperty("failure");
    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried.taskRegistration?.registered.map((task) => task.taskId)).toEqual(["task-1", "task-2"]);
    expect(createTask).toHaveBeenCalledTimes(3);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ title: "資料を更新する" });
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ title: "請求書を送る" });
    expect(createTask.mock.calls[2]?.[0]).toMatchObject({ title: "請求書を送る" });
    expect(createTask.mock.calls[1]?.[1]).toBe(createTask.mock.calls[2]?.[1]);
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    expect(retried.taskRegistration).not.toHaveProperty("failure");
  });

  it("shares GitHub-saved minutes even when canonical task registration is unavailable", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskApiError(403, "project_code_not_allowed", "project code is not allowed"))
      .mockResolvedValueOnce({ id: "task-kartz" });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "Kartzの確認事項を進める" },
      ] }),
      createTask,
    });

    const deferred = await resumeMeetingMinutesRun(fs, selection, options);

    expect(deferred).toMatchObject({ status: "completed",
      slack: { parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { failure: { index: 0, stage: "task_registration", code: "project_code_not_allowed",
        status: 403, message: "project code is not allowed" } } });
    expect(deferred).not.toHaveProperty("failure");
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    const canonicalTaskDestination = { ...destination, taskProjectCodes: ["unson"],
      taskBoardTargetId: "minutes-unson" };
    const retried = await resumeMeetingMinutesRun(fs, selection, {
      ...options, destinations: [canonicalTaskDestination],
    });
    expect(retried.status).toBe("completed");
    expect(retried.destination).toMatchObject({ projectId: "mana", taskProjectCodes: ["unson"],
      taskBoardTargetId: "minutes-unson" });
    expect(retried.taskRegistration?.registered).toEqual([
      { index: 0, title: "Kartzの確認事項を進める", taskId: "task-kartz", projectCodes: ["unson"] },
    ]);
    expect(retried.taskRegistration).not.toHaveProperty("failure");
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]?.[1]).toBe(createTask.mock.calls[1]?.[1]);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ project_codes: ["mana"] });
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ project_codes: ["unson"] });
  });

  it("keeps the task-only retry until board repair and the final task card both complete", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValue({ id: "task-kartz" });
    const repairTaskBoard = vi.fn().mockRejectedValueOnce(new Error("board down")).mockResolvedValueOnce(undefined);
    const postTaskCard = vi.fn().mockResolvedValue("10.3");
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask, repairTaskBoard, postTaskCard,
    });

    const deferred = await resumeMeetingMinutesRun(fs, selection, options);
    expect(deferred).toMatchObject({ status: "completed",
      taskRegistration: { registered: [{ taskId: "task-kartz" }],
        failure: { stage: "task_board", message: "board down" } } });
    expect(postTaskCard).not.toHaveBeenCalled();

    const recovered = await resumeMeetingMinutesRun(fs, selection, options);
    expect(recovered.status).toBe("completed");
    expect(recovered.taskRegistration).not.toHaveProperty("failure");
    expect(recovered.slack?.taskCardTs).toBe("10.3");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledTimes(2);
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    expect(postTaskCard).toHaveBeenCalledTimes(1);
  });

  it("resumes only the task card stage after task card posting fails", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValue({ id: "task-kartz" });
    const repairTaskBoard = vi.fn().mockResolvedValue(undefined);
    const postTaskCard = vi.fn()
      .mockRejectedValueOnce(new Error("task card down"))
      .mockResolvedValueOnce("10.3");
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask, repairTaskBoard, postTaskCard,
    });

    const deferred = await resumeMeetingMinutesRun(fs, selection, options);
    expect(deferred).toMatchObject({ status: "completed",
      taskRegistration: { registered: [{ taskId: "task-kartz" }],
        failure: { stage: "task_card", message: "task card down" } } });
    expect(deferred.slack?.taskCardTs).toBeUndefined();

    const recovered = await resumeMeetingMinutesRun(fs, selection, options);
    expect(recovered.status).toBe("completed");
    expect(recovered.taskRegistration).not.toHaveProperty("failure");
    expect(recovered.slack?.taskCardTs).toBe("10.3");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledTimes(1);
    expect(options.postParent).toHaveBeenCalledTimes(1);
    expect(options.postThreadChunk).toHaveBeenCalledTimes(1);
    expect(postTaskCard).toHaveBeenCalledTimes(2);
  });

  it("saves GitHub before Slack and completes", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const order: string[] = []; const options = resumeOptions({
      saveGitHub: vi.fn(async () => { order.push("github"); return { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "mu" }; }),
      postParent: vi.fn(async () => { order.push("slack-parent"); return "10.1"; }),
      postThreadChunk: vi.fn(async () => { order.push("slack-chunk"); return "10.2"; }),
    });
    const run = await resumeMeetingMinutesRun(fs, selection, options);
    expect(run.status).toBe("completed"); expect(order).toEqual(["github", "slack-parent", "slack-chunk"]);
    expect(options.postParent).toHaveBeenCalledWith("CDEST", "meeting.txt", "*定例*\n概要", "Ev1_F1-revision-0-parent");
    expect(options.postThreadChunk).toHaveBeenCalledWith(
      "CDEST",
      "10.1",
      "meeting.txt",
      "------------\n\n本文",
      0,
      1,
      "Ev1_F1-revision-0-chunk-0",
    );
  });

  it("does not duplicate a leading narrative separator", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "------------\n議題" }),
    });
    await resumeMeetingMinutesRun(fs, selection, options);
    expect(options.postThreadChunk).toHaveBeenCalledWith(
      "CDEST",
      "10.1",
      "meeting.txt",
      "------------\n議題",
      0,
      1,
      "Ev1_F1-revision-0-chunk-0",
    );
  });

  it("reuses generation and posted parent after partial Slack failure", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const generate = vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" });
    const saveGitHub = vi.fn().mockResolvedValue({ transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "mu" });
    const postParent = vi.fn().mockResolvedValue("10.1"); const postThreadChunk = vi.fn()
      .mockRejectedValueOnce(new Error("slack down")).mockResolvedValueOnce("10.2");
    const options = resumeOptions({ generate, saveGitHub, postParent, postThreadChunk });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("slack down");
    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried.status).toBe("completed"); expect(generate).toHaveBeenCalledTimes(1); expect(saveGitHub).toHaveBeenCalledTimes(1);
    expect(postParent).toHaveBeenCalledTimes(1); expect(postThreadChunk).toHaveBeenCalledTimes(2);
  });

  it("never posts to Slack when GitHub fails", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("github down");
    expect(options.postParent).not.toHaveBeenCalled(); expect(options.postThreadChunk).not.toHaveBeenCalled();
  });

  it("rejects a changed transcript on a GitHub retry without regenerating", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const download = vi.fn().mockResolvedValueOnce("original").mockResolvedValueOnce("changed");
    const generate = vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" });
    const options = resumeOptions({ download, generate, saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("github down");
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("meeting_minutes_transcript_changed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rejects a selection from a different operator after approval", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ postThreadChunk: vi.fn().mockRejectedValue(new Error("slack down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("slack down");
    await expect(resumeMeetingMinutesRun(fs, { ...selection, userId: "U2" }, options))
      .rejects.toThrow("meeting_minutes_approver_changed");
  });

  it("removes persisted outputs and reopens destination selection for a completed run", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const generated = { title: "定例", overview: "概要", body: "本文", tasks: [{ title: "確認する" }] };
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({ generate: vi.fn().mockResolvedValue(generated) }));
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn(); const retractSharedMinutes = vi.fn();
    const showDestinationSelection = vi.fn().mockResolvedValue("3.1");
    const reopened = await redoMeetingMinutesRun(fs, redo, { destinations: [destination], deleteGitHub, deleteTask,
      retractSharedMinutes, showDestinationSelection });
    expect(deleteGitHub).toHaveBeenCalledWith(destination, ["docs/transcripts/a.txt", "docs/minutes/a.md"]);
    expect(deleteTask).toHaveBeenCalledWith("task-1", "meeting-minutes-redo-Ev1_F1-revision-0-0");
    expect(retractSharedMinutes).toHaveBeenCalledWith(destination, "10.1", "meeting.txt");
    expect(showDestinationSelection).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), [destination]);
    expect(reopened).toMatchObject({ status: "awaiting_destination", revision: 1,
      slack: { selectionTs: "3.1", postedChunkIndexes: [] } });
    expect(reopened).not.toHaveProperty("destination");
    expect(reopened).not.toHaveProperty("generated");
    expect(reopened).not.toHaveProperty("github");
    expect(reopened).not.toHaveProperty("taskRegistration");
  });

  it("uses fresh external idempotency keys after a redo", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValueOnce({ id: "task-1" }).mockResolvedValueOnce({ id: "task-2" });
    const options = resumeOptions({ createTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [{ title: "確認する" }] }) });
    await resumeMeetingMinutesRun(fs, selection, options);
    await redoMeetingMinutesRun(fs, redo, { destinations: [destination], deleteGitHub: vi.fn(), deleteTask: vi.fn(),
      retractSharedMinutes: vi.fn(), showDestinationSelection: vi.fn().mockResolvedValue("3.1") });
    await resumeMeetingMinutesRun(fs, selection, options);
    expect(createTask.mock.calls[0]?.[1]).not.toBe(createTask.mock.calls[1]?.[1]);
    expect(options.postParent.mock.calls[0]?.[3]).toContain("revision-0");
    expect(options.postParent.mock.calls[1]?.[3]).toContain("revision-1");
  });

  it("binds required generation to the persisted Brainbase context Receipt", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-required", identity, status: "resolved" as const, checksum: "context-checksum",
      resolved_at: "2026-08-15T00:00:00.000Z",
      context: { source_refs: [{ type: "graph_entity", id: "project-mana" }], open_tasks: [] } }));
    const generate = vi.fn(async (_transcript, _destination, context) => ({ title: "定例", overview: "概要", body: "本文",
      brainbase_context_receipt_id: context.receipt_id, brainbase_context_checksum: context.checksum,
      used_source_refs: context.context.source_refs }));
    const run = await resumeMeetingMinutesRun(fs, selection,
      resumeOptions({ contextMode: "required", resolveContext, generate }));
    expect(generate).toHaveBeenCalledWith("transcript", destination,
      expect.objectContaining({ receipt_id: "receipt-required" }), "required");
    expect(run.context).toMatchObject({ receiptId: "receipt-required", checksum: "context-checksum",
      status: "resolved", mode: "required" });
    expect(run.generated).toMatchObject({ brainbase_context_receipt_id: "receipt-required",
      brainbase_context_checksum: "context-checksum" });
  });

  it("regenerates a persisted legacy output mismatch so Brainbase use is attested", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const poisoned = (await loadMeetingMinutesRun(fs, selection.runId))!;
    poisoned.destination = structuredClone(destination);
    poisoned.approvedBy = selection.userId;
    poisoned.status = "failed";
    poisoned.generated = { title: "定例", overview: "概要", body: "本文", tasks: [],
      brainbase_context_receipt_id: "wrong-receipt", brainbase_context_checksum: "wrong-checksum" };
    poisoned.failure = { stage: "generated", message: "meeting_minutes_context_output_mismatch" };
    await saveMeetingMinutesRun(fs, poisoned);
    const generate = vi.fn().mockResolvedValue({ title: "再生成した定例", overview: "概要", body: "本文", tasks: [] });

    const repaired = await resumeMeetingMinutesRun(fs, selection, resumeOptions({ generate }));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(repaired).toMatchObject({ status: "completed", generated: {
      title: "再生成した定例",
      brainbase_context_receipt_id: "receipt-1", brainbase_context_checksum: "checksum-1",
      brainbase_context_attestation: { receipt_id: "receipt-1", session_id: "session-test" },
    } });
  });

  it("regenerates a legacy output mismatch with an unknown source reference in one retry", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const poisoned = (await loadMeetingMinutesRun(fs, selection.runId))!;
    poisoned.destination = structuredClone(destination);
    poisoned.approvedBy = selection.userId;
    poisoned.status = "failed";
    poisoned.generated = { title: "定例", overview: "概要", body: "本文", tasks: [],
      brainbase_context_receipt_id: "wrong-receipt", brainbase_context_checksum: "wrong-checksum",
      used_source_refs: [{ type: "graph_entity", id: "invented" }] };
    poisoned.failure = { stage: "generated", message: "meeting_minutes_context_output_mismatch" };
    await saveMeetingMinutesRun(fs, poisoned);
    const generate = vi.fn().mockResolvedValue({ title: "再生成した定例", overview: "概要", body: "本文", tasks: [],
      used_source_refs: [] });

    const repaired = await resumeMeetingMinutesRun(fs, selection, resumeOptions({ generate }));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(repaired).toMatchObject({ status: "completed", generated: { title: "再生成した定例",
      brainbase_context_receipt_id: "receipt-1", brainbase_context_checksum: "checksum-1" } });
  });

  it("does not persist an untrusted source reference before rejecting required generation", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-source", identity, status: "resolved" as const, checksum: "checksum-source",
      resolved_at: "2026-08-15T00:00:00.000Z",
      context: { source_refs: [{ type: "graph_entity", id: "known" }], open_tasks: [] } }));
    await expect(resumeMeetingMinutesRun(fs, selection, resumeOptions({ contextMode: "required", resolveContext,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [],
        used_source_refs: [{ type: "graph_entity", id: "invented" }] }),
    }))).rejects.toThrow("meeting_minutes_context_source_ref_unknown");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).not.toHaveProperty("generated");
  });

  it("removes an untrusted source reference and completes observe generation", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-source", identity, status: "resolved" as const, checksum: "checksum-source",
      resolved_at: "2026-08-15T00:00:00.000Z",
      context: { source_refs: [{ type: "graph_entity", id: "known" }], open_tasks: [] } }));
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({ contextMode: "observe", resolveContext,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [],
        used_source_refs: [
          { type: "graph_entity", id: "known" },
          { type: "graph_entity", id: "invented" },
        ] }),
    }));
    expect(run).toMatchObject({ status: "completed", generated: {
      used_source_refs: [{ type: "graph_entity", id: "known" }],
      brainbase_context_warnings: ["unknown_source_ref_removed"],
    } });
  });

  it("fails closed before generation when required Brainbase context is partial", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const generate = vi.fn();
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-partial", identity, status: "partial" as const, checksum: "partial-checksum",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    await expect(resumeMeetingMinutesRun(fs, selection,
      resumeOptions({ contextMode: "required", resolveContext, generate })))
      .rejects.toThrow("meeting_minutes_context_partial");
    expect(generate).not.toHaveBeenCalled();
  });

  it("reuses exact tasks and flags similar open tasks instead of creating duplicates", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn();
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-tasks", identity, status: "resolved" as const, checksum: "tasks-checksum",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [
        { id: "task-exact", title: "請求書を送る" }, { id: "task-similar", title: "提案資料を顧客へ共有する" },
      ] } }));
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({ resolveContext, createTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る" }, { title: "提案資料を今日顧客へ共有する" },
      ] }) }));
    expect(createTask).not.toHaveBeenCalled();
    expect(run.taskRegistration?.registered).toEqual([
      { index: 0, title: "請求書を送る", taskId: "task-exact", status: "reused", projectCodes: ["mana"] },
      { index: 1, title: "提案資料を今日顧客へ共有する", taskId: "task-similar", status: "needs_review",
        projectCodes: ["mana"] },
    ]);
  });
});
