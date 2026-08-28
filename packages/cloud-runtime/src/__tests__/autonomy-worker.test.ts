import { afterEach, describe, expect, it, vi } from "vitest";

type AutonomyOutcome = "inactive" | "disabled" | "busy" | "replayed" | "ran";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response("ok")),
  queue: vi.fn(async () => undefined),
  scheduled: vi.fn(async () => undefined),
  runAutonomy: vi.fn(async (): Promise<AutonomyOutcome> => "inactive"),
}));

vi.mock("../index.js", () => ({
  default: {
    fetch: mocks.fetch,
    queue: mocks.queue,
    scheduled: mocks.scheduled,
  },
}));

vi.mock("../autonomy-entrypoint.js", () => ({
  runAutonomyScheduledEntrypoint: mocks.runAutonomy,
}));

import worker from "../autonomy-worker.js";

function controller(cron: string) {
  return {
    cron,
    scheduledTime: Date.parse("2026-08-26T01:00:00Z"),
    type: "scheduled",
    noRetry: vi.fn(),
  } as never;
}

function env(cron = "*/15 * * * *") {
  return { MANA_AUTONOMY_CRON: cron } as never;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.runAutonomy.mockResolvedValue("inactive");
});

describe("autonomy worker wrapper", () => {
  it("always preserves the existing scheduled handler and ignores unrelated crons", async () => {
    await worker.scheduled(controller("0 0 * * 1-5"), env());

    expect(mocks.scheduled).toHaveBeenCalledOnce();
    expect(mocks.runAutonomy).not.toHaveBeenCalled();
  });

  it("runs autonomy once only on the explicitly configured cron", async () => {
    mocks.runAutonomy.mockResolvedValue("disabled");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await worker.scheduled(controller("*/15 * * * *"), env());

    expect(mocks.scheduled).toHaveBeenCalledOnce();
    expect(mocks.runAutonomy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: "mana_autonomy_scheduled",
      outcome: "disabled",
      cron: "*/15 * * * *",
      scheduledTime: Date.parse("2026-08-26T01:00:00Z"),
    }));
  });

  it("fails closed with a generic code and never logs the raw autonomy error", async () => {
    mocks.runAutonomy.mockRejectedValue(new Error("must-not-log-secret"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(worker.scheduled(controller("*/15 * * * *"), env()))
      .rejects.toThrow("autonomy_scheduled_failed");

    expect(error).toHaveBeenCalledOnce();
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain("autonomy_scheduled_failed");
    expect(logged).not.toContain("must-not-log-secret");
  });

  it("keeps autonomy inactive when the cron binding is missing or malformed", async () => {
    await worker.scheduled(controller("*/15 * * * *"), env(""));
    await worker.scheduled(controller("*/15 * * * *"), env("bad\ncron"));

    expect(mocks.scheduled).toHaveBeenCalledTimes(2);
    expect(mocks.runAutonomy).not.toHaveBeenCalled();
  });
});
