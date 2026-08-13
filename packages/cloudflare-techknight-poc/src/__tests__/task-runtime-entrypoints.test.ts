import { verifyTaskWriteCapability } from "@openryoko/write-broker";
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
  tenantId: "unson-business",
  workspaceId: "T_UNSON",
  channelId: "C_BACK_OFFICE",
  reason: "scheduled" as const,
  requestedAt: "2026-08-13T00:00:00.000Z",
};

describe("Cloudflare task runtime entrypoints", () => {
  it("issues a requester, placement, and project scoped write capability", async () => {
    const result = await issueTaskWriteRequestContext(event, runtime, 1_000);
    expect(result.taskWriteEnabled).toBe(true);
    const claims = await verifyTaskWriteCapability(result.taskWriteCapability!, runtime.TASK_WRITE_CAPABILITY_SECRET, {
      requestId: "Ev123",
      workspace: "T_UNSON",
      placementId: "mana-accounting",
      now: 1_001,
    });
    expect(claims).toMatchObject({ projects: ["back-office"], budget: 3, nonce: "Ev123" });
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
      TASK_BOARD_REPAIRS: { send },
    };
    await consumeTaskBoardRepair(failed, env, vi.fn().mockRejectedValue(new Error("boom")));
    expect(failed.retry).toHaveBeenCalledOnce();
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T01:00:00.000Z");
    expect(send).toHaveBeenCalledWith({ ...repair, requestedAt: "2026-08-13T01:00:00.000Z" });
  });
});
