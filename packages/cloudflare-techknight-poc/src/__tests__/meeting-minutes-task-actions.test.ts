import { describe, expect, it, vi } from "vitest";
import { handleMeetingMinutesTaskAction, type MeetingMinutesTaskActionDependencies } from "../meeting-minutes-task-actions.js";
import { meetingMinutesTaskCard } from "../meeting-minutes-task-cards.js";
import type { MeetingMinutesRun } from "../meeting-minutes-contracts.js";
import { meetingMinutesRuntimeConfig } from "../meeting-minutes-entrypoints.js";

function run(): MeetingMinutesRun {
  return { version: 1, runId: "Ev_Fv", eventId: "Ev", workspaceId: "TU", sourceChannelId: "CR",
    sourceThreadTs: "1.1", sourceMessageTs: "1.1", file: { id: "Fv", name: "meeting.txt" }, status: "completed",
    destination: { id: "pms", projectId: "proj_pms", contextProjectCode: "techknight",
      taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-pms", name: "PMS",
      organization: { id: "tech-knight", name: "Tech Knight" },
      slackChannelId: "CDEST", github: { owner: "o", repo: "r" } },
    generated: { title: "会議", overview: "概要", body: "本文", tasks: [{ title: "旧題", description: "説明", due_at: "2026-08-20" }] },
    taskRegistration: { registered: [{ index: 0, title: "旧題", taskId: "task-1" }] },
    slack: { parentTs: "2.1", taskCardTs: "2.2", postedChunkIndexes: [] }, createdAt: "2026-08-14T00:00:00Z", updatedAt: "2026-08-14T00:00:00Z" };
}
function payload(actionId: string) { return { team: { id: "TTK" }, channel: { id: "CDEST" }, user: { id: "U1" },
  trigger_id: "trigger", actions: [{ action_id: actionId, value: JSON.stringify({ runId: "Ev_Fv", index: 0,
    organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms", title: "旧題", due: "2026-08-20" }) }] }; }
function deps(current: MeetingMinutesRun) { return { sourceTeamId: "TU", destinationTeamIds: { "tech-knight": "TTK" },
  destinations: [run().destination!],
  operatorUserIds: new Set(["U1"]),
  loadRun: vi.fn(async () => current), saveRun: vi.fn(async () => {}),
  getTask: vi.fn(async () => ({ id: "task-1", version: 3, title: "旧題", description: null, status: "pending",
    priority: "medium", project_codes: ["techknight"], assignee_person_id: null, assignee_display_name: null,
    due_at: null, waiting_on: null, completed_at: null })),
  updateTask: vi.fn<MeetingMinutesTaskActionDependencies["updateTask"]>(async () => ({ id: "task-1", version: 4, title: "旧題", description: null, status: "pending",
    priority: "medium", project_codes: ["techknight"], assignee_person_id: null, assignee_display_name: null,
    due_at: null, waiting_on: null, completed_at: null })), deleteTask: vi.fn(async () => ({})),
  updateCard: vi.fn(async (_run: MeetingMinutesRun) => {}),
  notifyScopeMismatch: vi.fn(async (_run: MeetingMinutesRun, _userId: string) => {}),
  openView: vi.fn(async (_organizationId: string, _triggerId: string, _view: Record<string, unknown>) => {}),
  listPeople: vi.fn(async () => [{ id: "per_umeda", name: "梅田 遼", aliases: ["梅田"] }]), repairTaskBoard: vi.fn(async () => {}),
  defer: (work: Promise<void>) => { void work; } };
}
function stoppedDestinations(current: MeetingMinutesRun) {
  return meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "false", MEETING_MINUTES_ROUTER_CHANNEL_ID: "CR",
    MEETING_MINUTES_OPERATOR_USER_IDS: "U1", MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([current.destination]) }).destinations;
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
  it("distinguishes reused and ambiguous tasks without destructive controls", () => {
    const current = run();
    current.taskRegistration!.registered = [
      { index: 0, title: "既存タスク", taskId: "task-1", status: "reused" },
      { index: 1, title: "似たタスク", taskId: "task-2", status: "needs_review" },
    ];
    current.generated!.tasks = [{ title: "既存タスク" }, { title: "似たタスク" }];
    const card = meetingMinutesTaskCard(current); const serialized = JSON.stringify(card.blocks);
    expect(serialized).toContain("既存1件・要確認1件");
    expect(serialized).toContain("既存タスクを再利用");
    expect(serialized).toContain("似た既存タスクあり・要確認");
    expect(serialized).not.toContain("mana_meeting_minutes_task_cancel");
  });
  it("deletes only a task in the run destination project and redraws the card", async () => {
    const current = run(); const options = deps(current);
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200); await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.deleteTask).toHaveBeenCalledWith("task-1", 3, expect.any(String));
    expect(current.taskRegistration!.registered[0]!.status).toBe("removed");
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("uses the explicit canonical task scope instead of the minutes destination identity", async () => {
    const current = run(); current.destination!.taskProjectCodes = ["unson"];
    const options = deps(current);
    options.destinations[0]!.taskProjectCodes = ["unson"];
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["unson"] });
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200); await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.deleteTask).toHaveBeenCalledWith("task-1", 3, expect.any(String));
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("migrates a legacy completed run before cancelling its task", async () => {
    const current = run();
    const legacy = current.destination as unknown as { taskProjectCodes?: string[]; taskBoardTargetId?: string };
    delete legacy.taskProjectCodes; delete legacy.taskBoardTargetId;
    delete current.taskRegistration!.registered[0]!.projectCodes;
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["proj_pms"] });
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(current.destination).toEqual(expect.objectContaining({
      taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-pms",
    }));
    expect(options.saveRun).toHaveBeenCalledWith(current);
    expect(options.deleteTask).toHaveBeenCalledTimes(1);
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("migrates a legacy completed run before editing its task", async () => {
    const current = run();
    const legacy = current.destination as unknown as { taskProjectCodes?: string[]; taskBoardTargetId?: string };
    delete legacy.taskProjectCodes; delete legacy.taskBoardTargetId;
    delete current.taskRegistration!.registered[0]!.projectCodes;
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["proj_pms"] });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms" }), state: { values: {
          title: { value: { value: "新題" } }, due: { value: {} }, assignee: { mana_meeting_minutes_task_assignee: {} },
        } } } }, options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      expected_version: 3, title: "新題", project_codes: ["techknight"],
    }), expect.any(String));
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
    expect(current.destination).toEqual(expect.objectContaining({
      taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-pms",
    }));
  });
  it("still migrates a historical projectId task after the run destination was already reconciled", async () => {
    const current = run();
    current.destination!.taskProjectCodes = ["techknight"];
    current.destination!.taskBoardTargetId = "minutes-pms";
    delete current.taskRegistration!.registered[0]!.projectCodes;
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["proj_pms"] });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms" }), state: { values: {
          title: { value: { value: "新題" } }, due: { value: {} }, assignee: { mana_meeting_minutes_task_assignee: {} },
        } } } }, options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      project_codes: ["techknight"], title: "新題",
    }), expect.any(String));
  });

  it("still cancels a historical projectId task after the run destination was already reconciled", async () => {
    const current = run();
    current.destination!.taskProjectCodes = ["techknight"];
    current.destination!.taskBoardTargetId = "minutes-pms";
    delete current.taskRegistration!.registered[0]!.projectCodes;
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["proj_pms"] });
    expect((await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options))?.status).toBe(200);
    await vi.waitFor(() => expect(options.deleteTask).toHaveBeenCalled());
    expect(options.deleteTask).toHaveBeenCalledWith("task-1", 3, expect.any(String));
  });
  it("moves an old Kartz task from unson into the current kartz scope while minutes are disabled", async () => {
    const current = run();
    current.destination!.id = "kartz";
    current.destination!.taskProjectCodes = ["unson"];
    current.destination!.taskBoardTargetId = "minutes-kartz";
    current.taskRegistration!.registered[0]!.projectCodes = ["unson"];
    const options = deps(current);
    options.destinations = stoppedDestinations({ ...current, destination: {
      ...current.destination!, taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz",
    } });
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["unson"] });
    options.updateTask.mockResolvedValue({ id: "task-1", version: 4, title: "新題", description: null,
      status: "pending", priority: "medium", project_codes: ["kartz"], assignee_person_id: null,
      assignee_display_name: null, due_at: null, waiting_on: null, completed_at: null });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_kartz" }), state: { values: {
          title: { value: { value: "新題" } }, due: { value: {} }, assignee: { mana_meeting_minutes_task_assignee: {} },
        } } } }, options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      expected_version: 3, title: "新題", project_codes: ["kartz"],
    }), expect.any(String));
    expect(current.destination!.taskProjectCodes).toEqual(["kartz"]);
    expect(current.taskRegistration!.registered[0]!.projectCodes).toEqual(["kartz"]);
  });
  it("cancels an old Kartz task using its trusted legacy scope while minutes are disabled", async () => {
    const current = run();
    current.destination!.id = "kartz";
    current.destination!.taskProjectCodes = ["unson"];
    current.destination!.taskBoardTargetId = "minutes-kartz";
    current.taskRegistration!.registered[0]!.projectCodes = ["unson"];
    const options = deps(current);
    options.destinations = stoppedDestinations({ ...current, destination: {
      ...current.destination!, taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz",
    } });
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["unson"] });
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.deleteTask).toHaveBeenCalledWith("task-1", 3, expect.any(String));
    expect(current.destination!.taskProjectCodes).toEqual(["kartz"]);
    expect(current.taskRegistration!.registered[0]!.status).toBe("removed");
  });
  it("rejects an unrelated task scope while migrating an old run", async () => {
    const current = run();
    current.destination!.id = "kartz";
    current.destination!.taskProjectCodes = ["unson"];
    const options = deps(current);
    options.destinations[0] = { ...current.destination!, taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz" };
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["unrelated"] });
    await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    await vi.waitFor(() => expect(options.getTask).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options.deleteTask).not.toHaveBeenCalled();
    expect(options.updateCard).not.toHaveBeenCalled();
    expect(options.notifyScopeMismatch).toHaveBeenCalledWith(current, "U1");
  });
  it("does not trust the historical projectId when the run item already records a modern scope", async () => {
    const current = run();
    current.taskRegistration!.registered[0]!.projectCodes = ["techknight"];
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["proj_pms"] });
    await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    await vi.waitFor(() => expect(options.notifyScopeMismatch).toHaveBeenCalledWith(current, "U1"));
    expect(options.deleteTask).not.toHaveBeenCalled();
    expect(options.updateCard).not.toHaveBeenCalled();
  });
  it("notifies the operator when editing a task from an unrelated project scope", async () => {
    const current = run();
    const options = deps(current);
    options.getTask.mockResolvedValue({ ...(await options.getTask()), project_codes: ["unrelated"] });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms" }), state: { values: {
          title: { value: { value: "新題" } }, due: { value: {} }, assignee: { mana_meeting_minutes_task_assignee: {} },
        } } } }, options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.notifyScopeMismatch).toHaveBeenCalledWith(current, "U1"));
    expect(options.updateTask).not.toHaveBeenCalled();
    expect(options.updateCard).not.toHaveBeenCalled();
  });
  it("repairs the destination Canvas when the canonical task was already deleted", async () => {
    const current = run(); const options = deps(current);
    const legacy = current.destination as unknown as { taskProjectCodes?: string[]; taskBoardTargetId?: string };
    delete legacy.taskProjectCodes; delete legacy.taskBoardTargetId;
    options.getTask.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    const response = await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_cancel"), options);
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.deleteTask).not.toHaveBeenCalled();
    expect(current.taskRegistration!.registered[0]!.status).toBe("removed");
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("opens the edit modal and rejects a destination-channel mismatch", async () => {
    const current = run(); const options = deps(current);
    await handleMeetingMinutesTaskAction(payload("mana_meeting_minutes_task_edit"), options);
    await vi.waitFor(() => expect(options.openView).toHaveBeenCalledWith("tech-knight", "trigger", expect.objectContaining({ callback_id: "mana_meeting_minutes_task_edit_submit" })));
    expect(JSON.stringify(options.openView.mock.calls[0]?.[2])).toContain("担当者（Graph SSOT）");
    expect(options.loadRun).not.toHaveBeenCalled();
    const forbidden = payload("mana_meeting_minutes_task_cancel"); forbidden.channel.id = "COTHER";
    expect((await handleMeetingMinutesTaskAction(forbidden, options))?.status).toBe(403);
  });
  it("keeps already-posted edit buttons compatible when projectId is absent", async () => {
    const options = deps(run()); const request = payload("mana_meeting_minutes_task_edit");
    const action = request.actions[0]!; const value = JSON.parse(action.value) as Record<string, unknown>; delete value.projectId;
    action.value = JSON.stringify(value);
    expect((await handleMeetingMinutesTaskAction(request, options))?.status).toBe(200);
    await vi.waitFor(() => expect(options.openView).toHaveBeenCalled());
    const view = options.openView.mock.calls[0]?.[2] as Record<string, unknown>;
    const viewMetadata = JSON.parse(String(view.private_metadata)) as Record<string, unknown>;
    expect(viewMetadata.projectId).toBeUndefined();
    const suggestion = await handleMeetingMinutesTaskAction({ type: "block_suggestion", team: { id: "TTK" }, user: { id: "U1" },
      view: { private_metadata: view.private_metadata }, action_id: "mana_meeting_minutes_task_assignee", value: "梅田" }, options);
    expect(suggestion?.status).toBe(200); expect(options.listPeople).toHaveBeenCalledWith();
  });
  it("returns Graph SSOT people for the assignee selector", async () => {
    const options = deps(run());
    const response = await handleMeetingMinutesTaskAction({ type: "block_suggestion", team: { id: "TTK" }, user: { id: "U1" },
      view: { private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0, organizationId: "tech-knight",
        channelId: "CDEST", projectId: "proj_pms" }) }, action_id: "mana_meeting_minutes_task_assignee", value: "梅田" }, options);
    expect(response?.status).toBe(200); expect(await response?.json()).toEqual({ options: [
      { text: { type: "plain_text", text: "（担当なし）" }, value: "__none__" },
      { text: { type: "plain_text", text: "梅田 遼" }, value: "per_umeda" },
    ] });
    expect(options.listPeople).toHaveBeenCalledWith();
  });
  it("accepts Slack block suggestions that carry action_id and value in actions", async () => {
    const options = deps(run());
    const response = await handleMeetingMinutesTaskAction({ type: "block_suggestion", team: { id: "TTK" }, user: { id: "U1" },
      view: { private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0, organizationId: "tech-knight",
        channelId: "CDEST", projectId: "proj_pms" }) },
      actions: [{ action_id: "mana_meeting_minutes_task_assignee", value: "梅田" }] }, options);
    expect(response?.status).toBe(200); expect(await response?.json()).toEqual({ options: [
      { text: { type: "plain_text", text: "（担当なし）" }, value: "__none__" },
      { text: { type: "plain_text", text: "梅田 遼" }, value: "per_umeda" },
    ] });
  });
  it("updates the canonical Graph assignee and redraws the task card", async () => {
    const current = run(); const options = deps(current);
    options.updateTask.mockResolvedValue({ id: "task-1", version: 4, title: "新題", description: null,
      status: "pending", priority: "medium", project_codes: ["techknight"], assignee_person_id: "per_umeda",
      assignee_display_name: "梅田 遼", due_at: null, waiting_on: null, completed_at: null });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms" }), state: { values: {
          title: { value: { value: "新題" } }, due: { value: {} },
          assignee: { mana_meeting_minutes_task_assignee: { selected_option: { value: "per_umeda" } } },
        } } } }, options);
    expect(response?.status).toBe(200); await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ assignee_person_id: "per_umeda" }), expect.any(String));
    expect(current.taskRegistration!.registered[0]!).toEqual(expect.objectContaining({ assigneePersonId: "per_umeda", assigneeDisplayName: "梅田 遼" }));
    expect(current.generated?.tasks?.[0]?.assignee_name).toBe("梅田 遼");
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("removes the canonical assignee when 担当なし is selected", async () => {
    const current = run(); current.taskRegistration!.registered[0]!.assigneePersonId = "per_umeda";
    current.taskRegistration!.registered[0]!.assigneeDisplayName = "梅田 遼";
    current.generated!.tasks![0]!.assignee_name = "梅田 遼";
    const options = deps(current); options.updateTask.mockResolvedValue({ id: "task-1", version: 4, title: "旧題", description: null,
      status: "pending", priority: "medium", project_codes: ["techknight"], assignee_person_id: null,
      assignee_display_name: null, due_at: null, waiting_on: null, completed_at: null });
    const response = await handleMeetingMinutesTaskAction({ type: "view_submission", team: { id: "TTK" }, user: { id: "U1" },
      view: { callback_id: "mana_meeting_minutes_task_edit_submit", private_metadata: JSON.stringify({ runId: "Ev_Fv", index: 0,
        organizationId: "tech-knight", channelId: "CDEST", projectId: "proj_pms" }), state: { values: {
          title: { value: { value: "旧題" } }, due: { value: {} },
          assignee: { mana_meeting_minutes_task_assignee: { selected_option: { value: "__none__" } } },
        } } } }, options);
    expect(response?.status).toBe(200); await vi.waitFor(() => expect(options.updateCard).toHaveBeenCalled());
    expect(options.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ assignee_person_id: null }), expect.any(String));
    expect(current.taskRegistration!.registered[0]!.assigneePersonId).toBeUndefined();
    expect(current.taskRegistration!.registered[0]!.assigneeDisplayName).toBeUndefined();
    expect(current.generated?.tasks?.[0]?.assignee_name).toBeUndefined();
    expect(options.repairTaskBoard).toHaveBeenCalledWith("minutes-pms");
  });
  it("rejects a non-operator before reading the durable run", async () => {
    const current = run(); const options = deps(current); const request = payload("mana_meeting_minutes_task_cancel"); request.user.id = "U2";
    expect((await handleMeetingMinutesTaskAction(request, options))?.status).toBe(403);
    expect(options.loadRun).not.toHaveBeenCalled();
  });
});
