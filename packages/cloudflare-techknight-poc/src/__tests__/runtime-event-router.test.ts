import { routeRuntimeEvent } from "../runtime-event-router.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvRoute123",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1786454600.000001",
    messageTs: "1786454653.386769",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> この議事録からタスクを登録して",
    receivedAt: "2026-08-11T13:24:13.000Z",
    ...overrides,
  };
}

describe("Cloudflare runtime event router", () => {
  it("routes an explicit meeting task request to the task pipeline", async () => {
    const processMeetingTask = vi.fn().mockResolvedValue({ outcome: "tasks_registered" });
    const processReply = vi.fn();

    await expect(routeRuntimeEvent(event(), {
      meetingTasksEnabled: true,
      processMeetingTask,
      processReply,
    })).resolves.toEqual({ outcome: "tasks_registered" });

    expect(processMeetingTask).toHaveBeenCalledOnce();
    expect(processReply).not.toHaveBeenCalled();
  });

  it("keeps an ordinary mention on the existing reply pipeline", async () => {
    const processMeetingTask = vi.fn();
    const processReply = vi.fn().mockResolvedValue({ outcome: "replied" });

    await expect(routeRuntimeEvent(event({ text: "<@U_BOT> こんにちは" }), {
      meetingTasksEnabled: true,
      processMeetingTask,
      processReply,
    })).resolves.toEqual({ outcome: "replied" });

    expect(processMeetingTask).not.toHaveBeenCalled();
    expect(processReply).toHaveBeenCalledOnce();
  });

  it("does not run either pipeline until the deployment owns meeting tasks", async () => {
    const processMeetingTask = vi.fn();
    const processReply = vi.fn();

    await expect(routeRuntimeEvent(event(), {
      meetingTasksEnabled: false,
      processMeetingTask,
      processReply,
    })).resolves.toEqual({ outcome: "ignored" });

    expect(processMeetingTask).not.toHaveBeenCalled();
    expect(processReply).not.toHaveBeenCalled();
  });
});
