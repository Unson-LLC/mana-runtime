import { verifyTaskWriteCapability } from "@openryoko/write-broker";
import { issueAutonomyTaskWriteCapability } from "../autonomy-task-write.js";

const SECRET = "autonomy-capability-secret-at-least-32-bytes";

describe("autonomy task write capability", () => {
  it("issues a create-only service capability bounded to one project and the experiment ttl", async () => {
    const now = 1_800_000_000_000;
    const token = await issueAutonomyTaskWriteCapability({
      runId: "run-1",
      secret: SECRET,
      now,
      config: {
        actorId: "mana_autonomy_v0",
        workspaceId: "T_UNSON",
        placementId: "mana-autonomy",
        project: "brainbase",
        experimentExpiresAt: now + 60_000,
        perRunBudget: 2,
      },
    });
    const claims = await verifyTaskWriteCapability(token, SECRET, {
      requestId: "run-1",
      workspace: "T_UNSON",
      placementId: "mana-autonomy",
      now,
    });
    expect(claims.actor).toEqual({ provider: "service", id: "mana_autonomy_v0", workspace: "T_UNSON" });
    expect(claims.projects).toEqual(["brainbase"]);
    expect(claims.operations).toEqual(["task.create"]);
    expect(claims.budget).toBe(2);
    expect(claims.expiresAt).toBe(now + 60_000);
  });

  it("fails closed when the experiment is already expired", async () => {
    await expect(issueAutonomyTaskWriteCapability({
      runId: "run-2",
      secret: SECRET,
      now: 1_800_000_000_000,
      config: {
        actorId: "mana_autonomy_v0",
        workspaceId: "T_UNSON",
        placementId: "mana-autonomy",
        project: "brainbase",
        experimentExpiresAt: 1_799_999_999_999,
      },
    })).rejects.toThrow("autonomy_task_write_not_configured");
  });
});
