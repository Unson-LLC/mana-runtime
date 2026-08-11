import { consumeTechKnightMessage } from "../queue-consumer.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvQueue123",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1786454600.000001",
    messageTs: "1786454653.386769",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> メンションしてみる",
    receivedAt: "2026-08-11T13:24:13.000Z",
    ...overrides,
  };
}

function message(body = event()) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("TechKnight queue consumer", () => {
  it("acknowledges a successfully processed event", async () => {
    const input = message();
    const process = vi.fn().mockResolvedValue({ outcome: "replied" });

    await consumeTechKnightMessage(input, {
      expectedWorkspaceId: "T_TECHKNIGHT",
      process,
    });

    expect(process).toHaveBeenCalledWith(input.body);
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.retry).not.toHaveBeenCalled();
  });

  it("retries a failed event without acknowledging it", async () => {
    const input = message();
    const process = vi.fn().mockRejectedValue(new Error("temporary failure"));

    await consumeTechKnightMessage(input, {
      expectedWorkspaceId: "T_TECHKNIGHT",
      process,
    });

    expect(input.ack).not.toHaveBeenCalled();
    expect(input.retry).toHaveBeenCalledOnce();
  });

  it.each([
    event({ tenantId: "other" as "techknight" }),
    event({ workspaceId: "T_OTHER" }),
    event({ channelId: "C_OTHER" }),
  ])("acknowledges an event outside the tenant boundary without processing it", async (body) => {
    const input = message(body);
    const process = vi.fn();

    await consumeTechKnightMessage(input, {
      expectedWorkspaceId: "T_TECHKNIGHT",
      expectedChannelId: "C_MANA_TEST",
      process,
    });

    expect(process).not.toHaveBeenCalled();
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.retry).not.toHaveBeenCalled();
  });

  it("processes a non-TechKnight tenant when it matches the deployed boundary", async () => {
    const input = message(event({
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
    }));
    const process = vi.fn().mockResolvedValue({ outcome: "replied" });

    await consumeTechKnightMessage(input, {
      expectedTenantId: "unson",
      expectedWorkspaceId: "T_UNSON",
      expectedChannelId: "C_BACK_OFFICE",
      process,
    });

    expect(process).toHaveBeenCalledWith(input.body);
    expect(input.ack).toHaveBeenCalledOnce();
    expect(input.retry).not.toHaveBeenCalled();
  });
});
