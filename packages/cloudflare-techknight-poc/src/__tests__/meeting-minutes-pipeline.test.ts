import { redoMeetingMinutesRun, resumeMeetingMinutesRun, startMeetingMinutesRuns } from "../meeting-minutes-pipeline.js";
import type { MeetingMinutesDestination, MeetingMinutesRedo, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const destination: MeetingMinutesDestination = { id: "mana", projectId: "mana", name: "mana",
  organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } };
const event: SlackQueueEvent = { tenantId: "unson", eventId: "Ev1", workspaceId: "T1", channelId: "CROUTER",
  threadTs: "1.1", messageTs: "1.1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
  files: [{ id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 100 }] };
const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "mana",
  workspaceId: "T1", channelId: "CROUTER", userId: "U1", actionTs: "2.1" };
const redo: MeetingMinutesRedo = { kind: "meeting_minutes_redo", runId: "Ev1_F1", workspaceId: "T1",
  channelId: "CROUTER", userId: "U1", actionTs: "20.1" };
function resumeOptions(overrides: Record<string, unknown> = {}) {
  return { destinations: [destination], download: vi.fn().mockResolvedValue("transcript"),
    postProcessingStatus: vi.fn().mockResolvedValue("3.1"),
    generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" }),
    createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    saveGitHub: vi.fn().mockResolvedValue({ transcriptPath: "docs/transcripts/a.txt", minutesPath: "docs/minutes/a.md",
      transcriptUrl: "https://github/t", minutesUrl: "https://github/m" }),
    postParent: vi.fn().mockResolvedValue("10.1"), postThreadChunk: vi.fn().mockResolvedValue("10.2"), ...overrides };
}

describe("meeting minutes pipeline", () => {
  it("persists one processing reply before generation and reuses it on retry", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const postProcessingStatus = vi.fn().mockResolvedValue("3.1");
    const generate = vi.fn().mockRejectedValueOnce(new Error("generator down"))
      .mockResolvedValueOnce({ title: "定例", overview: "概要", body: "本文" });
    const options = resumeOptions({ postProcessingStatus, generate });
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("generator down");
    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried.slack?.processingTs).toBe("3.1");
    expect(postProcessingStatus).toHaveBeenCalledTimes(1);
    expect(postProcessingStatus).toHaveBeenCalledWith(expect.objectContaining({
      sourceChannelId: "CROUTER", sourceThreadTs: "1.1", destination: expect.objectContaining({ id: "mana" }),
    }));
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

  it("registers extracted tasks before Slack with stable idempotency and trusted project scope", async () => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const order: string[] = [];
    const createTask = vi.fn(async () => { order.push("task"); return { id: "task-42" }; });
    const options = resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20T00:00:00+09:00" },
      ] }),
      saveGitHub: vi.fn(async () => { order.push("github"); return { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "mu" }; }),
      createTask,
      postParent: vi.fn(async () => { order.push("slack"); return "10.1"; }),
    });
    const run = await resumeMeetingMinutesRun(fs, selection, options);
    expect(order).toEqual(["github", "task", "slack"]);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "請求書を送る", project_codes: ["mana"] }),
      expect.stringMatching(/^meeting-minutes-/),
    );
    expect(run.taskRegistration?.registered).toEqual([{ index: 0, title: "請求書を送る", taskId: "task-42" }]);
    expect(options.postThreadChunk).toHaveBeenCalledWith(
      "CDEST", "10.1", "meeting.txt", expect.stringContaining("Brainbaseへタスクを1件登録しました"),
      expect.any(Number), expect.any(Number), expect.any(String),
    );
    const taskSummary = options.postThreadChunk.mock.calls.find((call: unknown[]) =>
      String(call[3]).includes("Brainbaseへタスクを"))?.[3];
    expect(taskSummary).toContain("1. 請求書を送る");
    expect(taskSummary).not.toContain("task-42");
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

  it.each(["unknown", "ambiguous", "unavailable"])("fails closed when named assignee is %s", async (status) => {
    const fs = new MemoryFs(); await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER",
      destinations: [destination], requestDestination: vi.fn().mockResolvedValue("2.1") });
    const createTask = vi.fn();
    await expect(resumeMeetingMinutesRun(fs, selection, resumeOptions({
      generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", assignee_name: "梅田 遼" },
      ] }), createTask, resolveAssignee: vi.fn().mockResolvedValue({ status }),
    }))).rejects.toThrow(`meeting_minutes_assignee_${status}`);
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
    await expect(resumeMeetingMinutesRun(fs, selection, options)).rejects.toThrow("task api down");
    expect(options.postParent).not.toHaveBeenCalled();
    const retried = await resumeMeetingMinutesRun(fs, selection, options);
    expect(retried.taskRegistration?.registered.map((task) => task.taskId)).toEqual(["task-1", "task-2"]);
    expect(createTask).toHaveBeenCalledTimes(3);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ title: "資料を更新する" });
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ title: "請求書を送る" });
    expect(createTask.mock.calls[2]?.[0]).toMatchObject({ title: "請求書を送る" });
    expect(createTask.mock.calls[1]?.[1]).toBe(createTask.mock.calls[2]?.[1]);
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
});
