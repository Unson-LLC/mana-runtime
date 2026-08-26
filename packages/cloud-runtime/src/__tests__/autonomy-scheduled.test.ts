import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import { runScheduledAutonomy } from "../autonomy-scheduled.js";

const SECRET = "autonomy-capability-secret-at-least-32-bytes";
const NOW = Date.parse("2026-08-26T01:00:00Z");

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MANA_AUTONOMY_EXPERIMENT_JSON: JSON.stringify({
      id: "mana-autonomy-24h-v0",
      actor_id: "mana_autonomy_v0",
      project: "brainbase-deployment",
      starts_at: "2026-08-26T00:00:00Z",
      expires_at: "2026-08-27T00:00:00Z",
      max_writes: 20,
    }),
    MANA_AUTONOMY_DISABLED: "false",
    TASK_WRITE_CAPABILITY_SECRET: SECRET,
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    ...overrides,
  };
}

describe("scheduled autonomy bridge", () => {
  it("runs as the service actor with a project-bounded short-lived capability", async () => {
    const run = vi.fn(async (scheduled) => {
      const claims = await verifyTaskWriteCapability(scheduled.taskWriteCapability, SECRET, {
        requestId: scheduled.runId,
        workspace: "T_UNSON",
        placementId: "mana-autonomy",
        now: NOW,
      });
      expect(claims.actor).toEqual({ provider: "service", id: "mana_autonomy_v0", workspace: "T_UNSON" });
      expect(claims.projects).toEqual(["brainbase-deployment"]);
      expect(claims.budget).toBe(2);
      expect(claims.expiresAt).toBe(NOW + 180_000);
    });

    await expect(runScheduledAutonomy({
      env: env(),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      run,
    })).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
  });

  it("does nothing when the kill switch is active", async () => {
    const run = vi.fn();
    await expect(runScheduledAutonomy({
      env: env({ MANA_AUTONOMY_DISABLED: "true" }),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      run,
    })).resolves.toBe("disabled");
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing outside the experiment ttl", async () => {
    const run = vi.fn();
    await expect(runScheduledAutonomy({
      env: env(),
      config: { placementId: "mana-autonomy" },
      now: Date.parse("2026-08-27T00:00:00Z"),
      run,
    })).resolves.toBe("inactive");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed if service execution credentials are missing", async () => {
    await expect(runScheduledAutonomy({
      env: env({ TASK_WRITE_CAPABILITY_SECRET: undefined }),
      config: { placementId: "mana-autonomy" },
      now: NOW,
      run: vi.fn(),
    })).rejects.toThrow("autonomy_runtime_not_configured");
  });
});
