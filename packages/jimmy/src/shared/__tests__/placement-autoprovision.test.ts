import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// recordConfigChange resolves its history dir from JINN_HOME at call time;
// point it at a throwaway directory (same fixed-path pattern as
// config-history.test.ts — the vi.mock factory is hoisted).
vi.mock("../paths.js", () => {
  const home = path.join(import.meta.dirname || __dirname, ".tmp-autoprovision-test");
  return {
    JINN_HOME: home,
    CONFIG_PATH: path.join(home, "config.yaml"),
    LOGS_DIR: path.join(home, "logs"),
  };
});

import {
  AUTO_PROVISION_SOURCE,
  autoProvisionPlacement,
  buildAutoProvisionedPlacement,
  buildAutoProvisionGreeting,
  disablePlacementOnLeave,
} from "../placement-autoprovision.js";
import { listConfigHistory } from "../config-history.js";
import type { JinnConfig, PlacementProfile } from "../types.js";

const HOME = path.join(import.meta.dirname || __dirname, ".tmp-autoprovision-test");
const CONFIG = path.join(HOME, "config.yaml");

const invite = {
  connector: "slack",
  workspaceId: "T1",
  channelId: "C777",
  inviterUserId: "U42",
};

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(CONFIG, yaml.dump(config, { lineWidth: -1 }));
}

function readConfig(): JinnConfig {
  return yaml.load(fs.readFileSync(CONFIG, "utf-8")) as JinnConfig;
}

