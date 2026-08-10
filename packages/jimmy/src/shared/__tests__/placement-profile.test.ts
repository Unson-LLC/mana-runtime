import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findEnabledPlacement, isPlacementEmployeeAllowed, isSkillVisibleToPlacement, PLACEMENT_MCP_TOOL_DENY, placementAllowedTools, placementEngineBoundary, placementMemoryReadDenyRules, placementNeedsChannelMembership, placementProjectCodesForPlacement, placementSafeCliFlags, placementWorkingDirectory, placementWorkspaceDenyRules, placementWriteDenyRules, resolvePlacement, runPlacementBoundEngine } from "../placement-profile.js";
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

  it("fails closed for a static audience without an allowedUsers list", () => {
    const listless = { ...placement, audience: { type: "project-team" } } as PlacementProfile;
    expect(resolvePlacement([listless], message()))
      .toEqual({ status: "denied", reason: "unauthorized_user" });
  });
});

describe("resolvePlacement channel-members audience", () => {
  const channelMembers: PlacementProfile = {
    ...placement,
    audience: { type: "channel-members" },
  };

  it("matches a channel-members placement when the speaker membership is member", () => {
    expect(resolvePlacement([channelMembers], message({ user: "Uanyone" }), { channelMembership: "member" }))
      .toMatchObject({ status: "matched", placement: channelMembers });
  });

  it.each([
    ["non-member", { channelMembership: "non-member" as const }],
    ["unknown", { channelMembership: "unknown" as const }],
    ["unstated", undefined],
  ])("denies channel-members placements when membership is non-member, unknown, or unstated (fail-closed) [%s]", (_label, opts) => {
    expect(resolvePlacement([channelMembers], message(), opts))
      .toEqual({ status: "denied", reason: "unauthorized_user", placementId: "mana-test" });
  });

  it("ignores the static allowlist path for channel-members audiences", () => {
    // Even a user that would fail the static list resolves purely by membership.
    const withStaleList = {
      ...channelMembers,
      audience: { type: "channel-members", allowedUsers: [] },
    } as PlacementProfile;
    expect(resolvePlacement([withStaleList], message({ user: "U9" }), { channelMembership: "member" }).status)
      .toBe("matched");
  });

  it("still honors the kill switch before membership", () => {
    expect(resolvePlacement([{ ...channelMembers, enabled: false }], message(), { channelMembership: "member" }))
      .toEqual({ status: "denied", reason: "disabled", placementId: "mana-test" });
  });
});

