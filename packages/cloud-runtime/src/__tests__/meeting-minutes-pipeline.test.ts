import { redoMeetingMinutesRun, resumeMeetingMinutesRun, startMeetingMinutesRuns,
  validateMeetingMinutesDestinations } from "../meeting-minutes-pipeline.js";
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
  workspaceId: "T1", appId: "A1", channelId: "CROUTER", threadTs: "1.1", userId: "U1", actionTs: "2.1" };
const redo: MeetingMinutesRedo = { kind: "meeting_minutes_redo", runId: "Ev1_F1", workspaceId: "T1",
  appId: "A1", channelId: "CROUTER", threadTs: "1.1", userId: "U1", actionTs: "20.1" };

class FailOnceOnRedoFinalStateFs extends MemoryFs {
  private failed = false;
  private armed = false;

  arm(): void { this.armed = true; }

  override async writeFile(path: string, value: string): Promise<void> {
    const persisted = JSON.parse(value) as { status?: string };
    if (this.armed && !this.failed && path.endsWith(".json") && persisted.status === "awaiting_destination") {
      this.failed = true;
      throw new Error("redo final state unavailable");
    }
    await super.writeFile(path, value);
  }
}

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
    updateTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    saveGitHub: vi.fn().mockResolvedValue({ transcriptPath: "docs/transcripts/a.txt", minutesPath: "docs/minutes/a.md",
      transcriptUrl: "https://github/t", minutesUrl: "https://github/m" }),
    postParent: vi.fn().mockResolvedValue("10.1"), postThreadChunk: vi.fn().mockResolvedValue("10.2"),
    ...overrides, generate };
}

