import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseRuntimePlacements } from "../runtime-config.js";

interface WranglerConfig {
  main: string;
  vars: Record<string, string>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  triggers: { crons: string[] };
}

interface TaskWriteRule {
  effect: "auto" | "approval" | "deny";
  actors: string[];
  placements: string[];
  projects: string[];
  operations: string[];
}

function packageFile(path: string): string {
  return fileURLToPath(new URL(`../../${path}`, import.meta.url));
}

function config(): WranglerConfig {
  return JSON.parse(readFileSync(packageFile("wrangler.unson-business.jsonc"), "utf8")) as WranglerConfig;
}

describe("Unson Business autonomy deployment contract", () => {
  it("keeps the canonical Worker entrypoint while leaving autonomy absent and kill-switched", () => {
    const current = config();

    expect(current.main).toBe("src/index.ts");
    expect(current.vars.MANA_AUTONOMY_DISABLED).toBe("true");
    expect(current.vars).not.toHaveProperty("MANA_AUTONOMY_EXPERIMENT_JSON");
    expect(current.vars.MANA_AUTONOMY_CRON).toBe("*/15 * * * *");
    expect(current.triggers.crons).toContain(current.vars.MANA_AUTONOMY_CRON);
    expect(current.vars.MANA_AUTONOMY_CLAUDE_MODEL).toBe("sonnet");
    expect(current.durable_objects.bindings).toContainEqual({
      name: "TASK_WRITE_BUDGETS",
      class_name: "TaskWriteBudget",
    });
  });

  it("binds the autonomy placement to the Brainbase channel and one project only", () => {
    const current = config();
    const placements = parseRuntimePlacements(current.vars.RUNTIME_PLACEMENTS_JSON);
    const matches = placements.filter((placement) => placement.placementId === "mana-autonomy");

    expect(matches).toEqual([{
      placementId: "mana-autonomy",
      channelId: "C0BKE4D0TK9",
      channelName: "mana-autonomy",
      projectCodes: ["brainbase"],
      taskWriteEnabled: true,
      taskBoardEnabled: true,
      capabilities: { mcp: ["brainbase"], gatewayTools: [] },
    }]);
    expect(current.vars.MANA_AUTONOMY_PLACEMENT_ID).toBe("mana-autonomy");
    expect(current.vars.MANA_AUTONOMY_CHANNEL_ID).toBe("C0BKE4D0TK9");
    expect(current.vars.RUNTIME_PROJECT_CODES.split(",")).not.toContain("brainbase");
  });

  it("uses read-scoped runtime authority and grants task.create only through the write broker", () => {
    const current = config();
    const policy = JSON.parse(current.vars.TASK_WRITE_POLICY_JSON) as {
      version: string;
      rules: TaskWriteRule[];
    };
    const serviceRules = policy.rules.filter((rule) => rule.actors.includes("mana_autonomy_v0"));

    expect(policy.version).toBe("unson-business-v4");
    expect(current.vars.MANA_AUTONOMY_CAPABILITY_ID).toBe("runtime.execute");
    expect(serviceRules).toEqual([{
      effect: "auto",
      actors: ["mana_autonomy_v0"],
      placements: ["mana-autonomy"],
      projects: ["brainbase"],
      operations: ["task.create"],
    }]);
    expect(current.vars.MANA_AUTONOMY_PER_RUN_BUDGET).toBe("2");
    expect(JSON.stringify(serviceRules)).not.toMatch(/task\.(?:update|transition)/u);
  });

  it("maps reply execution and task-board sends to the external-side-effect authority", () => {
    const current = config();

    if (current.vars.RUNTIME_TASK_BOARD_ENABLED !== "true") return;

    expect(JSON.parse(current.vars.MANA_COMPANY_AUTHORITY_OPERATIONS_JSON)).toEqual({
      "runtime.execute": "external_side_effect",
      "company_authority_v1": "external_side_effect",
      "task_board_send": "external_side_effect",
    });
  });
});