beforeEach(() => {
  fs.mkdirSync(HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("buildAutoProvisionedPlacement", () => {
  it("builds the standard profile with the inviter as owner", () => {
    const placement = buildAutoProvisionedPlacement(invite);
    expect(placement).toMatchObject({
      id: "auto-C777",
      connector: "slack",
      workspaceId: "T1",
      channelId: "C777",
      owner: "U42",
      purpose: "auto-provisioned (invited by U42)",
      audience: { type: "channel-members" },
      agent: { defaultModel: "sonnet", escalationEmployee: "critical-reviewer" },
      capabilities: {
        mcp: ["brainbase", "gateway"],
        gatewayTools: ["send_message", "create_task", "list_tasks", "update_task", "transition_task"],
      },
      dataScopes: { graph: "read-only" },
      monthlyBudgetUsd: 10,
    });
    // allowedDelivery stays absent so delivery falls back to the own channel.
    expect(placement.capabilities?.allowedDelivery).toBeUndefined();
    expect(placement.enabled).toBeUndefined();
  });

  it("records an unknown inviter without inventing an owner", () => {
    const placement = buildAutoProvisionedPlacement({ ...invite, inviterUserId: null });
    expect(placement.owner).toBeUndefined();
    expect(placement.purpose).toBe("auto-provisioned (invited by unknown)");
  });
});

describe("autoProvisionPlacement", () => {
  it("creates a channel-members placement with the standard profile on bot invite", () => {
    writeConfig({ placements: [] });
    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result.outcome).toBe("created");

    const persisted = readConfig();
    expect(persisted.placements).toHaveLength(1);
    expect(persisted.placements?.[0]).toMatchObject({
      id: "auto-C777",
      owner: "U42",
      purpose: "auto-provisioned (invited by U42)",
      audience: { type: "channel-members" },
      monthlyBudgetUsd: 10,
    });
  });

  it("records a config-history snapshot with source auto-provision before writing", () => {
    writeConfig({ placements: [] });
    autoProvisionPlacement(invite, { configPath: CONFIG });

    const entries = listConfigHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe(AUTO_PROVISION_SOURCE);
    expect(entries[0].file).toBe("config.yaml");
    // The snapshot holds the PRE-write content (no placement yet).
    const snapshot = fs.readFileSync(path.join(HOME, "config-history", entries[0].snapshot!), "utf-8");
    expect(snapshot).not.toContain("auto-C777");
  });

  it("does nothing when a placement for the channel already exists (including disabled)", () => {
    const existing: PlacementProfile = {
      id: "manual-one",
      connector: "slack",
      workspaceId: "T1",
      channelId: "C777",
      enabled: false,
      audience: { type: "project-team", allowedUsers: ["U1"] },
    };
    writeConfig({ placements: [existing] });
    const before = fs.readFileSync(CONFIG, "utf-8");

    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result).toEqual({ outcome: "exists", placementId: "manual-one" });
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
    expect(listConfigHistory()).toHaveLength(0);
  });

  it("does not auto-provision when the placements key is not configured (placement-mode gate)", () => {
    writeConfig({ gateway: { port: 31013, host: "127.0.0.1" } });
    const before = fs.readFileSync(CONFIG, "utf-8");

    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result).toEqual({ outcome: "not-placement-mode" });
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  it("honors the placementDefaults.autoProvision kill switch", () => {
    writeConfig({ placements: [], placementDefaults: { autoProvision: false } });
    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result).toEqual({ outcome: "auto-provision-disabled" });
    expect(readConfig().placements).toHaveLength(0);
  });

  it("applies placementDefaults overrides from config.yaml", () => {
    writeConfig({
      placements: [],
      placementDefaults: {
        agent: { defaultModel: "haiku", escalationEmployee: "other-reviewer" },
        monthlyBudgetUsd: 3,
      },
    });
    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result.outcome).toBe("created");
    const placement = readConfig().placements?.[0];
    expect(placement?.agent).toEqual({ defaultModel: "haiku", escalationEmployee: "other-reviewer" });
    expect(placement?.monthlyBudgetUsd).toBe(3);
    // Fields without overrides keep the standard profile.
    expect(placement?.capabilities?.mcp).toEqual(["brainbase", "gateway"]);
  });

  it("leaves config.yaml untouched when the write fails (fail-closed)", () => {
    writeConfig({ placements: [] });
    const before = fs.readFileSync(CONFIG, "utf-8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = autoProvisionPlacement(invite, { configPath: CONFIG });
    expect(result.outcome).toBe("error");
    rename.mockRestore();
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
  });

  it("fails closed without touching anything when config.yaml is missing or invalid", () => {
    expect(autoProvisionPlacement(invite, { configPath: CONFIG }).outcome).toBe("error");
    fs.writeFileSync(CONFIG, "just a string");
    expect(autoProvisionPlacement(invite, { configPath: CONFIG }).outcome).toBe("error");
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe("just a string");
  });
});

describe("disablePlacementOnLeave", () => {
  const provisioned: PlacementProfile = {
    id: "auto-C777",
    connector: "slack",
    workspaceId: "T1",
    channelId: "C777",
    owner: "U42",
    purpose: "auto-provisioned (invited by U42)",
    audience: { type: "channel-members" },
  };

  it("disables the placement on bot leave while keeping the entry (audit trail)", () => {
    writeConfig({ placements: [provisioned] });
    const result = disablePlacementOnLeave(invite, { configPath: CONFIG });
    expect(result).toEqual({ outcome: "disabled", placementId: "auto-C777" });

    const persisted = readConfig();
    expect(persisted.placements).toHaveLength(1);
    expect(persisted.placements?.[0]).toMatchObject({
      id: "auto-C777",
      enabled: false,
      owner: "U42",
      purpose: "auto-provisioned (invited by U42)",
    });
    expect(listConfigHistory()[0]?.source).toBe(AUTO_PROVISION_SOURCE);
  });

  it("is a no-op for unknown channels and already-disabled placements", () => {
    writeConfig({ placements: [{ ...provisioned, enabled: false }] });
    const before = fs.readFileSync(CONFIG, "utf-8");

    expect(disablePlacementOnLeave({ ...invite, channelId: "C999" }, { configPath: CONFIG }))
      .toEqual({ outcome: "not-found" });
    expect(disablePlacementOnLeave(invite, { configPath: CONFIG }))
      .toEqual({ outcome: "already-disabled", placementId: "auto-C777" });
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe(before);
  });
});

describe("buildAutoProvisionGreeting", () => {
  it("builds a greeting that names the owner and the escalation path", () => {
    const greeting = buildAutoProvisionGreeting(buildAutoProvisionedPlacement(invite));
    expect(greeting).toContain("標準プロファイル");
    expect(greeting).toContain("<@U42>");
    expect(greeting).toContain("できること:");
    // Exactly three capability lines.
    expect(greeting.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
    expect(greeting).toContain("owner から operator へ");
  });
});
