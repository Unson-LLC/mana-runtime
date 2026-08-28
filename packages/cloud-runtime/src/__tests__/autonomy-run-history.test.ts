import {
  claimAutonomyRun,
  completeAutonomyRun,
  failAutonomyRun,
  readAutonomyRun,
  readAutonomyRunProjection,
  type AutonomyRunHistoryNamespace,
} from "../autonomy-run-history.js";
import { TaskWriteBudget } from "../task-write-budget.js";

const NOW = Date.parse("2026-08-26T01:00:00Z");
const EXPIRES_AT = Date.parse("2026-08-27T00:00:00Z");
const EXPERIMENT_ID = "mana-autonomy-24h-v0";

function state() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    setAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
    transaction: vi.fn(async <T>(
      closure: (transaction: { get: typeof storage.get; put: typeof storage.put }) => Promise<T>,
    ) => closure(storage)),
  };
  const durable = new TaskWriteBudget(
    { storage } as unknown as ConstructorParameters<typeof TaskWriteBudget>[0],
  );
  const fetch = vi.fn((request: Request) => durable.fetch(request));
  const namespace: AutonomyRunHistoryNamespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch })),
  };
  return { namespace, values, durable };
}

function claim(runId: string, startedAt: number) {
  return {
    runId,
    experimentId: EXPERIMENT_ID,
    actorId: "mana_autonomy_v0",
    project: "brainbase-deployment",
    startedAt,
    experimentExpiresAt: EXPIRES_AT,
  };
}

describe("bounded autonomy run history", () => {
  it("keeps the latest 20 raw runs and folds older runs into an evidence checkpoint", async () => {
    const current = state();
    for (let index = 1; index <= 25; index += 1) {
      const runId = `run-${index}`;
      const startedAt = NOW + index * 60_000;
      await expect(claimAutonomyRun(current.namespace, claim(runId, startedAt))).resolves.toBe("claimed");
      await completeAutonomyRun(current.namespace, EXPERIMENT_ID, {
        runId,
        completedAt: startedAt + 1,
        outcomeCode: "autonomy_run_completed",
        evidence: [
          { kind: "task", id: `task-${index}` },
          { kind: "receipt", id: `receipt-${index}` },
        ],
      });
    }

    const projection = await readAutonomyRunProjection(current.namespace, EXPERIMENT_ID);
    expect(projection.untrustedHistoricalContext).toBe(true);
    expect(projection.recentRuns).toHaveLength(20);
    expect(projection.recentRuns[0]?.runId).toBe("run-6");
    expect(projection.recentRuns[19]?.runId).toBe("run-25");
    expect(projection.checkpoint).toMatchObject({
      compactedRunCount: 5,
      firstSequence: 1,
      lastSequence: 5,
      completedRuns: 5,
      failedRuns: 0,
      runIds: ["run-1", "run-2", "run-3", "run-4", "run-5"],
    });
    expect(projection.checkpoint?.evidence).toEqual(expect.arrayContaining([
      { kind: "task", id: "task-1" },
      { kind: "receipt", id: "receipt-5" },
    ]));

    await expect(readAutonomyRun(current.namespace, EXPERIMENT_ID, "run-1")).resolves.toMatchObject({
      runId: "run-1",
      sequence: 1,
      status: "completed",
      evidence: [
        { kind: "task", id: "task-1" },
        { kind: "receipt", id: "receipt-1" },
      ],
    });
  });

  it("rejects concurrent runs and closes a stale lease before admitting the next run", async () => {
    const current = state();
    await expect(claimAutonomyRun(current.namespace, claim("run-1", NOW))).resolves.toBe("claimed");
    await expect(claimAutonomyRun(
      current.namespace,
      claim("run-2", NOW + 60_000),
    )).resolves.toBe("busy");
    await expect(claimAutonomyRun(
      current.namespace,
      claim("run-2", NOW + 11 * 60_000),
    )).resolves.toBe("claimed");

    await expect(readAutonomyRun(current.namespace, EXPERIMENT_ID, "run-1")).resolves.toMatchObject({
      status: "failed",
      errorCode: "autonomy_run_stale",
      completedAt: NOW + 11 * 60_000,
    });
  });

  it("treats a completed run as an exact replay without duplicating the projection", async () => {
    const current = state();
    await claimAutonomyRun(current.namespace, claim("run-1", NOW));
    await completeAutonomyRun(current.namespace, EXPERIMENT_ID, {
      runId: "run-1",
      completedAt: NOW + 1,
    });
    await expect(claimAutonomyRun(current.namespace, claim("run-1", NOW))).resolves.toBe("replay");
    await completeAutonomyRun(current.namespace, EXPERIMENT_ID, {
      runId: "run-1",
      completedAt: NOW + 1,
    });

    const projection = await readAutonomyRunProjection(current.namespace, EXPERIMENT_ID);
    expect(projection.recentRuns).toHaveLength(1);
    expect(projection.recentRuns[0]?.runId).toBe("run-1");
  });

  it("stores bounded failure codes rather than exception text", async () => {
    const current = state();
    await claimAutonomyRun(current.namespace, claim("run-1", NOW));
    await failAutonomyRun(current.namespace, EXPERIMENT_ID, {
      runId: "run-1",
      completedAt: NOW + 1,
      errorCode: "autonomy_run_failed",
      evidence: [{ kind: "artifact", id: "diagnostic-safe-ref" }],
    });

    const record = await readAutonomyRun(current.namespace, EXPERIMENT_ID, "run-1");
    expect(record).toMatchObject({
      status: "failed",
      errorCode: "autonomy_run_failed",
      evidence: [{ kind: "artifact", id: "diagnostic-safe-ref" }],
    });
    expect(JSON.stringify(record)).not.toContain("Error");
  });

  it("removes all history when the experiment alarm expires", async () => {
    const current = state();
    await claimAutonomyRun(current.namespace, claim("run-1", NOW));
    await completeAutonomyRun(current.namespace, EXPERIMENT_ID, {
      runId: "run-1",
      completedAt: NOW + 1,
    });
    expect(current.values.size).toBeGreaterThan(0);
    await current.durable.alarm();
    expect(current.values.size).toBe(0);
  });
});
