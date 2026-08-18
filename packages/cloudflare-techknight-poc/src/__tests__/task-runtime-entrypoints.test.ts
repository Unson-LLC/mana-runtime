import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import type { TaskBoardRepairEvent } from "../task-board.js";
import {
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
  processTaskBoardRepair,
  taskBoardTargets,
} from "../task-runtime-entrypoints.js";

const event = {
  eventId: "Ev123", tenantId: "unson-business", workspaceId: "T0882T8N9UH",
  channelId: "C0BKS6RL99T", threadTs: "1.2", userId: "U_REQUESTER",
} as never;

const runtime = {
  RUNTIME_TASK_WRITE_ENABLED: "true",
  TASK_WRITE_CAPABILITY_SECRET: "write-capability-secret-at-least-32-bytes",
  RUNTIME_PLACEMENT_ID: "mana-accounting",
  RUNTIME_PROJECT_CODES: "back-office",
};

const repair = {
  eventType: "task_board_repair" as const, targetId: "business", tenantId: "unson-business",
  workspaceId: "T0882T8N9UH", channelId: "C0BKS6RL99T", manaCanvasId: "FBUSINESS",
  bindingRevision: 1, reason: "scheduled" as const, requestedAt: "2026-08-13T00:00:00.000Z",
};

const businessTarget = {
  targetId: "business", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
  channelId: "C0BKS6RL99T", projectCodes: ["back-office"], enabled: true,
  manaCanvasId: "FBUSINESS", bindingRevision: 1,
};

const devTarget = {
  targetId: "dev", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
  channelId: "C0DEV123456", projectCodes: ["mana"], enabled: true,
  manaCanvasId: "FDEV123456", bindingRevision: 1,
};

const ownedRepair = {
  eventType: "task_board_repair" as const, targetId: "owned-default", tenantId: "unson-business",
  workspaceId: "TUNSON", channelId: "CBACKOFFICE", manaCanvasId: "FOWNED",
  bindingRevision: 1, reason: "scheduled" as const, requestedAt: "2026-08-13T00:00:00.000Z",
};

