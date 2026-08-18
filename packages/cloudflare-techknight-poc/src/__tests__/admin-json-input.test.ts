import { describe, expect, it, vi } from "vitest";

import {
  MAX_ADMIN_JSON_BODY_BYTES,
  MAX_MEETING_MINUTES_ADMIN_TASK_IDS,
  readAdminJsonRequest,
  validateMeetingMinutesAdminTaskIds,
} from "../admin-json-input.js";
import { handleMeetingMinutesIntakeAdminRequest } from "../meeting-minutes-intake-entrypoints.js";

describe("admin JSON input bounds", () => {
  it("rejects an oversized declared intake body without mutating durable state", async () => {
    const setPaused = vi.fn();
    const status = vi.fn();
    const response = await handleMeetingMinutesIntakeAdminRequest(new Request(
      "https://worker.example/admin/meeting-minutes/intake",
      {
        method: "POST",
        headers: { "content-length": String(MAX_ADMIN_JSON_BODY_BYTES + 1) },
        body: JSON.stringify({ paused: true }),
      },
    ), { authorize: vi.fn().mockResolvedValue(true), setPaused, status });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "admin_json_body_too_large" });
    expect(setPaused).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("rejects a streamed body that exceeds the limit when content-length is absent", async () => {
    const bytes = new TextEncoder().encode(`{"value":"${"x".repeat(MAX_ADMIN_JSON_BODY_BYTES)}"}`);
    const request = new Request("https://worker.example/admin", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 1024));
          controller.enqueue(bytes.subarray(1024));
          controller.close();
        },
      }),
      // Node requires duplex for a streamed request body, but Cloudflare's Request type does not expose it.
      ...( { duplex: "half" } as RequestInit ),
    });

    await expect(readAdminJsonRequest(request)).rejects.toMatchObject({ code: "admin_json_body_too_large" });
  });

  it("caps task adoption fan-out and each task identifier length", () => {
    expect(validateMeetingMinutesAdminTaskIds({
      taskIds: Array.from({ length: MAX_MEETING_MINUTES_ADMIN_TASK_IDS + 1 }, (_, index) => `task-${index}`),
    })).toBeUndefined();
    expect(validateMeetingMinutesAdminTaskIds({ taskIds: [`task-${"x".repeat(509)}`] })).toBeUndefined();
    expect(validateMeetingMinutesAdminTaskIds({ taskIds: ["task-1", "task-1", "task-2"] }))
      .toEqual(["task-1", "task-2"]);
  });
});