describe("meeting minutes pipeline", () => {
  it("rejects ambiguous Slack credential routing across organizations", () => {
    expect(() => validateMeetingMinutesDestinations([
      destination,
      { ...destination, id: "other", organization: { id: "unson-business", name: "雲孫 事業運営" } },
    ])).toThrow("meeting_minutes_destinations_invalid");
  });

  it("stops a placeholder generation before GitHub, Slack, task, or board side effects", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

  it("regenerates an unsaved persisted placeholder before any external side effect", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.destination = structuredClone(destination);
    persisted.approvedBy = selection.userId;
    persisted.status = "failed";
    persisted.generated = { title: "YYYY-MM-DD 会議トピック-要約", overview: "1段落・3〜5文の短い概要",
      body: "区切り線とトピック別の物語的本文。アクションアイテム一覧は含めない", tasks: [] };
    persisted.failure = { stage: "generated", message: "meeting_minutes_generation_placeholder_output" };
    await saveMeetingMinutesRun(fs, persisted);
    const generate = vi.fn().mockResolvedValue({ title: "評議会", overview: "方針を確認しました。",
      body: "## 方針\n参加者は次の運用方針を確認しました。", tasks: [] });
    const options = resumeOptions({ generate });

    const repaired = await resumeMeetingMinutesRun(fs, selection, options);

    expect(repaired).toMatchObject({ status: "completed", generated: { title: "評議会" } });
    expect(repaired.failure).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(options.saveGitHub).toHaveBeenCalledWith(expect.objectContaining({
      destination,
      transcript: "transcript",
      minutes: expect.objectContaining({ title: "評議会" }),
    }));
    expect(options.postParent).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an already saved placeholder and requires an explicit redo", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions());
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.generated = { title: "YYYY-MM-DD 会議トピック-要約", overview: "1段落・3〜5文の短い概要",
      body: "区切り線とトピック別の物語的本文。アクションアイテム一覧は含めない", tasks: [] };
    await saveMeetingMinutesRun(fs, persisted);
    const options = resumeOptions();

    const guarded = await resumeMeetingMinutesRun(fs, selection, options);

    expect(guarded).toMatchObject({ status: "completed",
      failure: { stage: "generated", message: "meeting_minutes_persisted_placeholder_output" } });
    expect(options.generate).not.toHaveBeenCalled();
    expect(options.saveGitHub).not.toHaveBeenCalled();
    expect(options.postParent).not.toHaveBeenCalled();
    expect(options.postThreadChunk).not.toHaveBeenCalled();
    expect(options.createTask).not.toHaveBeenCalled();
  });

  it("persists the canonical source Slack app with every new run", async () => {
    const fs = new MemoryFs();
    const [created] = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    expect(created).toMatchObject({ workspaceId: "T1", sourceAppId: "A1", sourceChannelId: "CROUTER" });
  });

  it("persists one processing reply before generation and reuses it on retry", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

  it("retries a failed run after only its destination organization routing was corrected", async () => {
    const fs = new MemoryFs();
    const legacyDestination = { ...destination,
      organization: { id: "unson-business", name: "雲孫 事業運営" } };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [legacyDestination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.destination = structuredClone(legacyDestination);
    persisted.approvedBy = selection.userId;
    persisted.status = "failed";
    persisted.failure = { stage: "github_saved", message: "slack_api_failed:channel_not_found" };
    persisted.generated = { title: "法務定例", overview: "概要", body: "本文" };
    persisted.github = { transcriptPath: "docs/transcripts/a.txt", minutesPath: "docs/minutes/a.md",
      transcriptUrl: "https://github/t", minutesUrl: "https://github/m" };
    persisted.context = { receiptId: "receipt-1", checksum: "checksum-1", status: "resolved", mode: "observe",
      resolvedAt: "2026-08-17T09:27:00.000Z", sourceRefs: [] };
    persisted.transcriptSha256 = "54e6289e14c7b0e7ad9acc2dfc4c1e3d027d0eef7f5c4c3fe7c292761d0e06a6";
    await saveMeetingMinutesRun(fs, persisted);
    const options = resumeOptions();

    const retried = await resumeMeetingMinutesRun(fs, selection, options);

    expect(retried).toMatchObject({ status: "completed",
      destination: { organization: { id: "unson", name: "雲孫" } } });
    expect(options.saveGitHub).not.toHaveBeenCalled();
    expect(options.postParent).toHaveBeenCalledTimes(1);
  });

  it("still rejects a persisted run when its Slack delivery channel changed", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.destination = structuredClone(destination);
    persisted.approvedBy = selection.userId;
    persisted.status = "failed";
    persisted.failure = { stage: "routed", message: "generator down" };
    await saveMeetingMinutesRun(fs, persisted);

    await expect(resumeMeetingMinutesRun(fs, selection, resumeOptions({
      destinations: [{ ...destination, slackChannelId: "COTHER" }],
    }))).rejects.toThrow("meeting_minutes_destination_changed");
  });

  it("still rejects a persisted run when its GitHub delivery path changed", async () => {
    const fs = new MemoryFs();
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.destination = structuredClone(destination);
    persisted.approvedBy = selection.userId;
    persisted.status = "failed";
    persisted.failure = { stage: "routed", message: "generator down" };
    await saveMeetingMinutesRun(fs, persisted);

    await expect(resumeMeetingMinutesRun(fs, selection, resumeOptions({
      destinations: [{ ...destination, github: { ...destination.github, pathPrefix: "other" } }],
    }))).rejects.toThrow("meeting_minutes_destination_changed");
  });

  it("uses the explicit Brainbase context project without changing task or destination identity", async () => {
    const fs = new MemoryFs();
    const kartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [kartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-kartz", identity, status: "resolved" as const, checksum: "checksum-kartz",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const options = resumeOptions({ destinations: [kartz], resolveContext });
    const run = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, options);
    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "unson" }), undefined, "proj_kartz");
    expect(run.destination).toMatchObject({ projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" });
  });

  it("refreshes a persisted Kartz run from the legacy context project before retrying", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "unson", taskProjectCodes: ["unson"],
      taskBoardTargetId: "minutes-kartz" };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

    expect(resolveContext).toHaveBeenLastCalledWith(expect.objectContaining({ project_code: "unson" }), undefined, "proj_kartz");
    expect(run.destination).toMatchObject({ projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" });
  });

  it("discards an unsaved legacy context and generation before retrying with the corrected project", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "kartz", taskProjectCodes: ["kartz"] };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "kartz" }), undefined, "proj_kartz");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ status: "completed", context: { receiptId: "receipt-kartz" },
      destination: { contextProjectCode: "kartz", taskProjectCodes: ["kartz"] }, generated: { title: "新議事録" } });
  });

  it("keeps an immutable saved Receipt while correcting task bindings on an existing run", async () => {
    const fs = new MemoryFs();
    const legacyKartz = { ...destination, id: "kartz", projectId: "proj_kartz", contextProjectCode: "unson",
      taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-kartz" };
    const configuredKartz = { ...legacyKartz, contextProjectCode: "kartz", taskProjectCodes: ["kartz"] };
    await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [legacyKartz], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskApiError(403, "project_code_not_allowed", "project code is not allowed"))
      .mockResolvedValueOnce({ id: "task-kartz", version: 7, project_codes: ["mana"] });
    const updateTask = vi.fn().mockResolvedValue({ id: "task-kartz", version: 8, project_codes: ["unson"] });
    const original = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [legacyKartz],
      generate: vi.fn().mockResolvedValue({ title: "Kartz定例", overview: "概要", body: "本文",
        tasks: [{ title: "確認する" }] }),
      createTask, updateTask,
    }));
    expect(original).toMatchObject({ status: "completed", context: { receiptId: "receipt-1" },
      destination: { contextProjectCode: "unson" }, taskRegistration: { failure: { status: 403 } } });

    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: "receipt-1", identity, status: "resolved" as const, checksum: "checksum-1",
      resolved_at: "2026-08-15T00:00:00.000Z", context: { source_refs: [], open_tasks: [] } }));
    const retried = await resumeMeetingMinutesRun(fs, { ...selection, destinationId: "kartz" }, resumeOptions({
      destinations: [configuredKartz], resolveContext, createTask, updateTask,
    }));

    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ project_code: "unson" }), "receipt-1", "proj_kartz");
    expect(createTask).toHaveBeenLastCalledWith(expect.objectContaining({ project_codes: ["unson"] }), expect.any(String));
    expect(updateTask).toHaveBeenCalledWith("task-kartz", { expected_version: 7, project_codes: ["kartz"] },
      expect.any(String));
    expect(retried).toMatchObject({ status: "completed", context: { receiptId: "receipt-1" },
      destination: { contextProjectCode: "unson", taskProjectCodes: ["kartz"] } });
    expect(retried.taskRegistration).not.toHaveProperty("failure");
    expect(retried.github).toEqual(original.github);
  });

  it("creates one stable awaiting run and does not duplicate the selector", async () => {
    const fs = new MemoryFs(); const requestDestination = vi.fn().mockResolvedValue("2.1");
    const first = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1", destinations: [destination], requestDestination });
    const second = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1", destinations: [destination], requestDestination });
    expect(first[0]).toMatchObject({ runId: "Ev1_F1", status: "awaiting_destination" });
    expect(second[0]?.runId).toBe("Ev1_F1"); expect(requestDestination).toHaveBeenCalledTimes(1);
  });

  it("classifies once, persists the suggestion, and reuses it on event retry", async () => {
    const fs = new MemoryFs();
    const download = vi.fn().mockResolvedValue("SalesTailorの定例です");
    const classifyDestination = vi.fn().mockResolvedValue({ destinationId: "mana", reason: "案件名が一致" });
    const requestDestination = vi.fn().mockResolvedValue("2.1");
    const options = { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1", destinations: [destination],
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
    const run = (await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], download: vi.fn().mockResolvedValue("曖昧な会議"),
      classifyDestination: vi.fn().mockResolvedValue(null), requestDestination }))[0];
    expect(run?.routing).toEqual({ evaluated: true });
    expect(requestDestination).toHaveBeenCalledWith(expect.objectContaining({ routing: { evaluated: true } }), [destination]);
    expect(run?.status).toBe("awaiting_destination");
  });

  it("shares minutes before registering tasks with stable idempotency and trusted project scope", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
      taskRegistration: { failure: { stage: "task_card", message: "meeting_minutes_task_card_failed" } },
    });

    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried).toMatchObject({ status: "completed", slack: { taskCardTs: "10.3", postedChunkIndexes: [0] } });
    expect(postParent).toHaveBeenCalledTimes(1);
    expect(postThreadChunk).toHaveBeenCalledTimes(1);
    expect(postTaskCard).toHaveBeenCalledTimes(2);
  });

  it("resolves a named assignee to the canonical person id before task creation", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockResolvedValueOnce({ id: "task-42" })
      .mockResolvedValueOnce({ id: "task-43" });
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

  it("registers the task without guessing when the assignee graph is unavailable", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockResolvedValue({ id: "task-42" });
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", assignee_name: "梅田 遼" },
        { title: "入金を確認する" },
      ] }), createTask, resolveAssignee: vi.fn().mockResolvedValue({ status: "unavailable" }),
    }));
    expect(run.status).toBe("completed");
    expect(run.taskRegistration).not.toHaveProperty("failure");
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty("assignee_name");
    expect(createTask.mock.calls[0]?.[0]).not.toHaveProperty("assignee_person_id");
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ title: "入金を確認する" });
  });

  it("accepts minutes with no explicit tasks without creating a task", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockResolvedValueOnce({ id: "task-1" })
      .mockRejectedValueOnce(new Error("task api Authorization Bearer secret"))
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
      taskRegistration: { failure: { index: 1, failurePoint: "task_create",
        message: "meeting_minutes_task_registration_failed" } } });
    expect(first.diagnostics).toMatchObject({ stage: "task_registration", code: "TASK_REGISTRATION_FAILED",
      checkpoint: { hasGitHub: true, hasSlackParent: true, postedChunkCount: 1 } });
    expect(JSON.stringify(first)).not.toContain("Bearer secret");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Bearer secret");
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
    expect(retried.diagnostics).not.toHaveProperty("stage");
    expect(retried.diagnostics).not.toHaveProperty("code");
    expect(retried.diagnostics).not.toHaveProperty("failedAt");
    consoleError.mockRestore();
  });

  it("shares GitHub-saved minutes even when canonical task registration is unavailable", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskApiError(403, "project_code_not_allowed", "project code is not allowed"))
      .mockResolvedValueOnce({ id: "task-kartz", version: 7, project_codes: ["mana"] });
    const updateTask = vi.fn().mockResolvedValue({ id: "task-kartz", version: 8, project_codes: ["unson"] });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "Kartzの確認事項を進める" },
      ] }),
      createTask, updateTask,
    });

    const deferred = await resumeMeetingMinutesRun(fs, selection, options);

    expect(deferred).toMatchObject({ status: "completed",
      slack: { parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { failure: { index: 0, stage: "task_registration", code: "project_code_not_allowed",
        status: 403, message: "meeting_minutes_task_registration_failed" } } });
    expect(deferred.diagnostics).toMatchObject({ stage: "task_registration",
      code: "TASK_PROJECT_CODE_NOT_ALLOWED", retryable: false });
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
    expect(createTask.mock.calls[0]).toEqual(createTask.mock.calls[1]);
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ project_codes: ["mana"] });
    expect(updateTask).toHaveBeenCalledWith("task-kartz", { expected_version: 7, project_codes: ["unson"] },
      expect.any(String));
  });

  it("persists the exact create operation before the external Task request and replays it unchanged", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const observed: unknown[] = [];
    const createTask = vi.fn(async () => {
      observed.push(structuredClone((await loadMeetingMinutesRun(fs, selection.runId))?.taskRegistration));
      if (observed.length === 1) throw new Error("network response lost");
      return { id: "task-recovered" };
    });
    const options = resumeOptions({ createTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }) });

    const deferred = await resumeMeetingMinutesRun(fs, selection, options);
    const recovered = await resumeMeetingMinutesRun(fs, selection, options);

    expect(deferred.taskRegistration?.pending).toEqual(expect.objectContaining({ index: 0,
      input: expect.objectContaining({ title: "Kartzの確認事項を進める", project_codes: ["mana"] }) }));
    expect(observed[0]).toMatchObject({ pending: { index: 0 } });
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1]).toEqual(createTask.mock.calls[0]);
    expect(recovered.taskRegistration?.registered).toEqual([
      { index: 0, title: "Kartzの確認事項を進める", taskId: "task-recovered", projectCodes: ["mana"] },
    ]);
    expect(recovered.taskRegistration).not.toHaveProperty("pending");
  });

  it("keeps idempotency_conflict terminal and never adopts a task found only by title", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn().mockRejectedValue(new TaskApiError(409, "idempotency_conflict", "conflict"));
    const findExistingTask = vi.fn().mockResolvedValue(undefined);
    const run = await resumeMeetingMinutesRun(fs, selection, resumeOptions({ createTask, findExistingTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "同名候補が複数あるタスク" }] }) }));

    expect(findExistingTask).not.toHaveBeenCalled();
    expect(run.taskRegistration?.registered).toEqual([]);
    expect(run.taskRegistration?.failure).toMatchObject({ index: 0, stage: "task_registration", status: 409,
      code: "idempotency_conflict", failurePoint: "task_create" });
    expect(run.taskRegistration?.pending).toEqual(expect.objectContaining({ index: 0 }));
    expect(run.diagnostics).toMatchObject({ code: "TASK_IDEMPOTENCY_CONFLICT", retryable: false });
  });

  it("recovers a legacy partial 409 only from one consistent registered project scope", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockResolvedValueOnce({ id: "task-first" })
      .mockRejectedValueOnce(new TaskApiError(409, "idempotency_conflict", "conflict"));
    const options = resumeOptions({ createTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "先に成功" }, { title: "応答を失ったTask" },
      ] }) });
    await resumeMeetingMinutesRun(fs, selection, options);
    const legacy = (await loadMeetingMinutesRun(fs, selection.runId))!;
    delete legacy.taskRegistration!.pending;
    await saveMeetingMinutesRun(fs, legacy);

    createTask.mockResolvedValueOnce({ id: "task-second", version: 4, project_codes: ["mana"] });
    const updateTask = vi.fn().mockResolvedValue({ id: "task-second", version: 5, project_codes: ["unson"] });
    const recovered = await resumeMeetingMinutesRun(fs, selection, { ...options, updateTask,
      destinations: [{ ...destination, taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-unson" }] });

    expect(createTask).toHaveBeenLastCalledWith(expect.objectContaining({ title: "応答を失ったTask",
      project_codes: ["mana"] }), expect.any(String));
    expect(updateTask).toHaveBeenCalledWith("task-second", { expected_version: 4, project_codes: ["unson"] },
      expect.any(String));
    expect(recovered.taskRegistration?.registered).toEqual([
      expect.objectContaining({ index: 0, taskId: "task-first", projectCodes: ["mana"] }),
      expect.objectContaining({ index: 1, taskId: "task-second", projectCodes: ["unson"] }),
    ]);
  });

  it("commits registration without another scope PATCH when create recovery reads back the current scope", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskApiError(403, "project_code_not_allowed", "old scope"))
      .mockResolvedValueOnce({ id: "task-recovered", version: 3, project_codes: ["mana"] })
      .mockResolvedValueOnce({ id: "task-recovered", version: 4, project_codes: ["unson"] });
    const updateTask = vi.fn().mockRejectedValueOnce(new Error("PATCH response lost"));
    const options = resumeOptions({ createTask, updateTask,
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "scope移行する" }] }) });
    await resumeMeetingMinutesRun(fs, selection, options);
    const currentDestination = { ...destination, taskProjectCodes: ["unson"], taskBoardTargetId: "minutes-unson" };

    const patchLost = await resumeMeetingMinutesRun(fs, selection, { ...options, destinations: [currentDestination] });
    expect(patchLost.taskRegistration?.pending).toEqual(expect.objectContaining({ index: 0,
      input: expect.objectContaining({ project_codes: ["mana"] }) }));
    const recovered = await resumeMeetingMinutesRun(fs, selection, { ...options, destinations: [currentDestination] });

    expect(createTask.mock.calls[1]).toEqual(createTask.mock.calls[2]);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(recovered.taskRegistration?.registered).toEqual([
      expect.objectContaining({ taskId: "task-recovered", projectCodes: ["unson"] }),
    ]);
    expect(recovered.taskRegistration).not.toHaveProperty("pending");
    expect(recovered.taskRegistration).not.toHaveProperty("failure");
  });

  it("keeps the task-only retry until board repair and the final task card both complete", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
        failure: { stage: "task_board", message: "meeting_minutes_task_board_failed" } } });
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

  it("persists a safe task-board cause without exposing arbitrary error text", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const scoped = Object.assign(new Error("CREDENTIAL_LEASE_SCOPE_MISMATCH"), {
      code: "CREDENTIAL_LEASE_SCOPE_MISMATCH",
      boundary: "credential_lease",
      details: { scope_reason: "provider_forwarder_mismatch", secret: "must-not-leak" },
    });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask: vi.fn().mockResolvedValue({ id: "task-kartz" }),
      repairTaskBoard: vi.fn().mockRejectedValue(scoped),
    });

    const failed = await resumeMeetingMinutesRun(fs, selection, options);

    expect(failed.taskRegistration?.failure).toMatchObject({
      stage: "task_board", message: "meeting_minutes_task_board_failed",
      code: "CREDENTIAL_LEASE_SCOPE_MISMATCH",
      boundary: "credential_lease",
      scopeReason: "provider_forwarder_mismatch",
    });
    expect(JSON.stringify(failed)).not.toContain("must-not-leak");

    const fs2 = new MemoryFs(); await startMeetingMinutesRuns(fs2, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const slackFailure = await resumeMeetingMinutesRun(fs2, selection, resumeOptions({
      generate: options.generate,
      createTask: vi.fn().mockResolvedValue({ id: "task-kartz" }),
      repairTaskBoard: vi.fn().mockRejectedValue(new Error("task_board_missing_scope")),
    }));
    expect(slackFailure.taskRegistration?.failure?.message).toBe("task_board_missing_scope");
  });

  it("persists an unknown machine-readable task-board code without exposing details", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const scoped = Object.assign(new Error("contains a secret value"), {
      code: "credential_lease_rejected",
      boundary: "credential lease contains spaces",
      details: { scope_reason: "must/not/leak", secret: "must-not-leak" },
    });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask: vi.fn().mockResolvedValue({ id: "task-kartz" }),
      repairTaskBoard: vi.fn().mockRejectedValue(scoped),
    });

    const failed = await resumeMeetingMinutesRun(fs, selection, options);

    expect(failed.taskRegistration?.failure).toMatchObject({
      stage: "task_board", message: "meeting_minutes_task_board_failed",
      code: "credential_lease_rejected",
    });
    expect(JSON.stringify(failed)).not.toContain("must-not-leak");
    expect(failed.taskRegistration?.failure).not.toHaveProperty("boundary");
    expect(failed.taskRegistration?.failure).not.toHaveProperty("scopeReason");
  });

  it("repairs a legacy task-board failure even when local task receipts are empty", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const repairTaskBoard = vi.fn().mockResolvedValue(undefined);
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
      repairTaskBoard,
    });
    const completed = await resumeMeetingMinutesRun(fs, selection, options);
    const legacy = (await loadMeetingMinutesRun(fs, completed.runId))!;
    legacy.taskRegistration = { registered: [], failure: { index: 0, stage: "task_board",
      message: "meeting_minutes_task_board_failed", failedAt: "2026-08-31T00:00:00.000Z" } };
    await saveMeetingMinutesRun(fs, legacy);
    repairTaskBoard.mockClear();

    const recovered = await resumeMeetingMinutesRun(fs, selection, options);

    expect(repairTaskBoard).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledWith("minutes-mana");
    expect(recovered.taskRegistration).not.toHaveProperty("failure");
  });

  it("reconciles the board when a completed run is selected again after its failure was cleared", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const repairTaskBoard = vi.fn().mockResolvedValue(undefined);
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      createTask: vi.fn().mockResolvedValue({ id: "task-kartz" }),
      repairTaskBoard,
      postTaskCard: vi.fn().mockResolvedValue("10.3"),
    });

    const completed = await resumeMeetingMinutesRun(fs, selection, options);
    expect(completed.taskRegistration).not.toHaveProperty("failure");
    repairTaskBoard.mockClear();

    const reconciled = await resumeMeetingMinutesRun(fs, selection, options);

    expect(repairTaskBoard).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledWith("minutes-mana");
    expect(reconciled.taskRegistration).not.toHaveProperty("failure");
    expect(options.createTask).toHaveBeenCalledTimes(1);
  });

  it("reconciles a stale completed run even when its local task receipts are empty", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const repairTaskBoard = vi.fn().mockResolvedValue(undefined);
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
      repairTaskBoard,
    });

    const completed = await resumeMeetingMinutesRun(fs, selection, options);
    expect(completed.taskRegistration?.registered).toEqual([]);
    expect(completed.taskRegistration).not.toHaveProperty("failure");
    repairTaskBoard.mockClear();

    const reconciled = await resumeMeetingMinutesRun(fs, selection, options);

    expect(repairTaskBoard).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledWith("minutes-mana");
    expect(reconciled.taskRegistration).not.toHaveProperty("failure");
  });

  it("reconciles a reopened failed run with persisted output and empty task receipts", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const repairTaskBoard = vi.fn().mockResolvedValue(undefined);
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
      repairTaskBoard,
    });
    const completed = await resumeMeetingMinutesRun(fs, selection, options);
    const reopened = (await loadMeetingMinutesRun(fs, completed.runId))!;
    reopened.status = "failed";
    reopened.failure = { stage: "completed", message: "legacy_retry_required" };
    reopened.taskRegistration = { registered: [] };
    await saveMeetingMinutesRun(fs, reopened);
    repairTaskBoard.mockClear();

    const reconciled = await resumeMeetingMinutesRun(fs, selection, options);

    expect(repairTaskBoard).toHaveBeenCalledTimes(1);
    expect(repairTaskBoard).toHaveBeenCalledWith("minutes-mana");
    expect(reconciled.status).toBe("completed");
    expect(reconciled.taskRegistration).not.toHaveProperty("failure");
  });

  it("resumes only the task card stage after task card posting fails", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
        failure: { stage: "task_card", message: "meeting_minutes_task_card_failed" } } });
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
    expect(options.resolveContext).toHaveBeenCalledTimes(1);
  });

  it("keeps the task card failure when a card-only retry is unavailable", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const initial = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "Kartzの確認事項を進める" }] }),
      repairTaskBoard: vi.fn().mockResolvedValue(undefined),
      postTaskCard: vi.fn().mockRejectedValue(new Error("task card down")),
    });
    await resumeMeetingMinutesRun(fs, selection, initial);
    const unavailable = resumeOptions();

    const retained = await resumeMeetingMinutesRun(fs, selection, unavailable);

    expect(retained.slack?.taskCardTs).toBeUndefined();
    expect(retained.taskRegistration?.failure).toMatchObject({
      stage: "task_card", message: "meeting_minutes_task_card_failed",
    });
    expect(unavailable.resolveContext).not.toHaveBeenCalled();
    expect(unavailable.createTask).not.toHaveBeenCalled();
  });

  it("saves GitHub before Slack and completes", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("github down");
    expect(options.postParent).not.toHaveBeenCalled(); expect(options.postThreadChunk).not.toHaveBeenCalled();
  });

  it("rejects a changed transcript on a GitHub retry without regenerating", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const download = vi.fn().mockResolvedValueOnce("original").mockResolvedValueOnce("changed");
    const generate = vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" });
    const options = resumeOptions({ download, generate, saveGitHub: vi.fn().mockRejectedValue(new Error("github down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("github down");
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("meeting_minutes_transcript_changed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rejects a selection from a different operator after approval", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ postThreadChunk: vi.fn().mockRejectedValue(new Error("slack down")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("slack down");
    await expect(resumeMeetingMinutesRun(fs, { ...selection, userId: "U2" }, options))
      .rejects.toThrow("meeting_minutes_approver_changed");
  });

  it("removes persisted outputs and reopens destination selection for a completed run", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const generated = { title: "定例", overview: "概要", body: "本文", tasks: [{ title: "確認する" }] };
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({ generate: vi.fn().mockResolvedValue(generated) }));
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.generated = { title: "YYYY-MM-DD 会議トピック-要約", overview: "1段落・3〜5文の短い概要",
      body: "区切り線とトピック別の物語的本文。アクションアイテム一覧は含めない", tasks: [] };
    await saveMeetingMinutesRun(fs, persisted);
    expect(await resumeMeetingMinutesRun(fs, selection, resumeOptions())).toMatchObject({
      status: "completed", failure: { message: "meeting_minutes_persisted_placeholder_output" },
    });
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
    expect(reopened).not.toHaveProperty("failure");
  });

  it("acknowledges a stale redo as a terminal no-op without changing the newer completed run", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const resume = resumeOptions({ generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
      tasks: [{ title: "確認する" }] }) });
    await resumeMeetingMinutesRun(fs, selection, resume);
    await redoMeetingMinutesRun(fs, { ...redo, revision: 0 }, { destinations: [destination],
      deleteGitHub: vi.fn(), deleteTask: vi.fn(), retractSharedMinutes: vi.fn(),
      showDestinationSelection: vi.fn().mockResolvedValue("4.1") });
    await resumeMeetingMinutesRun(fs, selection, resume);

    const currentRun = await loadMeetingMinutesRun(fs, selection.runId);
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn(); const retractSharedMinutes = vi.fn();
    const showDestinationSelection = vi.fn();
    await expect(redoMeetingMinutesRun(fs, { ...redo, revision: 0 }, { destinations: [destination],
      deleteGitHub, deleteTask, retractSharedMinutes, showDestinationSelection }))
      .resolves.toEqual(currentRun);

    expect(deleteGitHub).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(retractSharedMinutes).not.toHaveBeenCalled();
    expect(showDestinationSelection).not.toHaveBeenCalled();
    await expect(redoMeetingMinutesRun(fs, redo, { destinations: [destination],
      deleteGitHub, deleteTask, retractSharedMinutes, showDestinationSelection }))
      .resolves.toEqual(currentRun);
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "completed", revision: 1,
      github: { minutesPath: "docs/minutes/a.md" }, taskRegistration: { registered: [{ taskId: "task-1" }] } });
  });

  it("deletes only tasks created by this run during redo", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "今回作成するタスク" }] }),
    }));
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.taskRegistration!.registered.push(
      { index: 1, title: "既存の完全一致タスク", taskId: "task-exact", status: "reused", projectCodes: ["mana"] },
      { index: 2, title: "既存の類似タスク", taskId: "task-similar", status: "needs_review", projectCodes: ["mana"] },
      { index: 3, title: "既に削除済みのタスク", taskId: "task-removed", status: "removed", projectCodes: ["mana"] },
    );
    await saveMeetingMinutesRun(fs, persisted);
    const deleteTask = vi.fn();

    await redoMeetingMinutesRun(fs, redo, { destinations: [destination], deleteGitHub: vi.fn(), deleteTask,
      retractSharedMinutes: vi.fn(), showDestinationSelection: vi.fn().mockResolvedValue("3.1") });

    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).toHaveBeenCalledWith("task-1", "meeting-minutes-redo-Ev1_F1-revision-0-0");
    expect(deleteTask).not.toHaveBeenCalledWith("task-exact", expect.any(String));
    expect(deleteTask).not.toHaveBeenCalledWith("task-similar", expect.any(String));
    expect(deleteTask).not.toHaveBeenCalledWith("task-removed", expect.any(String));
  });

  it("fails closed when task registration is still pending before external cleanup", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "今回作成するタスク" }] }),
    }));
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    const pending = { index: 1, idempotencyKey: "pending-recovery-key",
      input: { title: "未完了のタスク", project_codes: ["mana"] } };
    persisted.taskRegistration!.pending = pending;
    await saveMeetingMinutesRun(fs, persisted);
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn(); const retractSharedMinutes = vi.fn();
    const showDestinationSelection = vi.fn(); const showRedoFailure = vi.fn();

    await expect(redoMeetingMinutesRun(fs, redo, { destinations: [destination], deleteGitHub, deleteTask,
      retractSharedMinutes, showDestinationSelection, showRedoFailure })).rejects
      .toThrow("meeting_minutes_redo_task_registration_pending");

    expect(deleteGitHub).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(retractSharedMinutes).not.toHaveBeenCalled();
    expect(showDestinationSelection).not.toHaveBeenCalled();
    expect(showRedoFailure).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "completed",
      taskRegistration: { pending },
      redo: { revision: 0, deletedTaskIds: [], failure: {
        message: "REDO_TASK_REGISTRATION_PENDING", stage: "redo_task_delete",
        code: "REDO_TASK_REGISTRATION_PENDING", retryable: false,
      } },
    });
  });

  it("resumes a partially completed redo without repeating finished cleanup", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "確認する" }] }),
    }));
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn();
    const retractSharedMinutes = vi.fn().mockRejectedValueOnce(new Error("Slack unavailable")).mockResolvedValue(undefined);
    const showDestinationSelection = vi.fn().mockResolvedValue("3.1"); const showRedoFailure = vi.fn();
    const options = { destinations: [destination], deleteGitHub, deleteTask, retractSharedMinutes,
      showDestinationSelection, showRedoFailure };
    await expect(redoMeetingMinutesRun(fs, redo, options)).rejects.toThrow("Slack unavailable");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "completed", redo: {
      revision: 0, githubDeletedAt: expect.any(String), deletedTaskIds: ["task-1"],
      failure: { message: "REDO_SLACK_FAILED", stage: "redo_slack_retract", code: "REDO_SLACK_FAILED" },
    } });
    expect(showRedoFailure).toHaveBeenCalledOnce();
    const reopened = await redoMeetingMinutesRun(fs, redo, options);
    expect(deleteGitHub).toHaveBeenCalledOnce(); expect(deleteTask).toHaveBeenCalledOnce();
    expect(retractSharedMinutes).toHaveBeenCalledTimes(2); expect(showDestinationSelection).toHaveBeenCalledOnce();
    expect(reopened).toMatchObject({ status: "awaiting_destination", revision: 1,
      slack: { selectionTs: "3.1", postedChunkIndexes: [] } });
    expect(reopened).not.toHaveProperty("redo");
  });

  it("resumes a redo after destination selection fails without repeating cleanup", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "確認する" }] }),
    }));
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn(); const retractSharedMinutes = vi.fn();
    const showDestinationSelection = vi.fn().mockRejectedValueOnce(new Error("source Slack unavailable"))
      .mockResolvedValueOnce("3.1");
    const showRedoFailure = vi.fn();
    const options = { destinations: [destination], deleteGitHub, deleteTask, retractSharedMinutes,
      showDestinationSelection, showRedoFailure };

    await expect(redoMeetingMinutesRun(fs, redo, options)).rejects.toThrow("source Slack unavailable");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "completed", redo: {
      revision: 0, githubDeletedAt: expect.any(String), deletedTaskIds: ["task-1"],
      sharedRetractedAt: expect.any(String), failure: { message: "REDO_DESTINATION_SELECTION_FAILED",
        stage: "redo_destination_selection", code: "REDO_DESTINATION_SELECTION_FAILED" },
    } });
    expect(showRedoFailure).toHaveBeenCalledOnce();

    const reopened = await redoMeetingMinutesRun(fs, redo, options);

    expect(deleteGitHub).toHaveBeenCalledOnce(); expect(deleteTask).toHaveBeenCalledOnce();
    expect(retractSharedMinutes).toHaveBeenCalledOnce(); expect(showDestinationSelection).toHaveBeenCalledTimes(2);
    expect(reopened).toMatchObject({ status: "awaiting_destination", revision: 1,
      slack: { selectionTs: "3.1", postedChunkIndexes: [] } });
    expect(reopened).not.toHaveProperty("redo");
    expect(reopened).not.toHaveProperty("destination");
    expect(reopened).not.toHaveProperty("generated");
    expect(reopened).not.toHaveProperty("github");
    expect(reopened).not.toHaveProperty("taskRegistration");
  });

  it("keeps the completed redo checkpoint when the final reopened-state save fails", async () => {
    const fs = new FailOnceOnRedoFinalStateFs(); await startMeetingMinutesRuns(fs, event, { enabled: true,
      routerChannelId: "CROUTER", sourceAppId: "A1", destinations: [destination],
      requestDestination: vi.fn().mockResolvedValue("2.1") });
    await resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文",
        tasks: [{ title: "確認する" }] }),
    }));
    fs.arm();
    const deleteGitHub = vi.fn(); const deleteTask = vi.fn(); const retractSharedMinutes = vi.fn();
    const showDestinationSelection = vi.fn().mockResolvedValueOnce("3.1").mockResolvedValueOnce("4.1");
    const showRedoFailure = vi.fn();
    const options = { destinations: [destination], deleteGitHub, deleteTask, retractSharedMinutes,
      showDestinationSelection, showRedoFailure };

    await expect(redoMeetingMinutesRun(fs, redo, options)).rejects.toThrow("redo final state unavailable");
    expect(await loadMeetingMinutesRun(fs, redo.runId)).toMatchObject({ status: "completed",
      destination, github: { minutesPath: "docs/minutes/a.md" }, taskRegistration: { registered: [{ taskId: "task-1" }] },
      redo: { revision: 0, githubDeletedAt: expect.any(String), deletedTaskIds: ["task-1"],
        sharedRetractedAt: expect.any(String), failure: { stage: "redo_destination_selection",
          code: "REDO_DESTINATION_SELECTION_FAILED" } },
    });
    expect(showRedoFailure).toHaveBeenCalledOnce();

    const reopened = await redoMeetingMinutesRun(fs, redo, options);

    expect(deleteGitHub).toHaveBeenCalledOnce(); expect(deleteTask).toHaveBeenCalledOnce();
    expect(retractSharedMinutes).toHaveBeenCalledOnce(); expect(showDestinationSelection).toHaveBeenCalledTimes(2);
    expect(reopened).toMatchObject({ status: "awaiting_destination", revision: 1,
      slack: { selectionTs: "4.1", postedChunkIndexes: [] } });
    expect(reopened).not.toHaveProperty("redo");
  });

  it("uses fresh external idempotency keys after a redo", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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

  it.each(["partial", "unavailable"] as const)(
    "fails closed before generation and external persistence when required Brainbase context is %s",
    async (status) => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ contextMode: "required" });
    const resolveContext = vi.fn(async (identity) => ({ schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: `receipt-${status}`, identity, status, checksum: `${status}-checksum`,
      resolved_at: "2026-08-15T00:00:00.000Z", errors: [
        { code: "graph_timeout", message: "Authorization: Bearer secret-value" },
        { code: "not safe!", message: "raw upstream response" },
      ], context: { source_refs: [], open_tasks: [] } }));
    await expect(resumeMeetingMinutesRun(fs, selection,
      { ...options, resolveContext }))
      .rejects.toThrow(`meeting_minutes_context_${status}`);
    expect(options.generate).not.toHaveBeenCalled();
    expect(options.saveGitHub).not.toHaveBeenCalled();
    expect(options.createTask).not.toHaveBeenCalled();
    expect(options.postParent).not.toHaveBeenCalled();
    expect(options.postThreadChunk).not.toHaveBeenCalled();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      status: "failed",
      diagnostics: {
        schemaVersion: "meeting_minutes_diagnostics.v1",
        stage: "context_gate",
        code: status === "partial" ? "CONTEXT_PARTIAL" : "CONTEXT_UNAVAILABLE",
        receiptSnapshot: { receiptId: `receipt-${status}`, status, errorCodes: ["GRAPH_TIMEOUT"] },
      },
    });
    expect(JSON.stringify(await loadMeetingMinutesRun(fs, selection.runId))).not.toContain("secret-value");
  });

  it.each([
    ["generation", "GENERATION_FAILED", { generate: vi.fn().mockRejectedValue(new Error("model secret output")) }],
    ["github", "GITHUB_SAVE_FAILED", { saveGitHub: vi.fn().mockRejectedValue(new Error("github secret output")) }],
    ["slack", "SLACK_PUBLISH_FAILED", { postParent: vi.fn().mockRejectedValue(new Error("slack secret output")) }],
  ] as const)("persists a stable %s failure stage and safe code", async (_name, code, overrides) => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    await expect(resumeMeetingMinutesRun(fs, selection, resumeOptions(overrides))).rejects.toThrow();
    const failed = await loadMeetingMinutesRun(fs, selection.runId);
    expect(failed?.diagnostics).toMatchObject({ code });
    expect(["generation", "github_save", "slack_publish"]).toContain(failed?.diagnostics?.stage);
  });

  it("persists a Slack publish diagnostic when the processing status post fails", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const options = resumeOptions({ postProcessingStatus: vi.fn().mockRejectedValue(new Error("Bearer secret")) });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("Bearer secret");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "failed",
      diagnostics: { stage: "slack_publish", code: "SLACK_PUBLISH_FAILED" } });
    expect(options.download).not.toHaveBeenCalled();
  });

  it.each(["partial", "unavailable"] as const)(
    "refreshes a persisted %s observe Receipt before retrying in required mode",
    async (status) => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const persisted = (await loadMeetingMinutesRun(fs, selection.runId))!;
    persisted.destination = structuredClone(destination);
    persisted.approvedBy = selection.userId;
    persisted.status = "failed";
    persisted.context = { receiptId: `receipt-${status}`, checksum: `${status}-checksum`, status, mode: "observe",
      sourceRefs: [], resolvedAt: "2026-08-15T00:00:00.000Z" };
    persisted.generated = { title: "古い文脈の定例", overview: "古い概要", body: "古い本文", tasks: [] };
    persisted.failure = { stage: "routed", message: `meeting_minutes_context_${status}` };
    await saveMeetingMinutesRun(fs, persisted);
    const resolveContext = vi.fn(async (identity, receiptId?: string) => ({
      schema_version: "meeting_minutes_context_receipt.v1" as const,
      receipt_id: receiptId ?? "receipt-fresh", identity,
      status: receiptId ? status : "resolved" as const,
      checksum: receiptId ? `${status}-checksum` : "fresh-checksum",
      resolved_at: "2026-08-18T00:00:00.000Z", context: { source_refs: [], open_tasks: [] },
    }));
    const generate = vi.fn().mockResolvedValue({ title: "新しい文脈の定例", overview: "概要", body: "本文", tasks: [] });

    const retried = await resumeMeetingMinutesRun(fs, selection,
      resumeOptions({ contextMode: "required", resolveContext, generate }));

    expect(resolveContext).toHaveBeenCalledWith(expect.objectContaining({ run_id: selection.runId }), undefined, "mana");
    expect(resolveContext).not.toHaveBeenCalledWith(expect.anything(), `receipt-${status}`);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(retried).toMatchObject({ status: "completed", context: { receiptId: "receipt-fresh",
      checksum: "fresh-checksum", status: "resolved", mode: "required" },
      generated: { title: "新しい文脈の定例", brainbase_context_receipt_id: "receipt-fresh" } });
  });

  it("reuses exact tasks and flags similar open tasks instead of creating duplicates", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", sourceAppId: "A1",
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