const ownedTarget = {
  targetId: "owned-default", organizationId: "unson-business", workspaceId: "TUNSON",
  channelId: "CBACKOFFICE", projectCodes: ["back-office"], enabled: true,
  manaCanvasId: "FOWNED", bindingRevision: 1,
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
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "accounting", channelId: "C_BACK_OFFICE", projectCodes: ["back-office"], taskBoardEnabled: true },
        { placementId: "dev", channelId: "C_DEV", projectCodes: ["mana"], taskBoardEnabled: true },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };
    expect(() => taskBoardTargets(env)).toThrow("task_board_targets_required");
    await expect(enqueueScheduledTaskBoardRepair(env, "2026-08-17T00:00:00.000Z", resolveTaskBoardTenant))
      .rejects.toThrow("task_board_targets_required");
    expect(send).not.toHaveBeenCalled();
  });

  it("issues a requester, placement, and project scoped write capability", async () => {
    const result = await issueTaskWriteRequestContext(event, runtime, 1_000, undefined, "per_requester");
    expect(result.taskWriteEnabled).toBe(true);
    const claims = await verifyTaskWriteCapability(result.taskWriteCapability!, runtime.TASK_WRITE_CAPABILITY_SECRET, {
      requestId: "Ev123", workspace: "T0882T8N9UH", placementId: "mana-accounting", now: 1_001,
    });
    expect(claims).toMatchObject({ actor: { id: "U_REQUESTER", personId: "per_requester" },
      projects: ["back-office"], budget: 3, nonce: "Ev123" });
  });

  it("fails closed when writes are enabled without trusted authority", async () => {
    await expect(issueTaskWriteRequestContext(event, { ...runtime, RUNTIME_PLACEMENT_ID: undefined }))
      .rejects.toThrow("task_write_not_configured");
  });

  it("processes a canonical scoped repair and rejects a cross-scope repair", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH", SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      SLACK_BOT_TOKEN: "unson-token", RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget]), TASK_BOARD_REPAIRS: { send: vi.fn() },
    };
    await processTaskBoardRepair(repair, env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    await expect(processTaskBoardRepair({ ...repair, channelId: "C_OTHER" }, env,
      "unson-business", fetch, refresh)).rejects.toThrow("task_board_scope_mismatch");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("rejects a stale Canvas binding snapshot without writing to Slack", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token", TASK_BOARD_TARGETS_JSON: JSON.stringify([ownedTarget]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
    };
    await expect(processTaskBoardRepair({ ...ownedRepair, manaCanvasId: "FOLD", bindingRevision: 0 }, env,
      "unson-business", fetch, refresh)).rejects.toThrow("task_board_scope_mismatch");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("story-task-canvas-ownership:ac:4 rejects untrusted auto-provision coordinates without writing to Slack", async () => {
    const createCanvas = vi.fn().mockResolvedValue("FMANA");
    const refresh = vi.fn().mockResolvedValue(undefined);
    const target = { ...ownedTarget, autoProvision: true, manaCanvasId: null, bindingRevision: 1 };
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token", TASK_BOARD_TARGETS_JSON: JSON.stringify([target]),
      TASK_BOARD_REPAIRS: { send: vi.fn() }, TASK_BOARD_BINDINGS: { idFromName: vi.fn(), get: vi.fn() },
    };
    await expect(processTaskBoardRepair({ ...ownedRepair, channelId: "C_OTHER", manaCanvasId: null }, env,
      "unson-business", fetch, refresh, createCanvas)).rejects.toThrow("task_board_scope_mismatch");
    expect(createCanvas).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("provisions and persists the trusted channel Canvas before the first refresh", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const createCanvas = vi.fn().mockResolvedValue("FMANA");
    const bindingFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/reserve") return Response.json({ status: "reserved" });
      if (path === "/complete") return new Response(null, { status: 204 });
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    const target = { ...ownedTarget, autoProvision: true, manaCanvasId: null, bindingRevision: 1 };
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token", TASK_BOARD_TARGETS_JSON: JSON.stringify([target]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
      TASK_BOARD_BINDINGS: { idFromName: vi.fn((name) => name), get: vi.fn(() => ({ fetch: bindingFetch })) },
    };
    await processTaskBoardRepair({ ...ownedRepair, manaCanvasId: null }, env,
      "unson-business", fetch, refresh, createCanvas);
    expect(createCanvas).toHaveBeenCalledWith("CBACKOFFICE", undefined, { fetch });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE", SLACK_BOT_TOKEN: undefined, TASK_BOARD_CANVAS_ID: "FMANA",
    }), { fetch });
    expect(bindingFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed canonical repair and enqueues the scheduled scoped repair", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH", SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget]), TASK_BOARD_REPAIRS: { send },
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
      targetId: "business", channelId: "C0BKS6RL99T", manaCanvasId: "FBUSINESS", bindingRevision: 1,
    }));
    expect(send).toHaveBeenCalledWith({ schema_version: "1.0", tenant_context: tenantContext,
      payload: { ...repair, tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedAt: "2026-08-13T01:00:00.000Z" } });
  });

  it("enqueues and refreshes each canonical target with only its own projects", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH", SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "accounting", channelId: "C0BKS6RL99T", projectCodes: ["back-office"], taskBoardEnabled: true },
        { placementId: "dev", channelId: "C0DEV123456", projectCodes: ["mana"], taskBoardEnabled: true },
      ]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([businessTarget, devTarget]), TASK_BOARD_REPAIRS: { send },
    };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T02:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
      channelId: "C0DEV123456", manaCanvasId: "FDEV123456",
    }) }));
    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "dev", channelId: "C0DEV123456",
      manaCanvasId: "FDEV123456" }, env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      SLACK_ALLOWED_CHANNEL_ID: "C0DEV123456", TASK_BOARD_CANVAS_ID: "FDEV123456", RUNTIME_PROJECT_CODES: "mana",
    }), { fetch });
  });

  it("uses canonical targets even when the legacy global flag is off", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH", SLACK_ALLOWED_CHANNEL_ID: "C0LEGACY123",
      RUNTIME_TASK_BOARD_ENABLED: "false", SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "dev", channelId: "C0DEV123456", projectCodes: ["mana"], taskBoardEnabled: true },
      ]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([devTarget]), TASK_BOARD_REPAIRS: { send },
    };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-14T00:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(1);
    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "dev", channelId: "C0DEV123456",
      manaCanvasId: "FDEV123456" }, env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_ALLOWED_CHANNEL_ID: "C0DEV123456", RUNTIME_PROJECT_CODES: "mana",
    }), { fetch });
  });

  it("enqueues only enabled bound targets and processes a target without forwarding static credentials", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const targets = [
      { targetId: "unson", organizationId: "unson", workspaceId: "T07LL5WV7N1", channelId: "C0BKXCVSDCH",
        projectCodes: ["proj_unson"], enabled: true, manaCanvasId: "FUNSON", bindingRevision: 1 },
      { targetId: "tech", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
        projectCodes: ["proj_tech"], enabled: true, manaCanvasId: "FTECH", bindingRevision: 2 },
      { targetId: "disabled", organizationId: "unson-business", workspaceId: "T0882T8N9UH", channelId: "C0BKS6RL99T",
        projectCodes: ["back-office"], enabled: false, manaCanvasId: null, bindingRevision: null },
    ];
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token",
      SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token", TASK_BOARD_TARGETS_JSON: JSON.stringify(targets),
      TASK_BOARD_REPAIRS: { send },
    };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-15T00:00:00.000Z", resolveTaskBoardTenant);
    expect(send).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(JSON.stringify({
      event: "task_board_repair_suppressed", targetId: "disabled", reason: "target_disabled",
    }));
    const refresh = vi.fn().mockResolvedValue(undefined);
    await processTaskBoardRepair({ ...repair, targetId: "tech", workspaceId: "T07A9J3PEMB",
      channelId: "C0BKX9Y169F", manaCanvasId: "FTECH", bindingRevision: 2 },
    env, "unson-business", fetch, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      SLACK_BOT_TOKEN: undefined, BRAINBASE_TASK_API_TOKEN: undefined,
      SLACK_ALLOWED_CHANNEL_ID: "C0BKX9Y169F", TASK_BOARD_CANVAS_ID: "FTECH", RUNTIME_PROJECT_CODES: "proj_tech",
    }), { fetch });
    info.mockRestore();
  });

  it("reports a partial scheduled fanout failure after attempting every trusted target", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("queue unavailable")).mockResolvedValueOnce(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "T_UNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token", SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([
        { targetId: "unson", organizationId: "unson", workspaceId: "T07LL5WV7N1", channelId: "C0BKXCVSDCH",
          projectCodes: ["proj_unson"], enabled: true, manaCanvasId: "FUNSON", bindingRevision: 1 },
        { targetId: "tech", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
          projectCodes: ["proj_tech"], enabled: true, manaCanvasId: "FTECH", bindingRevision: 1 },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };
    await expect(enqueueScheduledTaskBoardRepair(env, "2026-08-15T01:00:00.000Z", resolveTaskBoardTenant))
      .rejects.toThrow("task_board_schedule_enqueue_failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
