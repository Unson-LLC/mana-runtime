import { armMeetingMinutesRecovery, recoverStaleMeetingMinutesRun } from "../meeting-minutes-recovery.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { MeetingMinutesRun, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1",
  destinationId: "united", workspaceId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" };
function run(status: MeetingMinutesRun["status"] = "routed"): MeetingMinutesRun {
  return { version: 1, runId: "Ev1_F1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
    sourceThreadTs: "1.1", sourceMessageTs: "1.1", file: { id: "F1", name: "meeting.txt" }, status,
    destination: { id: "united", projectId: "united", name: "United", organization: { id: "tech-knight", name: "Tech Knight" },
      slackChannelId: "CD", github: { owner: "o", repo: "r" } },
    slack: { processingTs: "3.1", postedChunkIndexes: [] }, createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z" };
}

describe("meeting minutes stale recovery", () => {
  it("arms one fixed deadline per Slack action without extending it on Queue retry", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const first = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const second = await armMeetingMinutesRecovery(fs, selection, 60_000);
    expect(second.event).toEqual(first.event);
    expect((await loadMeetingMinutesRun(fs, selection.runId))?.lifecycle?.deadlineAt)
      .toBe(new Date(1_000 + 20 * 60 * 1_000).toISOString());
  });

  it("recovers a stale nonterminal run once and leaves completed or duplicate watchdogs alone", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, { now: () => 1_000 + 20 * 60 * 1_000,
      updateStatus })).toBe("recovered");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "failed",
      failure: { stage: "routed", message: "meeting_minutes_processing_interrupted" },
      lifecycle: { recoveryProjectedAt: expect.any(String) } });
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, { now: () => 9_999_999, updateStatus })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledTimes(1);
  });

  it("does not let an old watchdog fail a newer explicit retry", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const old = await armMeetingMinutesRecovery(fs, selection, 1_000);
    await armMeetingMinutesRecovery(fs, { ...selection, actionTs: "4.1" }, 2_000);
    const updateStatus = vi.fn();
    expect(await recoverStaleMeetingMinutesRun(fs, old.event, { now: () => 9_999_999, updateStatus })).toBe("superseded");
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("treats an already projected failure as terminal without duplicating the Slack projection", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectedAt: new Date(1_000).toISOString() };
    await saveMeetingMinutesRun(fs, failed);
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn();
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000,
      updateStatus,
    })).toBe("terminal");
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