describe("placementNeedsChannelMembership", () => {
  const channelMembers: PlacementProfile = { ...placement, audience: { type: "channel-members" } };

  it("requests a membership lookup only for a unique channel-members match", () => {
    expect(placementNeedsChannelMembership([channelMembers], message())).toBe(true);
    expect(placementNeedsChannelMembership([placement], message())).toBe(false);
    expect(placementNeedsChannelMembership([channelMembers], message({ channel: "C2" }))).toBe(false);
    expect(placementNeedsChannelMembership(undefined, message())).toBe(false);
    expect(placementNeedsChannelMembership([], message())).toBe(false);
  });

  it("skips the lookup for ambiguous matches (they deny regardless)", () => {
    expect(placementNeedsChannelMembership([channelMembers, { ...channelMembers, id: "dup" }], message())).toBe(false);
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

describe("placementProjectCodesForPlacement", () => {
  it("unions normalized projects only within the authenticated channel scope", () => {
    const scoped: PlacementProfile = { ...placement, projects: [" back-office ", "shared"] };
    expect(placementProjectCodesForPlacement([
      scoped,
      { ...scoped, id: "same-channel", projects: ["shared", "finance", ""] },
      { ...scoped, id: "disabled", enabled: false, projects: ["disabled"] },
      { ...scoped, id: "other-workspace", workspaceId: "T2", projects: ["other-workspace"] },
      { ...scoped, id: "other-channel", channelId: "C2", projects: ["other-channel"] },
      { ...scoped, id: "other-connector", connector: "discord", projects: ["other-connector"] },
    ], scoped.id)).toEqual(["back-office", "shared", "finance"]);
  });

  it("fails closed for unknown, disabled, or incomplete authority anchors", () => {
    expect(placementProjectCodesForPlacement([placement], "missing")).toEqual([]);
    expect(placementProjectCodesForPlacement([{ ...placement, enabled: false }], placement.id)).toEqual([]);
    expect(placementProjectCodesForPlacement([{ ...placement, workspaceId: "" }], placement.id)).toEqual([]);
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

describe("placementAllowedTools", () => {
  it("derives a whole-server allow rule for every capabilities.mcp server except gateway", () => {
    const allows = placementAllowedTools({
      capabilities: { mcp: ["brainbase", "nocodb", "gateway"] },
    });
    expect(allows).toContain("mcp__brainbase__*");
    expect(allows).toContain("mcp__nocodb__*");
    expect(allows).not.toContain("mcp__gateway__*");
  });

  it("derives per-tool gateway allow rules from capabilities.gatewayTools", () => {
    expect(placementAllowedTools({
      capabilities: { mcp: ["gateway"], gatewayTools: ["create_task", "send_message"] },
    })).toEqual(["mcp__gateway__create_task", "mcp__gateway__send_message"]);
  });

  it("derives no allow rules when capabilities.mcp is false or absent (deny by default)", () => {
    expect(placementAllowedTools({ capabilities: { mcp: false } })).toEqual([]);
    expect(placementAllowedTools({})).toEqual([]);
  });

  it("derives the freee server allow from capabilities.mcp alone without any global registration (ALLOWTOOLS-STORY-S-001)", () => {
    // mana-accounting/mana-backoffice shape: freee granted via capabilities only.
    const accounting: PlacementProfile = {
      ...placement,
      id: "mana-accounting",
      capabilities: { mcp: ["brainbase", "gateway", "freee"], gatewayTools: ["create_task"] },
    };
    const boundary = placementEngineBoundary(accounting);
    expect(boundary.allowedTools).toContain("mcp__freee__*");
    // The write surface stays denied in the same spawn (read-only until G2).
    for (const tool of [
      "mcp__freee__freee_api_post", "mcp__freee__freee_api_put", "mcp__freee__freee_api_delete",
      "mcp__freee__freee_api_patch", "mcp__freee__freee_file_upload",
    ]) {
      expect(boundary.disallowedTools).toContain(tool);
    }
  });
});

describe("placementEngineBoundary", () => {
  it("enforces strict MCP and disables Chrome for every placement execution", () => {
    expect(placementEngineBoundary(placement)).toEqual({
      strictMcpConfig: true,
      enableChrome: false,
      allowedTools: [],
      disallowedTools: [
        ...placementWriteDenyRules(),
        ...placementMemoryReadDenyRules(placement.id, []),
        ...PLACEMENT_MCP_TOOL_DENY,
      ],
      placementBashGuard: true,
    });
  });

  it("passes derived allowedTools through the engine boundary on every placement run", () => {
    const capable: PlacementProfile = {
      ...placement,
      capabilities: { mcp: ["brainbase"], gatewayTools: ["create_task"] },
    };
    expect(placementEngineBoundary(capable).allowedTools)
      .toEqual(["mcp__brainbase__*", "mcp__gateway__create_task"]);
  });

  it("leaves allowedTools undefined for non-placement runs (global interactiveAllowedTools stays in charge)", () => {
    expect(placementEngineBoundary(undefined).allowedTools).toBeUndefined();
  });

  it("keeps every constant deny in disallowedTools even when its server is wholesale-allowed (deny beats allow)", () => {
    const wholesale: PlacementProfile = {
      ...placement,
      capabilities: { mcp: ["brainbase", "freee"] },
    };
    const boundary = placementEngineBoundary(wholesale);
    expect(boundary.allowedTools).toContain("mcp__brainbase__*");
    expect(boundary.allowedTools).toContain("mcp__freee__*");
    for (const denied of PLACEMENT_MCP_TOOL_DENY) {
      expect(boundary.disallowedTools).toContain(denied);
    }
  });

  it("denies freee write tools in every placement session (read-only until G2)", () => {
    for (const tool of [
      "mcp__freee__freee_api_post", "mcp__freee__freee_api_put", "mcp__freee__freee_api_delete",
      "mcp__freee__freee_api_patch", "mcp__freee__freee_file_upload",
    ]) {
      expect(PLACEMENT_MCP_TOOL_DENY).toContain(tool);
      expect(placementEngineBoundary(placement).disallowedTools).toContain(tool);
    }
  });

  it("re-derives the boundary from the live placement on every run so config changes bind at the next spawn", () => {
    // Same placement id, capabilities changed by a config hot-reload: the next
    // derivation must reflect the new capabilities with no boot-time residue.
    const before: PlacementProfile = { ...placement, capabilities: { mcp: ["brainbase"] } };
    const after: PlacementProfile = { ...placement, capabilities: { mcp: ["brainbase", "freee"] } };
    expect(placementEngineBoundary(before).allowedTools).toEqual(["mcp__brainbase__*"]);
    expect(placementEngineBoundary(after).allowedTools).toEqual(["mcp__brainbase__*", "mcp__freee__*"]);
  });

  it("adds the personal KG tool deny to every placement session's disallowedTools", () => {
    const brainbaseAllowed: PlacementProfile = {
      ...placement,
      capabilities: { mcp: ["brainbase", "gateway"] },
    };
    for (const bound of [placement, brainbaseAllowed]) {
      expect(placementEngineBoundary(bound).disallowedTools)
        .toContain("mcp__brainbase__search_personal_kg");
    }
    // Legacy (non-placement) sessions keep their unrestricted behavior.
    expect(placementEngineBoundary(undefined).disallowedTools).toBeUndefined();
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
      allowedTools: undefined,
      disallowedTools: undefined,
      placementBashGuard: false,
    });
  });
});

describe("placement read-only workspace", () => {
  it("uses an existing absolute checkout as the working directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "placement-workspace-"));
    try {
      const scoped = { ...placement, workspace: { path: root, access: "read-only" as const } };
      expect(placementWorkingDirectory(scoped)).toBe(fs.realpathSync(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, relative, or symlinked workspace paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "placement-workspace-"));
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    try {
      expect(() => placementWorkingDirectory({ workspace: { path: "relative", access: "read-only" } }))
        .toThrow("must be absolute");
      expect(() => placementWorkingDirectory({ workspace: { path: path.join(root, "missing"), access: "read-only" } }))
        .toThrow();
      expect(() => placementWorkingDirectory({ workspace: { path: alias, access: "read-only" } }))
        .toThrow("must not be a symlink");
    } finally {
      fs.unlinkSync(alias);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies every write tool and Bash while preserving read tools", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "placement-workspace-"));
    try {
      const scoped: PlacementProfile = {
        ...placement,
        workspace: { path: root, access: "read-only" },
      };
      const rules = placementWorkspaceDenyRules(scoped);
      expect(rules).toContain("Bash");
      const resolved = fs.realpathSync(root);
      expect(rules).toContain(`Write(/${path.join(resolved, "**")})`);
      expect(rules).toContain(`Edit(/${path.join(resolved, "**")})`);
      expect(rules).not.toContain("Read");
      expect(placementEngineBoundary(scoped).disallowedTools).toEqual(expect.arrayContaining(rules));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it.each([
    "gateway.json", "gateway.pid", "hook-relay.mjs", "placement-guard.mjs",
  ])("denies every write tool on enforcement runtime file %s", (file) => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(rules).toContain(`${tool}(//home/test/.ryoko/${file})`);
    }
  });

  it("denies recursive writes under the per-session settings dir", () => {
    expect(rules).toContain("Write(//home/test/.ryoko/tmp/settings/**)");
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
        ...PLACEMENT_MCP_TOOL_DENY,
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
