import {
  enqueueMeetingMinutesTaskBoardRepair,
  enqueueTaskBoardRepairsForProjects,
} from "../task-runtime-entrypoints.js";

const disabledTarget = {
  targetId: "minutes-pms",
  organizationId: "tech-knight",
  workspaceId: "T07A9J3PEMB",
  channelId: "C0BKX9Y169F",
  projectCodes: ["proj_pms"],
  enabled: false,
  manaCanvasId: null,
  bindingRevision: null,
};

const tenantContext = async (repair: { channelId: string; requestedAt: string; targetId: string }) => ({
  tenant: { tenant_id: "ten_test" },
  slack: { event_id: `task-board-repair:${repair.targetId}:${repair.requestedAt}`,
    channel_id: repair.channelId, thread_ts: repair.requestedAt, requester_id: "svc_canvas" },
} as never);

describe("Worker task Canvas repair producers", () => {
  it("suppresses a disabled meeting repair with an ownership decision log", async () => {
    const send = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = { TENANT_ID: "unson-business", TASK_BOARD_TARGETS_JSON: JSON.stringify([disabledTarget]),
      TASK_BOARD_REPAIRS: { send } } as never;

    await enqueueMeetingMinutesTaskBoardRepair(env, "minutes-pms", "task_write", tenantContext);

    expect(send).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(JSON.stringify({ event: "task_board_repair_suppressed",
      targetId: "minutes-pms", reason: "target_disabled" }));
    info.mockRestore();
  });

  it("suppresses disabled project fanout and enqueues an exact binding snapshot", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const activeTarget = { ...disabledTarget, targetId: "minutes-pms-owned", organizationId: "unson-business",
      workspaceId: "T0882T8N9UH", channelId: "C0BKX9Y1700", enabled: true,
      manaCanvasId: "FOWNED", bindingRevision: 3 };
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([{
        placementId: "minutes", channelId: "C0BKX9Y1700", projectCodes: ["proj_pms"], taskBoardEnabled: true,
      }]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([disabledTarget, activeTarget]), TASK_BOARD_REPAIRS: { send } } as never;

    await enqueueTaskBoardRepairsForProjects(env, ["proj_pms"], "task_write", tenantContext);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ schema_version: "1.0",
      payload: expect.objectContaining({ targetId: "minutes-pms-owned",
        tenantId: "ten_test", manaCanvasId: "FOWNED", bindingRevision: 3 }) }));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"targetId":"minutes-pms"'));
    info.mockRestore();
  });

  it("suppresses active meeting and project repairs outside tenant, workspace, or placement scope", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const foreignTarget = { ...disabledTarget, enabled: true, manaCanvasId: "FFOREIGN", bindingRevision: 1 };
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([{
        placementId: "minutes", channelId: "C0BKX9Y169F", projectCodes: ["proj_pms"], taskBoardEnabled: true,
      }]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([foreignTarget]), TASK_BOARD_REPAIRS: { send },
    } as never;

    await enqueueMeetingMinutesTaskBoardRepair(env, "minutes-pms", "task_write", tenantContext);
    await enqueueTaskBoardRepairsForProjects(env, ["proj_pms"], "task_write", tenantContext);

    expect(send).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(JSON.stringify({ event: "task_board_repair_suppressed",
      targetId: "minutes-pms", reason: "tenant_mismatch" }));
    info.mockRestore();
  });
});
