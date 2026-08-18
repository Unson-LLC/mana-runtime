import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ackMalformedTenantQueueMessage } from "../queue-message-validation.js";

describe("queue malformed tenant context", () => {
  it.each([
    ["empty context", {}],
    ["missing tenant id", { tenant: {} }],
    ["empty tenant id", { tenant: { tenant_id: "" } }],
  ])("ACKs a canonical-shaped message with %s without retrying", async (_case, tenantContext) => {
    const message = {
      body: {
        schema_version: "1.0",
        tenant_context: tenantContext,
        payload: {
          eventType: "task_board_repair",
          tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          targetId: "task-board-1",
          workspaceId: "T-A",
          channelId: "C-A",
          requestedAt: "2026-08-18T00:00:00.000Z",
        },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(ackMalformedTenantQueueMessage(message, (entry) => console.error(JSON.stringify(entry))))
      .toBe(true);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(JSON.stringify({
      event: "tenant_queue_failed",
      code: "MALFORMED_TENANT_CONTEXT",
    }));
    logError.mockRestore();
  });

  it("runs malformed context rejection before any typed queue dispatch", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const queue = source.slice(source.indexOf("async queue("));
    expect(queue.indexOf("ackMalformedTenantQueueMessage(message"))
      .toBeLessThan(queue.indexOf("isTenantTaskBoardRepairBody(message.body)"));
  });
});
