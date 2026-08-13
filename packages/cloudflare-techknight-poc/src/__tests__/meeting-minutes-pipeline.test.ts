import { resumeMeetingMinutesRun, startMeetingMinutesRuns } from "../meeting-minutes-pipeline.js";
import type { MeetingMinutesDestination, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const destination: MeetingMinutesDestination = { id: "mana", projectId: "mana", name: "mana", slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } };
const event: SlackQueueEvent = { tenantId: "unson", eventId: "Ev1", workspaceId: "T1", channelId: "CROUTER",
  threadTs: "1.1", messageTs: "1.1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
  files: [{ id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 100 }] };
const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "mana",
  workspaceId: "T1", channelId: "CROUTER", userId: "U1", actionTs: "2.1" };
function resumeOptions(overrides: Record<string, unknown> = {}) {
  return { destinations: [destination], download: vi.fn().mockResolvedValue("transcript"),
    generate: vi.fn().mockResolvedValue({ title: "定例", overview: "概要", body: "本文" }),
    saveGitHub: vi.fn().mockResolvedValue({ transcriptPath: "docs/transcripts/a.txt", minutesPath: "docs/minutes/a.md",
      transcriptUrl: "https://github/t", minutesUrl: "https://github/m" }),
    postParent: vi.fn().mockResolvedValue("10.1"), postThreadChunk: vi.fn().mockResolvedValue("10.2"), ...overrides };
}

describe("meeting minutes pipeline", () => {
  it("creates one stable awaiting run and does not duplicate the selector", async () => {
    const fs = new MemoryFs(); const requestDestination = vi.fn().mockResolvedValue("2.1");
    const first = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", destinations: [destination], requestDestination });
    const second = await startMeetingMinutesRuns(fs, event, { enabled: true, routerChannelId: "CROUTER", destinations: [destination], requestDestination });
    expect(first[0]).toMatchObject({ runId: "Ev1_F1", status: "awaiting_destination" });
    expect(second[0]?.runId).toBe("Ev1_F1"); expect(requestDestination).toHaveBeenCalledTimes(1);
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
    expect(options.postParent).toHaveBeenCalledWith("CDEST", "*定例*\n概要", "Ev1_F1-parent");
    expect(options.postThreadChunk).toHaveBeenCalledWith(
      "CDEST",
      "10.1",
      "*定例*\n概要\n\n------------\n\n本文",
      "Ev1_F1-chunk-0",
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
});
