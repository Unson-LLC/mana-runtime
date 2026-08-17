import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import type { TaskBoardRepairEvent } from "../task-board.js";
import {
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
  processTaskBoardRepair,
  taskBoardTargets,
} from "../task-runtime-entrypoints.js";

const event = {
  eventId: "Ev123",
  tenantId: "unson-business",
  workspaceId: "T0882T8N9UH",
  channelId: "C0BKS6RL99T",
  threadTs: "1.2",
  userId: "U_REQUESTER",
} as never;

const runtime = {
  RUNTIME_TASK_WRITE_ENABLED: "true",
  TASK_WRITE_CAPABILITY_SECRET: "write-capability-secret-at-least-32-bytes",
  RUNTIME_PLACEMENT_ID: "mana-accounting",
  RUNTIME_PROJECT_CODES: "back-office",
};

const repair = {
  eventType: "task_board_repair" as const,
  targetId: "business",
  tenantId: "unson-business",
  workspaceId: "T0882T8N9UH",
  channelId: "C0BKS6RL99T",
  reason: "scheduled" as const,
  requestedAt: "2026-08-13T00:00:00.000Z",
};

const businessTarget = {
  targetId: "business",
  organizationId: "unson-business",
  workspaceId: "T0882T8N9UH",
  channelId: "C0BKS6RL99T",
  projectCodes: ["back-office"],
};

const devTarget = {
  targetId: "dev",
  organizationId: "unson-business",
  workspaceId: "T0882T8N9UH",
  channelId: "C0DEV123456",
  projectCodes: ["mana"],
};

const resolveTaskBoardTenant = async (input: TaskBoardRepairEvent) => ({
  tenant: { tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  slack: {
    event_id: `task-board-repair:${input.targetId}:${input.requestedAt}`,
    channel_id: input.channelId,
    thread_ts: input.requestedAt,
    requester_id: "service_task_board",
  },
}) as never;

describe("Cloudflare task runtime entrypoints", () => {
  it("rejects TaskBoard scheduling when canonical targets are absent instead of creating legacy targets", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T_UNSON",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_REPAIRS: { send },
    };

    expect(() => taskBoardTargets(env)).toThrow("task_board_targets_required");
    await expect(enqueueScheduledTaskBoardRepair(
      env,
      "2026-08-17T00:00:00.000Z",
      resolveTaskBoardTenant,
    )).rejects.toThrow("task_board_targets_required");
    expect(send).not.toHaveBeenCalled();
  });

  it("issues a requester, placement, and project scoped write capability", async () => {
    const result = await issueTaskWriteRequestContext(event, runtime, 1_000, undefined, "per_requester");
    expect(result.taskWriteEnabled).toBe(true);
    const claims = await verifyTaskWriteCapability(result.taskWriteCapability!, runtime.TASK_WRITE_CAPABILITY_SECRET, {
      requestId: "Ev123",
      workspace: "T0882T8N9UH",
      placementId: "mana-accounting",
      now: 1_001,
    });
    expect(claims).toMatchObject({ actor: { id: "U_REQUESTER", personId: "per_requester" }, projects: ["back-office"], budget: 3, nonce: "Ev123" });
  });

  it("fails closed when writes are enabled without trusted authority", async () => {
    await expect(issueTaskWriteRequestContext(event, { ...runtime, RUNTIME_PLACEMENT_ID: undefined })).rejects.toThrow("task_write_not_configured");
  });

  it("processes a canonical scoped repair and rejects a cross-scope repair", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
    };
    await processTaskBoardRepair(repair, env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledOnce();

    await expect(processTaskBoardRepair({ ...repair, channelId: "C_OTHER" }, env, "unson-business", fetch, refresh))
      .rejects.toThrow("task_board_scope_mismatch");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("propagates a failed canonical repair and enqueues the scheduled scoped repair", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget]),
      TASK_BOARD_REPAIRS: { send },
    };
    await expect(processTaskBoardRepair(repair, env, "unson-business", fetch,
      vi.fn().mockRejectedValue(new Error("boom")))).rejects.toThrow("boom");
    const tenantContext = {
      tenant: { tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      slack: { event_id: "task-board-repair:business:2026-08-13T01:00:00.000Z",
        channel_id: "C0BKS6RL99T", thread_ts: "2026-08-13T01:00:00.000Z",
        requester_id: "service_task_board" },
    } as never;
    const resolveTenantContext = vi.fn(async () => tenantContext);
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T01:00:00.000Z", resolveTenantContext);
    expect(resolveTenantContext).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "business", channelId: "C0BKS6RL99T",
    }));
    expect(send).toHaveBeenCalledWith({
      schema_version: "1.0",
      tenant_context: tenantContext,
      payload: { ...repair, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedAt: "2026-08-13T01:00:00.000Z" },
    });
  });

  it("enqueues and refreshes each canonical target with only its own projects", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH", SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token", RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "accounting", channelId: "C0BKS6RL99T", projectCodes: ["back-office"], taskBoardEnabled: true },
        { placementId: "dev", channelId: "C0DEV123456", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C0ROUTER123", projectCodes: ["unson"] },
      ]), TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget, devTarget]), TASK_BOARD_REPAIRS: { send } };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T02:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ channelId: "C0DEV123456" }) }));

    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "dev", channelId: "C0DEV123456" },
      env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ SLACK_ALLOWED_CHANNEL_ID: "C0DEV123456", RUNTIME_PROJECT_CODES: "mana" }),
      { fetch });
  });

  it("uses canonical targets even when the legacy global flag is off", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      SLACK_ALLOWED_CHANNEL_ID: "C0LEGACY123",
      RUNTIME_TASK_BOARD_ENABLED: "false",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "dev", channelId: "C0DEV123456", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C0ROUTER123", projectCodes: ["unson"], taskBoardEnabled: false },
      ]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([devTarget]),
      TASK_BOARD_REPAIRS: { send },
    };

    await enqueueScheduledTaskBoardRepair(env, "2026-08-14T00:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ channelId: "C0DEV123456" }) }));

    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "dev", channelId: "C0DEV123456" },
      env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_ALLOWED_CHANNEL_ID: "C0DEV123456",
      RUNTIME_PROJECT_CODES: "mana",
    }), { fetch });
  });

  it("schedules every trusted workspace target and uses its isolated Slack token", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const targets = [
      { targetId: "unson", organizationId: "unson", workspaceId: "T07LL5WV7N1", channelId: "C0BKXCVSDCH",
        projectCodes: ["proj_unson"] },
      { targetId: "tech", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
        projectCodes: ["proj_tech"] },
    ];
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token", SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify(targets), TASK_BOARD_REPAIRS: { send } };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-15T00:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(2);

    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "tech", workspaceId: "T07A9J3PEMB",
      channelId: "C0BKX9Y169F" }, env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ SLACK_BOT_TOKEN: "tenant-credential-injected",
      BRAINBASE_TASK_API_TOKEN: "tenant-credential-injected",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKX9Y169F", RUNTIME_PROJECT_CODES: "proj_tech" }), { fetch });
  });

  it("reports a partial scheduled fanout failure after attempting every trusted target", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token", SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([
        { targetId: "unson", organizationId: "unson", workspaceId: "T07LL5WV7N1", channelId: "C0BKXCVSDCH",
          projectCodes: ["proj_unson"] },
        { targetId: "tech", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
          projectCodes: ["proj_tech"] },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };
    await expect(enqueueScheduledTaskBoardRepair(env, "2026-08-15T01:00:00.000Z", resolveTaskBoardTenant))
      .rejects.toThrow("task_board_schedule_enqueue_failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
