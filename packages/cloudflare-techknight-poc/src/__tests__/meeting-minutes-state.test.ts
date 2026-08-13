import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

describe("meeting minutes run state", () => {
  it("round trips a versioned run without secrets or download URLs", async () => {
    const fs = new MemoryFs();
    await saveMeetingMinutesRun(fs, { version: 1, runId: "Ev1_F1", eventId: "Ev1", workspaceId: "T1",
      sourceChannelId: "C1", sourceThreadTs: "1", sourceMessageTs: "1", file: { id: "F1", name: "meeting.txt" },
      status: "awaiting_destination", slack: { postedChunkIndexes: [] }, createdAt: "now", updatedAt: "now" });
    await expect(loadMeetingMinutesRun(fs, "Ev1_F1")).resolves.toMatchObject({ status: "awaiting_destination", file: { id: "F1" } });
    expect([...fs.files.values()].join()).not.toContain("token");
  });
});
