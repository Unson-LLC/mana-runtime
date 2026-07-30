import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findEnabledPlacement, isPlacementEmployeeAllowed, isSkillVisibleToPlacement, placementEngineBoundary, placementMemoryReadDenyRules, placementSafeCliFlags, placementWriteDenyRules, resolvePlacement, runPlacementBoundEngine } from "../placement-profile.js";
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

  it("fails closed with an auditable reason when the placement kill switch is off", () => {
    expect(resolvePlacement([{ ...placement, enabled: false }], message()))
      .toEqual({ status: "denied", reason: "disabled", placementId: "mana-test" });
  });

  it("treats explicit enabled: true and absent enabled as active", () => {
    expect(resolvePlacement([{ ...placement, enabled: true }], message()).status).toBe("matched");
    expect(resolvePlacement([placement], message()).status).toBe("matched");
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

describe("findEnabledPlacement", () => {
  it("resolves an enabled placement by id", () => {
    expect(findEnabledPlacement([placement], "mana-test")).toEqual({ placement, disabled: false });
  });

  it("reports a disabled placement distinctly so callers fail closed", () => {
    expect(findEnabledPlacement([{ ...placement, enabled: false }], "mana-test"))
      .toEqual({ disabled: true });
  });

  it("returns nothing for unknown or non-string ids", () => {
    expect(findEnabledPlacement([placement], "other")).toEqual({ disabled: false });
    expect(findEnabledPlacement([placement], undefined)).toEqual({ disabled: false });
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
      disallowedTools: [
        ...placementWriteDenyRules(),
        ...placementMemoryReadDenyRules(placement.id, []),
      ],
    });
  });

  it("includes memory read deny rules for every other configured placement", () => {
    const other: PlacementProfile = { ...placement, id: "mana-other", channelId: "C2" };
    const boundary = placementEngineBoundary(placement, [placement, other]);
    for (const rule of placementMemoryReadDenyRules(placement.id, ["mana-other"])) {
      expect(boundary.disallowedTools).toContain(rule);
    }
  });

  it("preserves legacy engine behavior when no placement is bound", () => {
    expect(placementEngineBoundary(undefined)).toEqual({
      strictMcpConfig: false,
      enableChrome: undefined,
      disallowedTools: undefined,
    });
  });
});

describe("placementWriteDenyRules", () => {
  const rules = placementWriteDenyRules("/home/test/.ryoko");

  it.each([
    "CLAUDE.md", "AGENTS.md", "SOUL.md", "IDENTITY.md", "MEMORY.md", "TOOLS.md", "config.yaml",
  ])("denies every write tool on shared file %s with an absolute-path pattern", (file) => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(rules).toContain(`${tool}(//home/test/.ryoko/${file})`);
    }
  });

  it.each(["skills", "memory", "knowledge", "docs", "org", "cron"])(
    "denies recursive writes under shared directory %s/",
    (dir) => {
      for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
        expect(rules).toContain(`${tool}(//home/test/.ryoko/${dir}/**)`);
      }
    },
  );
});

describe("placementMemoryReadDenyRules", () => {
  it("denies Read/Glob/Grep on every other configured placement's memory directory", () => {
    const rules = placementMemoryReadDenyRules("mana-test", ["mana-test", "mana-other", "mana-third"], "/home/test/.ryoko");
    for (const tool of ["Read", "Glob", "Grep"]) {
      expect(rules).toContain(`${tool}(//home/test/.ryoko/memory/placements/mana-other/**)`);
      expect(rules).toContain(`${tool}(//home/test/.ryoko/memory/placements/mana-third/**)`);
    }
  });

  it("never denies the placement's own memory directory or the shared memory root", () => {
    const rules = placementMemoryReadDenyRules("mana-test", ["mana-test", "mana-other"], "/home/test/.ryoko");
    expect(rules.some((rule) => rule.includes("/memory/placements/mana-test/"))).toBe(false);
    expect(rules.some((rule) => /\(\/\/home\/test\/\.ryoko\/memory\/\*\*\)/.test(rule))).toBe(false);
  });

  it("also denies placement directories that exist on disk but are absent from config", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-home-"));
    try {
      fs.mkdirSync(path.join(home, "memory", "placements", "mana-orphan"), { recursive: true });
      fs.mkdirSync(path.join(home, "memory", "placements", "mana-test"), { recursive: true });
      const rules = placementMemoryReadDenyRules("mana-test", [], home);
      for (const tool of ["Read", "Glob", "Grep"]) {
        expect(rules).toContain(`${tool}(/${home}/memory/placements/mana-orphan/**)`);
      }
      expect(rules.some((rule) => rule.includes("/memory/placements/mana-test/"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns no rules when nothing else is configured and no directory exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-home-"));
    try {
      expect(placementMemoryReadDenyRules("mana-test", ["mana-test"], home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("isSkillVisibleToPlacement", () => {
  const capablePlacement = {
    ...placement,
    projects: ["salestailor"],
    capabilities: { mcp: ["nocodb"], gatewayTools: ["create_task"] },
  } satisfies PlacementProfile;

  it("shows a skill whose required capabilities and scope all match the placement", () => {
    expect(isSkillVisibleToPlacement(
      { requiredMcp: ["nocodb"], requiredTools: ["create_task"], scope: "salestailor" },
      capablePlacement,
    )).toBe(true);
  });

  it("shows undeclared (global, no-requirement) skills to any placement", () => {
    expect(isSkillVisibleToPlacement({ requiredMcp: [], requiredTools: [] }, placement)).toBe(true);
  });

  it("hides a skill whose required MCP server is outside the placement capabilities", () => {
    expect(isSkillVisibleToPlacement(
      { requiredMcp: ["nocodb", "brainbase"], requiredTools: [] },
      capablePlacement,
    )).toBe(false);
  });

  it("hides every MCP-requiring skill when capabilities.mcp is false or absent (deny by default)", () => {
    expect(isSkillVisibleToPlacement(
      { requiredMcp: ["nocodb"], requiredTools: [] },
      { ...placement, capabilities: { mcp: false } },
    )).toBe(false);
    expect(isSkillVisibleToPlacement(
      { requiredMcp: ["nocodb"], requiredTools: [] },
      placement,
    )).toBe(false);
  });

  it("hides a skill whose required gateway tool is not granted", () => {
    expect(isSkillVisibleToPlacement(
      { requiredMcp: [], requiredTools: ["send_message"] },
      capablePlacement,
    )).toBe(false);
  });

  it("hides a scoped skill from placements whose projects do not include the scope", () => {
    expect(isSkillVisibleToPlacement(
      { requiredMcp: [], requiredTools: [], scope: "zeims" },
      capablePlacement,
    )).toBe(false);
    expect(isSkillVisibleToPlacement(
      { requiredMcp: [], requiredTools: [], scope: "zeims" },
      placement,
    )).toBe(false);
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
      disallowedTools: [
        ...placementWriteDenyRules(),
        ...placementMemoryReadDenyRules(placement.id, []),
      ],
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
