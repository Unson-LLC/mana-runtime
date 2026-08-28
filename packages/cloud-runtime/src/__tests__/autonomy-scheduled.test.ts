import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import { readAutonomyRun, type AutonomyRunHistoryNamespace } from "../autonomy-run-history.js";
import {
  runScheduledAutonomy,
  type AutonomyScheduledEnv,
  type AutonomyScheduledRun,
} from "../autonomy-scheduled.js";
import { TaskWriteBudget } from "../task-write-budget.js";

const SECRET = "autonomy-capability-secret-at-least-32-bytes";
const NOW = Date.parse("2026-08-26T01:00:00Z");
const EXPERIMENT_ID = "mana-autonomy-24h-v0";

function history() {
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
  return { namespace, values, fetch };
}

function env(
  namespace: AutonomyRunHistoryNamespace,
  overrides: Partial<AutonomyScheduledEnv> = {},
): AutonomyScheduledEnv {
  return {
    MANA_AUTONOMY_EXPERIMENT_JSON: JSON.stringify({
      id: EXPERIMENT_ID,
      actor_id: "mana_autonomy_v0",
      project: "brainbase-deployment",
      starts_at: "2026-08-26T00:00:00Z",
      expires_at: "2026-08-27T00:00:00Z",
      max_writes: 20,
    }),
    MANA_AUTONOMY_DISABLED: "false",
    TASK_WRITE_CAPABILITY_SECRET: SECRET,
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    TASK_WRITE_BUDGETS: namespace,
    ...overrides,
  };
}

function canonical() {
  return { graphHash: "sha256:canonical", taskVersion: 7 };
}

describe("scheduled autonomy bridge", () => {
  it("re-reads canonical state before issuing a bounded service capability", async () => {
    const current = history();
    const readCanonicalState = vi.fn(async () => canonical());
    const run = vi.fn(async (
      scheduled: AutonomyScheduledRun<ReturnType<typeof canonical>>,
    ) => {
      expect(scheduled.historicalContext).toMatchObject({
        untrustedHistoricalContext: true,
        checkpoint: null,
        recentRuns: [],
      });
      expect(scheduled.canonicalState).toEqual(canonical());
      const claims = await verifyTaskWriteCapability(scheduled.taskWriteCapability, SECRET, {
        requestId: scheduled.runId,
        workspace: "T_UNSON",
        placementId: "mana-autonomy",
        now: NOW,
      });
      expect(claims.actor).toEqual({
        provider: "service",
        id: "mana_autonomy_v0",
        workspace: "T_UNSON",
      });
      expect(claims.projects).toEqual(["brainbase-deployment"]);
      expect(claims.budget).toBe(2);
      expect(claims.expiresAt).toBe(NOW + 180_000);
      return {
        outcomeCode: "autonomy_run_completed",
        evidence: [
          { kind: "task" as const, id: "task-1" },
          { kind: "receipt" as const, id: "receipt-1" },
        ],
      };
    });

    await expect(runScheduledAutonomy({
      env: env(current.namespace),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState,
      run,
    })).resolves.toBe("ran");
    expect(readCanonicalState).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();

    const record = await readAutonomyRun(
      current.namespace,
      EXPERIMENT_ID,
      `${EXPERIMENT_ID}:${new Date(NOW).toISOString()}`,
    );
    expect(record).toMatchObject({
      status: "completed",
      outcomeCode: "autonomy_run_completed",
      evidence: [
        { kind: "task", id: "task-1" },
        { kind: "receipt", id: "receipt-1" },
      ],
    });
  });

  it("does nothing when the kill switch is active", async () => {
    const current = history();
    const run = vi.fn();
    const readCanonicalState = vi.fn(async () => canonical());
    await expect(runScheduledAutonomy({
      env: env(current.namespace, { MANA_AUTONOMY_DISABLED: "true" }),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState,
      run,
    })).resolves.toBe("disabled");
    expect(readCanonicalState).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(current.fetch).not.toHaveBeenCalled();
  });

  it("does nothing outside the experiment ttl", async () => {
    const current = history();
    const run = vi.fn();
    const readCanonicalState = vi.fn(async () => canonical());
    await expect(runScheduledAutonomy({
      env: env(current.namespace),
      config: { placementId: "mana-autonomy" },
      now: Date.parse("2026-08-27T00:00:00Z"),
      readCanonicalState,
      run,
    })).resolves.toBe("inactive");
    expect(readCanonicalState).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed if service execution credentials or history storage are missing", async () => {
    const current = history();
    await expect(runScheduledAutonomy({
      env: env(current.namespace, { TASK_WRITE_CAPABILITY_SECRET: undefined }),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState: vi.fn(async () => canonical()),
      run: vi.fn(),
    })).rejects.toThrow("autonomy_runtime_not_configured");

    await expect(runScheduledAutonomy({
      env: env(current.namespace, { TASK_WRITE_BUDGETS: undefined }),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState: vi.fn(async () => canonical()),
      run: vi.fn(),
    })).rejects.toThrow("autonomy_runtime_not_configured");
  });

  it("does not execute a completed scheduled delivery twice", async () => {
    const current = history();
    const bindings = env(current.namespace);
    const readCanonicalState = vi.fn(async () => canonical());
    const run = vi.fn(async () => undefined);
    const input = {
      env: bindings,
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState,
      run,
    };

    await expect(runScheduledAutonomy(input)).resolves.toBe("ran");
    await expect(runScheduledAutonomy(input)).resolves.toBe("replayed");
    expect(readCanonicalState).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows only one active operating loop for an experiment", async () => {
    const current = history();
    const bindings = env(current.namespace);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => {
      started?.();
      await blocked;
    });
    const first = runScheduledAutonomy({
      env: bindings,
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState: vi.fn(async () => canonical()),
      run,
    });
    await startedPromise;

    await expect(runScheduledAutonomy({
      env: bindings,
      config: { placementId: "mana-autonomy" },
      now: NOW + 60_000,
      readCanonicalState: vi.fn(async () => canonical()),
      run: vi.fn(),
    })).resolves.toBe("busy");

    release?.();
    await expect(first).resolves.toBe("ran");
  });

  it("re-reads canonical state on every distinct wake", async () => {
    const current = history();
    const bindings = env(current.namespace);
    const readCanonicalState = vi.fn(async () => canonical());

    for (const now of [NOW, NOW + 60_000]) {
      await expect(runScheduledAutonomy({
        env: bindings,
        config: { placementId: "mana-autonomy" },
        now,
        readCanonicalState,
        run: vi.fn(async () => undefined),
      })).resolves.toBe("ran");
    }
    expect(readCanonicalState).toHaveBeenCalledTimes(2);
  });

  it("persists only a generic failure code when execution throws", async () => {
    const current = history();
    const runId = `${EXPERIMENT_ID}:${new Date(NOW).toISOString()}`;
    await expect(runScheduledAutonomy({
      env: env(current.namespace),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      readCanonicalState: vi.fn(async () => canonical()),
      run: vi.fn(async () => {
        throw new Error("must-not-persist-secret");
      }),
    })).rejects.toThrow("must-not-persist-secret");

    const record = await readAutonomyRun(current.namespace, EXPERIMENT_ID, runId);
    expect(record).toMatchObject({
      status: "failed",
      errorCode: "autonomy_run_failed",
    });
    expect(JSON.stringify(record)).not.toContain("must-not-persist-secret");
  });
});
