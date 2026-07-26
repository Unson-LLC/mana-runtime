import { describe, expect, it, vi } from "vitest";
import { isPlacementEmployeeAllowed, placementEngineBoundary, placementSafeCliFlags, resolvePlacement, runPlacementBoundEngine } from "../placement-profile.js";
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

  it.each([
    ["camelCase access token", { dataScopes: { accessToken: "canary-plain-value" } }],
    ["camelCase client secret", { dataScopes: { clientSecret: "canary-plain-value" } }],
    ["secret-like project", { projects: ["sk-canary-never-render"] }],
    ["secret-like id", { id: "sk-canary-never-render" }],
  ])("fails closed for a %s anywhere in the placement", (_label, override) => {
    const unsafe = { ...placement, ...override } as PlacementProfile;
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

describe("placementEngineBoundary", () => {
  it("enforces strict MCP and disables Chrome for every placement execution", () => {
    expect(placementEngineBoundary(placement)).toEqual({
      strictMcpConfig: true,
      enableChrome: false,
    });
  });

  it("preserves legacy engine behavior when no placement is bound", () => {
    expect(placementEngineBoundary(undefined)).toEqual({
      strictMcpConfig: false,
      enableChrome: undefined,
    });
  });
});

describe("runPlacementBoundEngine", () => {
  it("applies the strict boundary at the shared initial/retry execution choke point", async () => {
    const run = vi.fn().mockResolvedValue({ result: "ok" });
    await runPlacementBoundEngine({ name: "claude", run } as any, placement, { prompt: "retry", cwd: "/tmp" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "retry",
      strictMcpConfig: true,
      enableChrome: false,
    }));
  });

  it("keeps legacy executions non-strict at the same choke point", async () => {
    const run = vi.fn().mockResolvedValue({ result: "ok" });
    await runPlacementBoundEngine({ name: "codex", run } as any, undefined, { prompt: "legacy", cwd: "/tmp" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      strictMcpConfig: false,
      enableChrome: undefined,
    }));
  });

  it.each(["codex", "gemini"])("fails closed before running unsupported Placement engine %s", async (name) => {
    const run = vi.fn();
    await expect(runPlacementBoundEngine({ name, run } as any, placement, {
      prompt: "fallback",
      cwd: "/tmp",
    })).rejects.toThrow(`Placement-scoped execution rejects engine without Placement boundary support: ${name}`);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("placementSafeCliFlags", () => {
  it("preserves safe employee flags for strict placement runs", () => {
    expect(placementSafeCliFlags(["--debug", "--verbose"], true)).toEqual(["--debug", "--verbose"]);
  });

  it.each(["--chrome", "--mcp-config", "--strict-mcp-config"])(
    "rejects placement-controlled flag %s with a visible error",
    (flag) => {
      expect(() => placementSafeCliFlags(["--debug", flag], true)).toThrow(
        `Placement-scoped Claude run rejects employee cliFlags: ${flag}`,
      );
    },
  );

  it.each(["--chrome=true", "--mcp-config=/tmp/untrusted.json", "--strict-mcp-config=false"])(
    "rejects equals-form placement-controlled flag %s",
    (flag) => {
      expect(() => placementSafeCliFlags([flag], true)).toThrow(flag);
    },
  );

  it("preserves legacy flags without a strict placement boundary", () => {
    expect(placementSafeCliFlags(["--chrome", "--debug"], false)).toEqual(["--chrome", "--debug"]);
  });
});
