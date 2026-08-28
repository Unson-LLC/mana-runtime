import { parseAutonomyExperiment } from "../autonomy-experiment.js";

const NOW = Date.parse("2026-08-26T01:00:00Z");

function contract(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "mana-autonomy-24h-v0",
    actor_id: "mana_autonomy_v0",
    project: "brainbase-deployment",
    starts_at: "2026-08-26T00:00:00Z",
    expires_at: "2026-08-27T00:00:00Z",
    max_writes: 20,
    ...overrides,
  });
}

describe("autonomy experiment contract", () => {
  it("loads one active bounded experiment", () => {
    expect(parseAutonomyExperiment(contract(), "false", NOW)).toMatchObject({
      id: "mana-autonomy-24h-v0",
      actorId: "mana_autonomy_v0",
      project: "brainbase-deployment",
      maxWrites: 20,
      disabled: false,
    });
  });

  it("propagates the external kill switch", () => {
    expect(parseAutonomyExperiment(contract(), "true", NOW)?.disabled).toBe(true);
  });

  it("does not run before start or after hard ttl", () => {
    expect(parseAutonomyExperiment(contract(), "false", Date.parse("2026-08-25T23:59:59Z"))).toBeNull();
    expect(parseAutonomyExperiment(contract(), "false", Date.parse("2026-08-27T00:00:00Z"))).toBeNull();
  });

  it("rejects experiments longer than 24 hours", () => {
    expect(() => parseAutonomyExperiment(contract({ expires_at: "2026-08-27T00:00:01Z" }), "false", NOW))
      .toThrow("autonomy_experiment_invalid");
  });

  it("rejects malformed or unbounded write budgets", () => {
    expect(() => parseAutonomyExperiment("{", "false", NOW)).toThrow("autonomy_experiment_invalid");
    expect(() => parseAutonomyExperiment(contract({ max_writes: 0 }), "false", NOW))
      .toThrow("autonomy_experiment_invalid");
    expect(() => parseAutonomyExperiment(contract({ max_writes: 101 }), "false", NOW))
      .toThrow("autonomy_experiment_invalid");
  });
});
