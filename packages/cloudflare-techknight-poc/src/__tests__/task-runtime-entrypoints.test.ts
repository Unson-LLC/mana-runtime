import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import {
  consumeTaskBoardRepair,
  enqueueScheduledTaskBoardRepair,
  issueTaskWriteRequestContext,
} from "../task-runtime-entrypoints.js";

const event = {
  eventId: "Ev123",
  tenantId: "unson-business",
  workspaceId: "TUNSON",
  channelId: "CBACKOFFICE",
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
  targetId: "owned-default",
  tenantId: "unson-business",
  workspaceId: "TUNSON",
  channelId: "CBACKOFFICE",
  manaCanvasId: "FOWNED",
  bindingRevision: 1,
  reason: "scheduled" as const,
  requestedAt: "2026-08-13T00:00:00.000Z",
};

describe("Cloudflare task runtime entrypoints", () => {
  const ownedTarget = { targetId: "owned-default", organizationId: "unson-business", workspaceId: "TUNSON",
    channelId: "CBACKOFFICE", projectCodes: ["back-office"], enabled: true,
    manaCanvasId: "FOWNED", bindingRevision: 1 };
  it("issues a requester, placement, and project scoped write capability", async () => {
    const result = await issueTaskWriteRequestContext(event, runtime, 1_000, undefined, "per_requester");
    expect(result.taskWriteEnabled).toBe(true);
    const claims = await verifyTaskWriteCapability(result.taskWriteCapability!, runtime.TASK_WRITE_CAPABILITY_SECRET, {
      requestId: "Ev123",
      workspace: "TUNSON",
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
      SLACK_EXPECTED_TEAM_ID: "TUNSON",
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([ownedTarget]),
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

  it("rejects a stale Canvas binding snapshot without writing to Slack", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stale = { body: { ...repair, manaCanvasId: "FOLD", bindingRevision: 0 }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(stale, {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token", TASK_BOARD_TARGETS_JSON: JSON.stringify([ownedTarget]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
    }, refresh);
    expect(refresh).not.toHaveBeenCalled();
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(stale.retry).not.toHaveBeenCalled();
  });

  it("story-task-canvas-ownership:ac:4 rejects untrusted auto-provision coordinates without writing to Slack", async () => {
    const createCanvas = vi.fn().mockResolvedValue("FMANA");
    const refresh = vi.fn().mockResolvedValue(undefined);
    const target = {
      ...ownedTarget,
      autoProvision: true,
      manaCanvasId: null,
      bindingRevision: 1,
    };
    const message = {
      body: { ...repair, channelId: "C_OTHER", manaCanvasId: null },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeTaskBoardRepair(message, {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "TUNSON",
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([target]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
      TASK_BOARD_BINDINGS: { idFromName: vi.fn(), get: vi.fn() },
    }, refresh, createCanvas);
    expect(createCanvas).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
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
    const message = {
      body: { ...repair, manaCanvasId: null, bindingRevision: 1 },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await consumeTaskBoardRepair(message, {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "TUNSON",
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([target]),
      TASK_BOARD_REPAIRS: { send: vi.fn() },
      TASK_BOARD_BINDINGS: {
        idFromName: vi.fn((name) => name),
        get: vi.fn(() => ({ fetch: bindingFetch })),
      },
    }, refresh, createCanvas);

    expect(createCanvas).toHaveBeenCalledWith("CBACKOFFICE", "unson-token");
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      TASK_BOARD_CANVAS_ID: "FMANA",
    }));
    expect(bindingFetch).toHaveBeenCalledTimes(2);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });


  it("retries a failed repair and enqueues the scheduled scoped repair", async () => {
    const failed = { body: repair, ack: vi.fn(), retry: vi.fn() };
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "TUNSON",
      SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([ownedTarget]),
      SLACK_BOT_TOKEN: "unson-token",
      TASK_BOARD_REPAIRS: { send },
    };
    await consumeTaskBoardRepair(failed, env, vi.fn().mockRejectedValue(new Error("boom")));
    expect(failed.retry).toHaveBeenCalledOnce();
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T01:00:00.000Z");
    expect(send).toHaveBeenCalledWith({ ...repair, requestedAt: "2026-08-13T01:00:00.000Z" });
  });

  it("does not enqueue or consume legacy placement boards without Canvas ownership", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "CBACKOFFICE",
      RUNTIME_TASK_BOARD_ENABLED: "true", SLACK_BOT_TOKEN: "unson-token", RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "accounting", channelId: "CBACKOFFICE", projectCodes: ["back-office"], taskBoardEnabled: true },
        { placementId: "dev", channelId: "C_DEV", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C_ROUTER", projectCodes: ["unson"] },
      ]), TASK_BOARD_REPAIRS: { send } };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-13T02:00:00.000Z");
    expect(send).not.toHaveBeenCalled();

    const refresh = vi.fn().mockResolvedValue(undefined);
    const message = { body: { ...repair, targetId: "legacy-dev", channelId: "C_DEV" }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(message, env, refresh);
    expect(refresh).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("keeps legacy placement boards disabled even when their old flag is on", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "TUNSON",
      SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      RUNTIME_TASK_BOARD_ENABLED: "false",
      SLACK_BOT_TOKEN: "unson-token",
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([
        { placementId: "dev", channelId: "C_DEV", projectCodes: ["mana"], taskBoardEnabled: true },
        { placementId: "router", channelId: "C_ROUTER", projectCodes: ["unson"], taskBoardEnabled: false },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };

    await enqueueScheduledTaskBoardRepair(env, "2026-08-14T00:00:00.000Z");
    expect(send).not.toHaveBeenCalled();

    const refresh = vi.fn().mockResolvedValue(undefined);
    const message = { body: { ...repair, targetId: "legacy-dev", channelId: "C_DEV" }, ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(message, env, refresh);
    expect(refresh).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("enqueues and consumes only enabled bound targets", async () => {
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
    const env = { TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token", SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify(targets), TASK_BOARD_REPAIRS: { send } };
    await enqueueScheduledTaskBoardRepair(env, "2026-08-15T00:00:00.000Z");
    expect(send).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ event: "task_board_repair_suppressed",
      targetId: "disabled", reason: "target_disabled" }));

    const refresh = vi.fn().mockResolvedValue(undefined);
    const tech = { body: { ...repair, targetId: "tech", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
        manaCanvasId: "FTECH", bindingRevision: 2 },
      ack: vi.fn(), retry: vi.fn() };
    await consumeTaskBoardRepair(tech, env, refresh);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ SLACK_BOT_TOKEN: "tech-token",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKX9Y169F", TASK_BOARD_CANVAS_ID: "FTECH", RUNTIME_PROJECT_CODES: "proj_tech" }));
    info.mockRestore();
  });

  it("reports a partial scheduled fanout failure after attempting every trusted target", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const env = {
      TENANT_ID: "unson-business", SLACK_EXPECTED_TEAM_ID: "TUNSON", SLACK_ALLOWED_CHANNEL_ID: "C_LEGACY",
      SLACK_BOT_TOKEN: "business-token", SLACK_BOT_TOKEN_UNSON: "unson-token", SLACK_BOT_TOKEN_TECHKNIGHT: "tech-token",
      TASK_BOARD_TARGETS_JSON: JSON.stringify([
        { targetId: "unson", organizationId: "unson", workspaceId: "T07LL5WV7N1", channelId: "C0BKXCVSDCH",
          projectCodes: ["proj_unson"], enabled: true, manaCanvasId: "FUNSON", bindingRevision: 1 },
        { targetId: "tech", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB", channelId: "C0BKX9Y169F",
          projectCodes: ["proj_tech"], enabled: true, manaCanvasId: "FTECH", bindingRevision: 1 },
      ]),
      TASK_BOARD_REPAIRS: { send },
    };
    await expect(enqueueScheduledTaskBoardRepair(env, "2026-08-15T01:00:00.000Z"))
      .rejects.toThrow("task_board_schedule_enqueue_failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
