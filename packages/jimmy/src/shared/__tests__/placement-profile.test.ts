import { describe, expect, it } from "vitest";
import { isPlacementEmployeeAllowed, resolvePlacement } from "../placement-profile.js";
import type { PlacementProfile } from "../types.js";

const placement: PlacementProfile = {
  id: "mana-test",
  connector: "slack",
  workspaceId: "T1",
  channelId: "C1",
  audience: { type: "project-team", allowedUsers: ["U1"] },
};

const message = (overrides: Record<string, unknown> = {}) => ({
  connector: "slack",
  channel: "C1",
  user: "U1",
  transportMeta: { team: "T1" },
  ...overrides,
}) as any;

describe("resolvePlacement", () => {
  it("preserves legacy routing when no placements are configured", () => {
    expect(resolvePlacement(undefined, message()).status).toBe("legacy");
  });

  it("matches an exact workspace, channel, and user", () => {
    expect(resolvePlacement([placement], message())).toMatchObject({ status: "matched", placement });
  });

  it.each([
    ["unmatched channel", message({ channel: "C2" }), "unmatched"],
    ["wrong workspace", message({ transportMeta: { team: "T2" } }), "unmatched"],
    ["unauthorized user", message({ user: "U2" }), "unauthorized_user"],
  ])("fails closed for %s", (_name, msg, reason) => {
    expect(resolvePlacement([placement], msg)).toEqual({ status: "denied", reason });
  });

  it("denies ambiguous matching profiles", () => {
    expect(resolvePlacement([placement, { ...placement, id: "duplicate" }], message()))
      .toEqual({ status: "denied", reason: "ambiguous" });
  });

  it("fails closed when a placement data scope contains a secret-like value", () => {
    const unsafe = { ...placement, dataScopes: { apiKey: "sk-canary-never-render" } };
    expect(resolvePlacement([unsafe], message())).toEqual({ status: "denied", reason: "invalid_config" });
  });
});

describe("isPlacementEmployeeAllowed", () => {
  const delegated = {
    ...placement,
    agent: { employee: "ryoko", escalationEmployee: "critical-reviewer" },
  };

  it("allows only the primary and escalation employees", () => {
    expect(isPlacementEmployeeAllowed(delegated, "ryoko")).toBe(true);
    expect(isPlacementEmployeeAllowed(delegated, "critical-reviewer")).toBe(true);
    expect(isPlacementEmployeeAllowed(delegated, "unscoped-employee")).toBe(false);
  });
});
