import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import type { TaskBoardRepairEvent } from "../task-board.js";
import {
  consumeTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
} from "../task-runtime-entrypoints.js";

const event = {
  eventId: "Ev123",
  tenantId: "unson-business",
  workspaceId: "T_UNSON",
  channelId: "C_BACK_OFFICE",
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
  targetId: "legacy-default",
  tenantId: "unson-business",
  workspaceId: "T_UNSON",
  channelId: "C_BACK_OFFICE",
  reason: "scheduled" as const,
  requestedAt: "2026-08-13T00:00:00.000Z",
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
  it("issues a requester, placement, and project scoped write capability", async () => {
    const result = await issueTaskWriteRequestContext(event, runtime, 1_000, undefined, "per_requester");
    expect(result.taskWriteEnabled).toBe(true);
    const claims = await verifyTaskWriteCapability(result.taskWriteCapability!, runtime.TASK_WRITE_CAPABILITY_SECRET, {
      requestId: "Ev123",
      workspace: "T_UNSON",
      placementId: "mana-accounting",
      now: 1_001,
    });
    expect(claims).toMatchObject({ actor: { id: "U_REQUESTER", personId: "per_requester" }, projects: ["back-office"], budget: 3, nonce: "Ev123" });
  });

  it("fails closed when writes are enabled without trusted authority", async () => {
    await expect(issueTaskWriteRequestContext(event, { ...runtime, RUNTIME_PLACEMENT_ID: undefined })).rejects.toThrow("task_write_not_configured");
  });

  it("acknowledges a scoped repair after refresh and rejects a cross-scope repair", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const good = { body: repair, ack: vi.fn(), retry: vi.fn() };
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T_UNSON",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_REPAIRS: { send: vi.fn() },
    };
    await consumeTaskBoardRepair(good, env, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    expect(good.ack).toHaveBeenCalledOnce();

    const rejected = { body: { ...repair, channelId: "C_OTHER" }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(rejected, env, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    expect(rejected.ack).toHaveBeenCalledOnce();
  });

  it("retries a failed repair and enqueues the scheduled scoped repair", async () => {
    const failed = { body: repair, ack: vi.fn(), retry: vi.fn() };
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T_UNSON",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_REPAIRS: { send },
    };
    await consumeTaskBoardRepair(failed, env, vi.fn().mockRejectedValue(new Error("boom")));
    expect(failed.retry).toHaveBeenCalledOnce();
    const tenantContext = {
      tenant: { tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      slack: { event_id: "task-board-repair:legacy-default:2026-08-13T01:00:00.000Z",
        channel_id: "C_BACK_OFFICE", thread_ts: "2026-08-13T01:00:00.000Z",
        requester_id: "service_task_board" },
    } as never;
    const resolveTenantContext = vi.fn(async () => tenantContext);
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T01:00:00.000Z", resolveTenantContext);
    expect(resolveTenantContext).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "legacy-default", channelId: "C_BACK_OFFICE",
    }));
    expect(send).toHaveBeenCalledWith({
      schema_version: "1.0",
      tenant_context: tenantContext,
      payload: { ...repair, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedAt: "2026-08-13T01:00:00.000Z" },
    });
  });

  it("enqueues and refreshes each task-board-enabled placement with only its own projects", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token", RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "accounting", channelId: "C_BACK_OFFICE", projectCodes: ["back-office"], taskBoardEnabled: true },
        { placementId: "dev", channelId: "C_DEV", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C_ROUTER", projectCodes: ["unson"] },
      ]), TASK_BOARD_REPAIRS: { send } };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T02:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ channelId: "C_DEV" }) }));

    const refresh = vi.fn().mockResolvedValue(undefined);
    const message = { body: { ...repair, targetId: "legacy-dev", channelId: "C_DEV" }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(message, env, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ SLACK_ALLOWED_CHANNEL_ID: "C_DEV", RUNTIME_PROJECT_CODES: "mana" }));
  });

  it("uses placement task-board flags even when the legacy global flag is off", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T_UNSON",
      SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      RUNTIME_TASK_BOARD_ENABLED: "false",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "dev", channelId: "C_DEV", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C_ROUTER", projectCodes: ["unson"], taskBoardEnabled: false },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };

    await enqueueScheduledTaskBoardRepair(env, "2026-08-14T00:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ channelId: "C_DEV" }) }));

    const refresh = vi.fn().mockResolvedValue(undefined);
    const message = { body: { ...repair, targetId: "legacy-dev", channelId: "C_DEV" }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(message, env, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      SLACK_ALLOWED_CHANNEL_ID: "C_DEV",
      RUNTIME_PROJECT_CODES: "mana",
    }));
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
    const tech = { body: { ...repair, targetId: "tech", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F" },
      ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(tech, env, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ SLACK_BOT_TOKEN: "tech-token",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKX9Y169F", RUNTIME_PROJECT_CODES: "proj_tech" }));
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
