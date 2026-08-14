import { describe, expect, it, vi } from "vitest";
import { handleMeetingMinutesTaskAction } from "../meeting-minutes-task-actions.js";
import { meetingMinutesTaskCard } from "../meeting-minutes-task-cards.js";
import type { MeetingMinutesRun } from "../meeting-minutes-contracts.js";

function run(): MeetingMinutesRun {
  return { version: 1, runId: "Ev_Fv", eventId: "Ev", workspaceId: "TU", sourceChannelId: "CR",
    sourceThreadTs: "1.1", sourceMessageTs: "1.1", file: { id: "Fv", name: "meeting.txt" }, status: "completed",
    destination: { id: "pms", projectId: "proj_pms", name: "PMS", organization: { id: "tech-knight", name: "Tech Knight" },
      slackChannelId: "CDEST", github: { owner: "o", repo: "r" } },
    generated: { title: "会議", overview: "概要", body: "本文", tasks: [{ title: "旧題", description: "説明", due_at: "2026-08-20" }] },
    taskRegistration: { registered: [{ index: 0, title: "旧題", taskId: "task-1" }] },
    slack: { parentTs: "2.1", taskCardTs: "2.2", postedChunkIndexes: [] }, createdAt: "2026-08-14T00:00:00Z", updatedAt: "2026-08-14T00:00:00Z" };
}
function payload(actionId: string) { return { team: { id: "TTK" }, channel: { id: "CDEST" }, user: { id: "U1" },
  trigger_id: "trigger", actions: [{ action_id: actionId, value: JSON.stringify({ runId: "Ev_Fv", index: 0,
    organizationId: "tech-knight", channelId: "CDEST", title: "旧題", due: "2026-08-20" }) }] }; }
function deps(current: MeetingMinutesRun) { return { sourceTeamId: "TU", destinationTeamIds: { "tech-knight": "TTK" },
  operatorUserIds: new Set(["U1"]),
  loadRun: vi.fn(async () => current), saveRun: vi.fn(async () => {}),
  getTask: vi.fn(async () => ({ id: "task-1", version: 3, title: "旧題", description: null, status: "pending",
    priority: "medium", project_codes: ["proj_pms"], assignee_person_id: null, assignee_display_name: null,
    due_at: null, waiting_on: null, completed_at: null })),
  updateTask: vi.fn(async () => ({ id: "task-1" }) as never), deleteTask: vi.fn(async () => ({})),
  updateCard: vi.fn(async () => {}), openView: vi.fn(async () => {}), repairTaskBoard: vi.fn(async () => {}),
  defer: (work: Promise<void>) => { void work; } };
}
describe("meeting minutes task cards", () => {
  it("renders each canonical task with edit and cancel controls", () => {
    const card = meetingMinutesTaskCard(run()); expect(card.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "actions", elements: expect.arrayContaining([
        expect.objectContaining({ action_id: "mana_meeting_minutes_task_edit" }),
        expect.objectContaining({ action_id: "mana_meeting_minutes_task_cancel" }),
      ]) }),
    ])); expect(JSON.stringify(card.blocks)).toContain("説明");
  });
  it("deletes only a task in the run destination project and redraws the card", async () => {
    const current = run(); const options = deps(current);
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200); await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.deleteTask).toHaveBeenCalledWith("task-1", 3, expect.any(String));
    expect(current.taskRegistration!.registered[0]!.status).toBe("removed");
    expect(options.repairTaskBoard).toHaveBeenCalled();
  });
  it("opens the edit modal and rejects a destination-channel mismatch", async () => {
    const current = run(); const options = deps(current);
    await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_edit"), options);
    await vi.waitFor(() => expect(options.openView).toHaveBeenCalledWith("tech-knight", "trigger", expect.objectContaining({ callback_id: "mana_meeting_minutes_task_edit_submit" })));
    expect(options.loadRun).not.toHaveBeenCalled();
    const forbidden = payload("mana_meeting_minutes_task_cancel"); forbidden.channel.id = "COTHER";
    expect((await handleMeetingMinutesTaskAction(forbidden, options))?.status).toBe(403);
  });
  it("rejects a non-operator before reading the durable run", async () => {
    const current = run(); const options = deps(current); const request = payload("mana_meeting_minutes_task_cancel"); request.user.id = "U2";
    expect((await handleMeetingMinutesTaskAction(request, options))?.status).toBe(403);
    expect(options.loadRun).not.toHaveBeenCalled();
  });
});
