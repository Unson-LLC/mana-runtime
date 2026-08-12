import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface DeploymentConfig {
  account_id?: string;
  name: string;
  vars: Record<string, string>;
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  containers: Array<{ class_name: string }>;
  queues: {
    producers: Array<{ queue: string }>;
    consumers: Array<{ queue: string; dead_letter_queue: string }>;
  };
}

function loadConfig(name: string): DeploymentConfig {
  const path = fileURLToPath(new URL(`../../${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentConfig;
}

describe("会社別Cloudflare deployment", () => {
  const techKnight = loadConfig("wrangler.jsonc");
  const unson = loadConfig("wrangler.unson-business.jsonc");

  it("TechKnightのClaude Codeをopusかつxhighへ固定する", () => {
    expect(techKnight.vars).toMatchObject({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
  });

  it("雲孫事業運営を信頼済みworkspace、channel、projectへ固定する", () => {
    expect(unson.account_id).toBe("788e556343893a7135c29b782c22fb24");
    expect(unson.vars).toMatchObject({
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      SLACK_EXPECTED_APP_ID: "A0BPM2J33SN",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.unson.jp",
      RUNTIME_PROJECT_CODES: "back-office",
      RUNTIME_EXECUTION_MODE: "meeting_tasks",
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
  });

  it("Claude Codeを検証済みのexact versionへ固定する", () => {
    const dockerfilePath = fileURLToPath(new URL("../../Dockerfile", import.meta.url));
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    expect(dockerfile).toContain("@anthropic-ai/claude-code@2.1.195");
    expect(dockerfile).not.toMatch(/npm install -g @anthropic-ai\/claude-code\s*(?:\n|$)/);
  });

  it("雲孫とTechKnightのWorker、Queue、DLQを共有しない", () => {
    expect(unson.name).not.toBe(techKnight.name);
    expect(unson.vars.TENANT_ID).not.toBe(techKnight.vars.TENANT_ID);
    expect(unson.vars.SLACK_EXPECTED_TEAM_ID).not.toBe(
      techKnight.vars.SLACK_EXPECTED_TEAM_ID,
    );
    expect(unson.queues.producers[0]?.queue).not.toBe(
      techKnight.queues.producers[0]?.queue,
    );
    expect(unson.queues.consumers[0]?.dead_letter_queue).not.toBe(
      techKnight.queues.consumers[0]?.dead_letter_queue,
    );
    expect(unson.queues.consumers[0]?.queue).toBe(
      unson.queues.producers[0]?.queue,
    );
    expect(unson.queues.consumers[0]?.queue).not.toBe(
      techKnight.queues.consumers[0]?.queue,
    );
  });

  it("雲孫deploymentが専用Worker namespace内にDurable ObjectとContainerを持つ", () => {
    expect(unson.durable_objects.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TECHKNIGHT_WORKSPACE" }),
        expect.objectContaining({ name: "TECHKNIGHT_SANDBOX" }),
      ]),
    );
    expect(unson.containers).toEqual([
      expect.objectContaining({ class_name: "TechKnightSandbox" }),
    ]);
    expect(unson.name).toBe("unson-business-mana-runtime");
  });
});
