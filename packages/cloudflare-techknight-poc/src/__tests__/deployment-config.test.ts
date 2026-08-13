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

  it("builds the shared task runtime before every Cloudflare release entrypoint", () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const scriptName of ["build", "build:unson-business", "deploy:unson-business"]) {
      expect(packageJson.scripts[scriptName]).toContain(
        "pnpm --filter @openryoko/task-runtime-core build",
      );
      expect(packageJson.scripts[scriptName]).toContain(
        "pnpm --filter @openryoko/write-broker build",
      );
    }
  });

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
      RUNTIME_PLACEMENT_ID: "mana-accounting",
      RUNTIME_TASK_WRITE_ENABLED: "false",
      RUNTIME_TASK_BOARD_ENABLED: "false",
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    });
  });

  it("Claude Codeを検証済みのexact versionへ固定する", () => {
    const dockerfilePath = fileURLToPath(new URL("../../Dockerfile", import.meta.url));
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    expect(dockerfile).toContain("@anthropic-ai/claude-code@2.1.195");
    expect(dockerfile).not.toMatch(/npm install -g @anthropic-ai\/claude-code\s*(?:\n|$)/);
    expect(dockerfile).toContain(
      "COPY --chmod=0555 container/task-search-mcp-server.mjs /opt/mana/task-search-mcp-server.mjs",
    );
    expect(dockerfile).toContain(
      "COPY --chmod=0555 container/task-write-mcp-server.mjs /opt/mana/task-write-mcp-server.mjs",
    );
  });

  it("keeps task search off by default and documents the staged rollout", () => {
    expect(techKnight.vars.RUNTIME_TASK_SEARCH_ENABLED).toBe("false");
    expect(unson.vars.RUNTIME_TASK_SEARCH_ENABLED).toBe("true");
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("RUNTIME_TASK_SEARCH_ENABLED=false");
    expect(readme).toContain("Container");
    expect(readme).toContain("image digest");
    expect(readme).toContain("Worker version");
    expect(readme).toContain("Git SHA");
  });

  it("keeps production task search evidence open until Slack and Brainbase match", () => {
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("ON切替後の最初の境界付き`search_tasks` probeを記録");
    expect(readme).toContain("本番Slackで既知タスク");
    expect(readme).toContain("Brainbase正本と照合");
    expect(readme).toContain("テストやContainer healthだけをSlack E2E完了とは扱いません");
  });

  it("does not place task-search credentials in deployment files", () => {
    const configs = [
      readFileSync(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)), "utf8"),
      readFileSync(fileURLToPath(new URL("../../wrangler.unson-business.jsonc", import.meta.url)), "utf8"),
      readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8"),
    ].join("\n");
    expect(configs).not.toContain("brainbase-secret-canary");
    expect(configs).not.toMatch(/BRAINBASE_TASK_API_TOKEN\s*[:=]\s*["'][^"']+/);
    expect(configs).not.toContain("Bearer ");
  });

  it("keeps Sandbox internet off with only Anthropic and the synthetic search host", () => {
    const sandboxPath = fileURLToPath(new URL("../sandbox-runtime.ts", import.meta.url));
    const sandboxRuntime = readFileSync(sandboxPath, "utf8");
    expect(sandboxRuntime).toContain("enableInternet = false");
    expect(sandboxRuntime).toContain('allowedHosts = ["api.anthropic.com", TASK_SEARCH_PROXY_HOST, TASK_WRITE_PROXY_HOST]');
    expect(sandboxRuntime).toContain("[TASK_SEARCH_PROXY_HOST]: handleTaskSearchProxyRequest");
    expect(sandboxRuntime).toContain("[TASK_WRITE_PROXY_HOST]: handleTaskWriteProxyRequest");
    expect(sandboxRuntime).not.toContain('"bb.unson.jp"');
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

  it("keeps board repair bounded, retryable, and disabled until cutover", () => {
    expect(unson.vars.RUNTIME_TASK_BOARD_ENABLED).toBe("false");
    expect(unson.queues.producers).toEqual(expect.arrayContaining([
      expect.objectContaining({ queue: "unson-business-mana-task-board-repairs" }),
    ]));
    expect(unson.queues.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        queue: "unson-business-mana-task-board-repairs",
        dead_letter_queue: "unson-business-mana-task-board-repairs-dlq",
      }),
    ]));
    const raw = readFileSync(
      fileURLToPath(new URL("../../wrangler.unson-business.jsonc", import.meta.url)),
      "utf8",
    );
    expect(raw).toContain('"crons": ["*/15 * * * *"]');
    expect(raw).not.toContain("TASK_WRITE_CAPABILITY_SECRET");
    expect(raw).not.toContain("GITHUB_TOKEN");
  });

  it("documents the task ownership cutover and the remaining GitHub minutes boundary", () => {
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("mana-accounting.enabled=false");
    expect(readme).toContain("taskCanvas.enabled=false");
    expect(readme).toContain("GITHUB_TOKEN");
    expect(readme).toContain("meetingMinutesPipeline.destination.github");
    expect(readme).toContain("議事録pipelineを停止しない");
  });
});
