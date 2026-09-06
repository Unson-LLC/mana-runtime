import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessTenantRuntimeDeploymentConfig } from "../../scripts/tenant-runtime-deploy-readiness.mjs";

interface DeploymentConfig {
  account_id?: string;
  name: string;
  observability?: {
    enabled: boolean;
    head_sampling_rate: number;
    logs: { invocation_logs: boolean };
  };
  version_metadata?: { binding: string };
  services?: Array<{ binding: string; service: string }>;
  vars: Record<string, string>;
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  containers: Array<{ class_name: string; max_instances: number }>;
  queues: {
    producers: Array<{ queue: string }>;
    consumers: Array<{ queue: string; dead_letter_queue: string; max_concurrency: number }>;
  };
}

function loadConfig(name: string): DeploymentConfig {
  const path = fileURLToPath(new URL(`../../${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentConfig;
}

interface ProductionTaskMigrationEvidence {
  cloudflare: {
    current: { worker_version: string; git_sha: string; task_board_enabled: boolean };
    mutation_e2e_deployment: { worker_version: string; git_sha: string };
    container: { image_digest: string };
  };
  slack_e2e: { mutation: { title: string; transition: { version: number; status: string } } };
  canvas: { visible_titles: string[]; screenshot: { sha256: string } };
  lightsail: {
    config_git_sha: string;
    task_ownership: { placement_enabled: boolean; task_canvas_enabled: boolean };
  };
  ownership_assertion: {
    task_search_owner: string;
    task_write_owner: string;
    task_board_owner: string;
    lightsail_task_owner_enabled: boolean;
  };
  scope_boundary: { meeting_minutes: string };
}

function loadProductionEvidence(): ProductionTaskMigrationEvidence {
  const path = fileURLToPath(
    new URL(
      "../../../../docs/operations/cloudflare-task-migration-evidence-2026-08-13.json",
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, "utf8")) as ProductionTaskMigrationEvidence;
}

describe("会社別Cloudflare deployment", () => {
  const techKnight = loadConfig("wrangler.jsonc");
  const unson = loadConfig("wrangler.unson-business.jsonc");

  it("story-task-canvas-ownership:ac:5 enables auto-provision for every configured task-board target", () => {
    const targets = JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON) as Array<{
      targetId: string; organizationId: string; workspaceId: string; channelId: string; projectCodes: string[];
      enabled: boolean; autoProvision?: boolean; manaCanvasId: string | null; bindingRevision: number | null;
    }>;
    const destinations = [
      ...JSON.parse(unson.vars.MEETING_MINUTES_DESTINATIONS_JSON) as Array<{ id: string; projectId: string;
        contextProjectCode: string; taskProjectCodes: string[]; taskBoardTargetId: string; slackChannelId: string }>,
      ...JSON.parse(unson.vars.MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON) as Array<{ id: string; projectId: string;
        contextProjectCode: string; taskProjectCodes: string[]; taskBoardTargetId: string; slackChannelId: string }>,
    ];
    const minutesTargets = targets.filter((target) => target.targetId.startsWith("minutes-"));
    expect(targets).toHaveLength(24);
    expect(minutesTargets).toHaveLength(23);
    const autoProvisioned = targets.filter((target) => target.autoProvision);
    expect(autoProvisioned).toHaveLength(targets.length);
    expect(autoProvisioned.every((target) => target.enabled === true && (target.manaCanvasId ?? null) === null
      && target.bindingRevision === (target.targetId === "minutes-pms" ? 2 : 1))).toBe(true);
    expect(minutesTargets.reduce<Record<string, number>>((counts, target) => ({ ...counts,
      [target.organizationId]: (counts[target.organizationId] ?? 0) + 1 }), {}))
      .toEqual({ "unson-business": 9, unson: 4, "tech-knight": 10 });
    for (const destination of destinations) {
      const target = minutesTargets.find((candidate) => candidate.targetId === destination.taskBoardTargetId);
      expect(target).toEqual(expect.objectContaining({ channelId: destination.slackChannelId }));
      expect(destination.taskProjectCodes).toHaveLength(1);
      expect(target?.projectCodes).toEqual(expect.arrayContaining(destination.taskProjectCodes));
    }
    expect(Object.fromEntries(destinations.map((destination) => [destination.id, {
      context: destination.contextProjectCode, tasks: destination.taskProjectCodes[0],
      board: destination.taskBoardTargetId,
    }]))).toEqual({
      "baao-growin": { context: "baao", tasks: "baao", board: "minutes-baao-growin" },
      zeims: { context: "zeims", tasks: "zeims", board: "minutes-zeims" },
      "ncom-catalyst": { context: "ncom", tasks: "ncom", board: "minutes-ncom-catalyst" },
      "unson-board": { context: "unson", tasks: "unson", board: "minutes-unson-board" },
      "back-office": { context: "back-office", tasks: "back-office", board: "minutes-back-office" },
      "legal-affairs": { context: "unson", tasks: "unson", board: "minutes-legal-affairs" },
      brainbase: { context: "brainbase", tasks: "brainbase", board: "minutes-brainbase" },
      "tech-knight": { context: "techknight", tasks: "proj_techknight_board", board: "minutes-tech-knight" },
      aitle: { context: "aitle", tasks: "aitle", board: "minutes-aitle" },
      aitel: { context: "techknight", tasks: "smart-front", board: "minutes-aitel" },
      council: { context: "techknight", tasks: "techknight-leisure-hotel-future-competition-council", board: "minutes-council" },
      pms: { context: "techknight", tasks: "techknight-staye-business-succession-pms", board: "minutes-pms" },
      "hp-sales": { context: "techknight", tasks: "techknight-hotel-website-production", board: "minutes-hp-sales" },
      senpainurse: { context: "senpainurse", tasks: "senpainurse", board: "minutes-senpainurse" },
      "techknight-board": { context: "techknight", tasks: "proj_techknight_board", board: "minutes-techknight-board" },
      "techknight-executives": { context: "techknight", tasks: "proj_techknight_board", board: "minutes-techknight-executives" },
      salestailor: { context: "salestailor", tasks: "salestailor", board: "minutes-salestailor" },
      baao: { context: "baao", tasks: "baao", board: "minutes-baao" },
      yakumokai: { context: "unson", tasks: "unson", board: "minutes-yakumokai" },
      "other-meetings": { context: "unson", tasks: "unson", board: "minutes-other" },
      cursorvers: { context: "unson", tasks: "unson", board: "minutes-cursorvers" },
      kartz: { context: "kartz", tasks: "kartz", board: "minutes-kartz" },
      united: { context: "techknight", tasks: "techknight-hotel-united-phase2-marketing", board: "minutes-united" },
    });
    expect(Object.fromEntries(minutesTargets
      .filter((target) => target.organizationId === "tech-knight")
      .map((target) => [target.targetId, target.projectCodes]))).toMatchObject({
      "minutes-tech-knight": ["proj_techknight_board"],
      "minutes-aitel": ["smart-front"],
      "minutes-council": ["techknight-leisure-hotel-future-competition-council", "proj_council"],
      "minutes-pms": ["techknight-staye-business-succession-pms", "proj_pms"],
      "minutes-hp-sales": ["techknight-hotel-website-production"],
      "minutes-techknight-board": ["proj_techknight_board"],
      "minutes-techknight-executives": ["proj_techknight_board"],
      "minutes-united": ["techknight-hotel-united-phase2-marketing", "proj_united"],
    });
    expect(targets.find((target) => target.targetId === "runtime-mana-dev-biz")).toMatchObject({
      workspaceId: "T0882T8N9UH", channelId: "C0BMNSP6C80", projectCodes: ["mana"],
    });
    expect(minutesTargets.filter((target) => target.organizationId === "tech-knight")
      .every((target) => target.workspaceId === "T07A9J3PEMB")).toBe(true);
    expect(minutesTargets.filter((target) => ["minutes-salestailor", "minutes-baao", "minutes-yakumokai", "minutes-other"].includes(target.targetId))
      .every((target) => target.workspaceId === "T07LL5WV7N1")).toBe(true);
    expect(minutesTargets.filter((target) => target.organizationId === "unson-business")
      .every((target) => target.workspaceId === "T0882T8N9UH")).toBe(true);
  });

  it("builds the shared task runtime before every Cloudflare release entrypoint", () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.build).toBe("node scripts/build-profiles.mjs");
    const buildProfiles = readFileSync(
      fileURLToPath(new URL("../../scripts/build-profiles.mjs", import.meta.url)),
      "utf8",
    );
    expect(buildProfiles).toContain(
      '["build:default", "build:unson-business", "build:dedicated-cloud", "build:customer-managed-oss"]',
    );
    for (const scriptName of [
      "build:default",
      "build:unson-business",
      "build:dedicated-cloud",
      "build:customer-managed-oss",
      "deploy:unson-business",
    ]) {
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
    expect(unson.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: { invocation_logs: true },
    });
    expect(unson.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(unson.vars).toMatchObject({
      TENANT_ID: "unson-business",
      SLACK_EXPECTED_TEAM_ID: "T0882T8N9UH",
      SLACK_EXPECTED_APP_ID: "A0BPM2J33SN",
      SLACK_ALLOWED_CHANNEL_ID: "C0BKS6RL99T",
      TASK_WRITE_APPROVAL_CHANNEL_ID: "C0BMNSP6C80",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.unson.jp",
      BRAINBASE_RUN_RECEIPT_INGEST_URL: "https://bb.unson.jp/api/run-receipts/ingest",
      RUNTIME_PROJECT_CODES: "back-office,unson",
      RUNTIME_EXECUTION_MODE: "meeting_tasks",
      RUNTIME_PLACEMENT_ID: "mana-accounting",
      RUNTIME_PLACEMENTS_JSON: expect.any(String),
      RUNTIME_TASK_WRITE_ENABLED: "true",
      RUNTIME_TASK_BOARD_ENABLED: "true",
      MEETING_MINUTES_ENABLED: "true",
      MEETING_MINUTES_CONTEXT_MODE: "required",
      MEETING_MINUTES_ROUTER_CHANNEL_ID: "C0BKTFQ9V38",
      MEETING_MINUTES_OPERATOR_USER_IDS: "U088D1HBY6L,U0BKP8D3KPD,U07B19N048G",
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
      DEVELOPMENT_CALLBACK_BASE_URL: "https://unson-business-mana-runtime.unson.workers.dev",
    });
    expect(JSON.parse(unson.vars.MEETING_MINUTES_DESTINATION_TEAM_IDS_JSON)).toEqual({
      unson: { workspace_id: "T07LL5WV7N1", app_id: "A093QM6QEPP" },
      "unson-business": { workspace_id: "T0882T8N9UH", app_id: "A0BPM2J33SN" },
      "tech-knight": { workspace_id: "T07A9J3PEMB", app_id: "A0A1WER0LEQ" },
    });
    expect(JSON.parse(unson.vars.BRAINBASE_WORKSPACE_CONNECTIONS_JSON)).toEqual([
      expect.objectContaining({
        workspace_id: "T0882T8N9UH",
        app_id: "A0BPM2J33SN",
        deployment_id: "dep_01M0HMA2282QK43N9FR9690EQS",
        contract_revision: "3",
      }),
    ]);
    expect(JSON.parse(unson.vars.RUNTIME_PLACEMENTS_JSON)).toEqual([
      { placementId: "mana-accounting", channelId: "C0BKS6RL99T", channelName: "9960-back-office", projectCodes: ["back-office"], taskWriteEnabled: true, taskBoardEnabled: true,
        taskInventoryAllowedUserIds: ["U088D1HBY6L", "U0BKP8D3KPD"] },
      { placementId: "biz-meeting-router", channelId: "C0BKTFQ9V38", projectCodes: ["unson"], taskWriteEnabled: true },
      { placementId: "minutes-baao-growin", channelId: "C0BKTFU9YS2", projectCodes: ["baao"], taskBoardEnabled: true },
      { placementId: "minutes-zeims", channelId: "C0BKE4CM25V", projectCodes: ["zeims"], taskBoardEnabled: true },
      { placementId: "minutes-ncom-catalyst", channelId: "C0BKP89E79R", projectCodes: ["ncom"], taskBoardEnabled: true },
      { placementId: "minutes-legal-affairs", channelId: "C0BKZ6CF3J8", projectCodes: ["unson"], taskBoardEnabled: true },
      { placementId: "minutes-cursorvers", channelId: "C0BHVFJGFK3", projectCodes: ["unson"], taskBoardEnabled: true },
      { placementId: "minutes-kartz", channelId: "C0BQA5BGTEH", projectCodes: ["kartz"], taskBoardEnabled: true },
      { placementId: "minutes-unson-board", channelId: "C0BKXCVSDCH", projectCodes: ["unson"], taskBoardEnabled: true },
      {
        placementId: "mana-dev-biz",
        channelId: "C0BMNSP6C80",
        channelName: "0240-mana-dev",
        projectCodes: ["mana"],
        taskWriteEnabled: true,
        taskBoardEnabled: true,
        developmentEnabled: true,
        taskInventoryChannelIds: ["C0BMNSP6C80", "C0BKS6RL99T"],
        taskInventoryAllowedUserIds: ["U088D1HBY6L", "U0BKP8D3KPD"],
        audience: { type: "operator", allowedUserIds: ["U088D1HBY6L", "U0BKP8D3KPD"] },
        agent: { model: "sonnet", escalationEmployee: "critical-reviewer" },
        runtimeContext: {
          persona: "Ryoko（佐藤圭吾のパーソナルAIアシスタント兼AI組織のCOO）",
          instructions: ["結論を先に日本語で簡潔かつ具体的に答える", "確認できないことは推測せず不確実性を正直に伝える", "利用者の意図を先読みして次の行動を提案する"],
          skills: ["cron-manager", "find-and-install", "management", "migrate", "new", "onboarding", "self-heal", "skill-creator", "status", "sync"],
        },
        respondTo: { im: "always", mpim: "mention", channel: "mention", engagedThreads: true },
        capabilities: {
          mcp: ["brainbase", "nocodb", "gateway", "google-drive"],
          gatewayTools: [
            "send_message", "create_task", "list_tasks", "search_tasks", "list_authorized_task_channels", "list_tasks_across_channels", "search_tasks_across_channels", "update_task", "transition_task",
            "list_sessions", "get_session", "list_employees", "get_employee",
          ],
        },
        dataScopes: { graph: { mode: "read-only", scopes: ["org:unson"] } },
        deliveryScopes: [{ connector: "slack", channelId: "C0BMNSP6C80" }],
      },
      {
        placementId: "mana-autonomy",
        channelId: "C0BKE4D0TK9",
        channelName: "mana-autonomy",
        projectCodes: ["brainbase"],
        taskWriteEnabled: true,
        taskBoardEnabled: true,
        capabilities: { mcp: ["brainbase"], gatewayTools: [] },
      },
    ]);
  });

  it("passes the actual unson-business Wrangler config through deployment preflight", () => {
    expect(assessTenantRuntimeDeploymentConfig(unson, [
      "SLACK_SIGNING_SECRET",
      "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
      "DEVELOPMENT_CALLBACK_TOKEN",
      "BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN",
    ])).toEqual({ ready: true, missing_bindings: [] });
  });

  it("allows the authorized operator through company authority in the mana project channel", () => {
    expect(JSON.parse(unson.vars.MANA_COMPANY_AUTHORITY_SLACK_ROLLOUT_JSON)).toContainEqual({
      workspace_id: "T0882T8N9UH",
      channel_id: "C0BMNSP6C80",
      authenticated_subject_id: "U088D1HBY6L",
    });
  });

  it("keeps every same-tenant task board target inside an enabled runtime placement", () => {
    const targets = JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON) as Array<{
      organizationId: string; workspaceId: string; channelId: string; projectCodes: string[]; enabled: boolean;
    }>;
    const placements = JSON.parse(unson.vars.RUNTIME_PLACEMENTS_JSON) as Array<{
      channelId: string; projectCodes: string[]; taskBoardEnabled?: boolean;
    }>;
    const uncovered = targets.filter((target) => target.enabled
      && target.organizationId === unson.vars.TENANT_ID
      && target.workspaceId === unson.vars.SLACK_EXPECTED_TEAM_ID
      && !placements.some((placement) => placement.taskBoardEnabled
        && placement.channelId === target.channelId
        && placement.projectCodes.length === target.projectCodes.length
        && placement.projectCodes.every((project) => target.projectCodes.includes(project))));

    expect(uncovered).toEqual([]);
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
    expect(dockerfile).toContain(
      "COPY --chmod=0555 container/brainbase-judgment-hook.mjs /opt/mana/brainbase-judgment-hook.mjs",
    );
    expect(dockerfile).toContain(
      "COPY --chmod=0444 container/meeting-minutes-claude-settings.json /opt/mana/meeting-minutes-claude-settings.json",
    );
  });

  it("mana-reply-judgment-hook-503:ac:4 packages reply Judgment settings", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8");
    expect(dockerfile).toContain(
      "COPY --chmod=0444 container/reply-claude-settings.json /opt/mana/reply-claude-settings.json",
    );
  });

  it("開発ランナーはコンテナ内で実在するNode実行ファイルを継承する", () => {
    const runnerPath = fileURLToPath(new URL("../../container/cloudflare-development-runner.mjs", import.meta.url));
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain('run(process.execPath, ["/opt/mana/openryoko-development-runner.mjs"]');
    expect(runner).not.toContain('run("/usr/bin/node"');
  });

  it("開発ランナーは内側ランナーの厳格な新規Story入力契約だけを渡す", () => {
    const runnerPath = fileURLToPath(new URL("../../container/cloudflare-development-runner.mjs", import.meta.url));
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain('stdin: JSON.stringify({ request: job.request })');
    expect(runner).not.toContain('stdin: JSON.stringify({ mode: "new", request: job.request })');
  });

  it("開発エージェントへ検証済みtenant operation boundaryだけを渡す", () => {
    const runnerPath = fileURLToPath(new URL("../../container/openryoko-development-runner.mjs", import.meta.url));
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain('IS_SANDBOX: "1"');
    expect(runner).toContain("MANA_TENANT_BOUNDARY_HANDLE: tenantBoundaryHandle");
    expect(runner).toContain('throw new Error("tenant_boundary_required")');
    expect(runner).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(runner).toContain("extraEnv: sandboxAgentEnv");
  });

  it("両Cloudflare profileをBrainbase専用internal serviceへbindする", () => {
    for (const config of [techKnight, unson]) {
      expect(config.services).toContainEqual({
        binding: "BRAINBASE_TENANT_RUNTIME_SERVICE",
        service: "brainbase-tenant-runtime",
      });
    }
  });

  it("provider資格情報をCloudflare Worker secretとして設定する手順を残さない", () => {
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).not.toMatch(
      /wrangler secret put (?:SLACK_BOT_TOKEN|BRAINBASE_TASK_API_TOKEN)\b/,
    );
    expect(readme).not.toContain("Bot tokenを`SLACK_BOT_TOKEN` Secretとして設定");
    expect(readme).not.toContain("`BRAINBASE_TASK_API_TOKEN` Secretとして設定");
    expect(readme).toContain("mana-runtimeへBrainbase service tokenを保持させない");
    expect(readme).toContain("認証JWTはBrainbase側のbridgeが注入する");
  });

  it("開発エージェントもplacement既定と同じsonnetを明示して起動する", () => {
    const runnerPath = fileURLToPath(new URL("../../container/openryoko-development-runner.mjs", import.meta.url));
    const configPath = fileURLToPath(new URL("../../container/openryoko-development-runner.json", import.meta.url));
    const runner = readFileSync(runnerPath, "utf8");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { claudeModel?: string };
    expect(config.claudeModel).toBe("sonnet");
    expect(runner).toContain('return ["--print", "--model", model, "--permission-mode", "bypassPermissions", prompt]');
    expect(runner).not.toContain("--dangerously-skip-permissions");
    expect(runner).toContain("buildAgentArgs(buildAgentPrompt(storyId, request, baseBranch), config.claudeModel)");
    expect(runner).toContain("safeCommandDiagnostic(stderr || stdout)");
    expect(runner).toContain('Bearer [REDACTED]');
  });

  it("開発ランナーの検証用commitに固定の非個人Git identityを設定する", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8");
    expect(dockerfile).toContain('git config --system user.name "Mana Development Runner"');
    expect(dockerfile).toContain('git config --system user.email "mana-development-runner@unson.jp"');
  });

  it("開発ランナーは秘密値を返さず停止コマンドと終了コードだけを診断に残す", () => {
    const runner = readFileSync(fileURLToPath(new URL("../../container/cloudflare-development-runner.mjs", import.meta.url)), "utf8");
    expect(runner).toContain("safeRunnerFailureReason(result.stderr, result.code)");
    expect(runner).toContain("/^[a-z0-9._/-]+ exited with code [0-9]+$/i");
    expect(runner).not.toContain("summary: result.stderr");
  });

  it("開発ランナーは外側watchdogより先に停止してterminal callbackを試行する", () => {
    const runner = readFileSync(fileURLToPath(new URL("../../container/cloudflare-development-runner.mjs", import.meta.url)), "utf8");
    expect(runner).toContain("job.runner_timeout_ms");
    expect(runner).toContain("result.timedOut");
    expect(runner).toContain("AbortSignal.timeout(CALLBACK_TIMEOUT_MS)");
    expect(runner).toContain('child.kill("SIGTERM")');
    expect(runner).toContain('child.kill("SIGKILL")');
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

  it("keeps production Slack Judgment evidence open until a fresh deployed event is collected", () => {
    const architecturePath = fileURLToPath(new URL(
      "../../../../docs/architecture/story-slack-mention-brainbase-judgment.md",
      import.meta.url,
    ));
    const architecture = readFileSync(architecturePath, "utf8");
    expect(architecture).toContain("fresh Slack event");
    expect(architecture).toContain("episode receipt");
    expect(architecture).toContain("`response_ts`");
    expect(architecture).toContain("本Storyの実装だけでは本番配備とAC10の利用者成果確認を完了扱いにしない");
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

  it("keeps Sandbox internet off with only explicit runtime proxy hosts", () => {
    const sandboxPath = fileURLToPath(new URL("../sandbox-runtime.ts", import.meta.url));
    const sandboxRuntime = readFileSync(sandboxPath, "utf8");
    const runner = readFileSync(fileURLToPath(
      new URL("../../container/cloudflare-development-runner.mjs", import.meta.url),
    ), "utf8");
    expect(sandboxRuntime).toContain("enableInternet = false");
    expect(sandboxRuntime).toContain('allowedHosts = ["api.anthropic.com", "github.com", DEVELOPMENT_CALLBACK_PROXY_HOST, TASK_SEARCH_PROXY_HOST');
    expect(sandboxRuntime).not.toContain('"github-basic"');
    expect(sandboxRuntime).not.toContain("credential_header");
    expect(sandboxRuntime).toContain("authorizeTenantProviderOutbound(");
    const tenantProviderOutbound = readFileSync(fileURLToPath(
      new URL("../multitenancy/tenant-provider-outbound.ts", import.meta.url),
    ), "utf8");
    expect(tenantProviderOutbound).toContain("createTenantCredentialFetch({");
    expect(sandboxRuntime).not.toContain("env.GITHUB_TOKEN");
    const workerRuntime = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(workerRuntime).not.toContain('audience: "github.com"');
    expect(workerRuntime).not.toContain("githubCredentialLeaseHandle");
    expect(workerRuntime).toContain("GITHUB_TOKEN?: string");
    expect(workerRuntime).toContain('env.GITHUB_TOKEN ?? ""');
    expect(workerRuntime).not.toContain("token: env.BRAINBASE_TASK_API_TOKEN");
    expect(workerRuntime).toContain("createMeetingMinutesTaskDeleter({");
    expect(workerRuntime).not.toContain("undefined, credentialFetch).save(input)");
    expect(workerRuntime).not.toContain("undefined, credentialFetch).delete(destination.github, paths)");
    expect(workerRuntime).not.toContain("taskClient(credentialFetch).getTask(taskId)");
    expect(sandboxRuntime).toContain('[DEVELOPMENT_CALLBACK_PROXY_HOST]: async (request: Request, env: SandboxRuntimeEnv)');
    expect(sandboxRuntime).toContain("[TASK_SEARCH_PROXY_HOST]: (request, env: SandboxRuntimeEnv)");
    expect(sandboxRuntime).toContain("[TASK_WRITE_PROXY_HOST]: (request, env: SandboxRuntimeEnv)");
    expect(sandboxRuntime).toContain("resolveDurableTenantBoundaryContext(");
    expect(sandboxRuntime).toContain(
      "SLACK_EXPECTED_TEAM_ID: resolved.tenant_context.workspace_connection.workspace_id",
    );
    expect(tenantProviderOutbound).toContain("createTenantCredentialFetch({");
    expect(sandboxRuntime).toContain("createRuntimeGatewayProxyHandler(credentialFetch, {");
    expect(sandboxRuntime).toContain("deliverTenantGatewaySlackMessage");
    const runtimeGatewayStart = sandboxRuntime.indexOf("[RUNTIME_GATEWAY_PROXY_HOST]:");
    expect(runtimeGatewayStart).toBeGreaterThan(-1);
    expect(sandboxRuntime).toContain("runtimeGatewayBoundaries(request)");
    expect(runner).toContain('"x-mana-tenant-boundary-handle"');
    expect(runner).toContain('status: "timed_out"');
    expect(sandboxRuntime).not.toContain("handleRuntimeGatewayProxyRequest(authorized, env)");
    expect(sandboxRuntime).toContain('"mcp_gateway"');
    expect(sandboxRuntime).toContain('"brainbase_proxy"');
    expect(sandboxRuntime).toContain("[RUNTIME_GATEWAY_PROXY_HOST]: async (request, env: SandboxRuntimeEnv)");
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

  it("議事録処理中も通常Slack返信を並行実行できる", () => {
    expect(unson.containers[0]?.max_instances).toBeGreaterThanOrEqual(2);
    expect(unson.queues.consumers[0]?.max_concurrency).toBeGreaterThanOrEqual(2);
  });

  it("通常返信と議事録の実行中も開発コマンド用Containerを確保できる", () => {
    // 議事録と開発処理が各1台を保持したまま通常返信が開始する。
    // Cloudflareが旧版の実体も一時保持するため、新旧両世代の枠を確保する。
    expect(unson.containers[0]?.max_instances).toBeGreaterThanOrEqual(6);
  });

  it("雲孫deploymentが専用Worker namespace内にDurable ObjectとContainerを持つ", () => {
    expect(unson.durable_objects.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TECHKNIGHT_WORKSPACE" }),
        expect.objectContaining({ name: "TECHKNIGHT_SANDBOX" }),
        expect.objectContaining({ name: "TASK_WRITE_BUDGETS", class_name: "TaskWriteBudget" }),
        expect.objectContaining({ name: "MEETING_MINUTES_WORKSPACE", class_name: "MeetingMinutesWorkspace" }),
        expect.objectContaining({ name: "MEETING_MINUTES_DEPLOYMENT_GATE", class_name: "MeetingMinutesDeploymentGate" }),
        expect.objectContaining({ name: "TASK_BOARD_BINDINGS", class_name: "TaskBoardBinding" }),
      ]),
    );
    expect(unson.containers).toEqual([
      expect.objectContaining({ class_name: "TechKnightSandbox" }),
    ]);
    expect(unson.name).toBe("unson-business-mana-runtime");
  });

  it("enables Cloudflare meeting minutes with the confirmed cutover authority", () => {
    expect(unson.vars.MEETING_MINUTES_ENABLED).toBe("true");
    expect(unson.vars.MEETING_MINUTES_CONTEXT_MODE).toBe("required");
    const routerPlacement = (JSON.parse(unson.vars.RUNTIME_PLACEMENTS_JSON) as Array<{
      placementId: string; projectCodes: string[];
    }>).find((placement) => placement.placementId === "biz-meeting-router");
    expect(routerPlacement?.projectCodes).toEqual(["unson"]);
    // Slack ingress starts from the stable project alias, while the signed
    // tenant context returns the canonical authority project ID. Queue scope
    // validation must compare against that same canonical ID.
    expect(JSON.parse(unson.vars.RUNTIME_AUTHORITY_PROJECT_IDS_JSON)).toEqual({
      "biz-meeting-router": ["prj_01KGCS8C1PSSXPHXPBX1D4CKDT"],
      "minutes-ncom-catalyst": ["prj_01KGHVCMA6R6A9MEMGKHRXQ5J0"],
      "mana-dev-biz": ["prj_01KGHVCMA35JHSMXTSWQAS04PS"],
    });
    expect(JSON.parse(unson.vars.BRAINBASE_JUDGMENT_AUTHORITY_PROJECTS_JSON)).toEqual({
      prj_01KGHVCMA35JHSMXTSWQAS04PS: "mana",
    });
    expect(JSON.parse(unson.vars.MEETING_MINUTES_AUTHORITY_PROJECT_IDS_JSON)).toEqual({
      unson: "prj_01KGCS8C1PSSXPHXPBX1D4CKDT",
      techknight: "prj_01M1DDJ9V6EER4676YPXBSHBZX",
      ncom: "prj_01KGHVCMA6R6A9MEMGKHRXQ5J0",
      brainbase: "prj_01KGCS8CAJKKDWACPNK1E5WX8H",
      "back-office": "prj_01M04XZFSN3TWRE2K05MTD898P",
      mana: "prj_01KGHVCMA35JHSMXTSWQAS04PS",
    });
    expect(unson.vars.MEETING_MINUTES_ROUTER_CHANNEL_ID).toBe("C0BKTFQ9V38");
    expect(unson.vars.MEETING_MINUTES_OPERATOR_USER_IDS).toBe("U088D1HBY6L,U0BKP8D3KPD,U07B19N048G");
    for (const name of ["MEETING_MINUTES_DESTINATIONS_JSON", "MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON"]) {
      expect(new TextEncoder().encode(unson.vars[name]).byteLength, `${name} exceeds Cloudflare's 5 KiB text binding limit`)
        .toBeLessThanOrEqual(5_120);
    }
    const destinations = [
      ...JSON.parse(unson.vars.MEETING_MINUTES_DESTINATIONS_JSON),
      ...JSON.parse(unson.vars.MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON),
    ];
    expect([...new Map(destinations.map((item: { organization: { id: string; name: string } }) =>
      [item.organization.id, item.organization.name])).entries()]).toEqual([
      ["unson-business", "雲孫 事業運営"], ["tech-knight", "Tech Knight"], ["unson", "雲孫"],
    ]);
    expect(destinations).toHaveLength(23);
    expect(destinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "back-office", projectId: "proj_back_office", slackChannelId: "C0BKS6RL99T",
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "back_office", pathPrefix: "meetings/" }) }),
      expect.objectContaining({ id: "legal-affairs", projectId: "proj_legal_affairs",
        contextProjectCode: "unson", taskProjectCodes: ["unson"],
        taskBoardTargetId: "minutes-legal-affairs", name: "Legal Affairs", slackChannelId: "C0BKZ6CF3J8",
        organization: { id: "unson-business", name: "雲孫 事業運営" },
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "Drive", branch: "main",
          pathPrefix: "meetings/legal-affairs/" }) }),
      expect.objectContaining({ id: "brainbase", projectId: "proj_brainbase", slackChannelId: "C0BKE4D0TK9",
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "brainbase-unson", branch: "develop" }) }),
      expect.objectContaining({ id: "techknight-board", projectId: "proj_techknight_board", slackChannelId: "C0A2RB6803B",
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "tech-knight-project" }) }),
      expect.objectContaining({ id: "techknight-executives", projectId: "proj_techknight_executives", name: "役員",
        contextProjectCode: "techknight", taskProjectCodes: ["proj_techknight_board"],
        taskBoardTargetId: "minutes-techknight-executives", slackChannelId: "C08UXAH41U4",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: { owner: "Tech-Knight-inc", repo: "tech-knight-project", branch: "main",
          pathPrefix: "meetings/executives/" } }),
      expect.objectContaining({ id: "aitel", projectId: "proj_aitel", name: "Aitel", slackChannelId: "C0A489A4EFJ",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "smartfront", pathPrefix: "meetings/" }) }),
      expect.objectContaining({ id: "council", projectId: "proj_council", name: "評議会", slackChannelId: "C0BK7MP0N7L",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "tech-knight-project", pathPrefix: "meetings/council/" }) }),
      expect.objectContaining({ id: "pms", projectId: "proj_pms", name: "PMS", slackChannelId: "C0BKX9Y169F",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "tech-knight-project", pathPrefix: "meetings/pms/" }) }),
      expect.objectContaining({ id: "senpainurse", projectId: "proj_senpainurse",
        contextProjectCode: "senpainurse", taskProjectCodes: ["senpainurse"],
        taskBoardTargetId: "minutes-senpainurse", slackChannelId: "C0A9J7UV1KL",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "senpainurse", pathPrefix: "meetings/" }) }),
      expect.objectContaining({ id: "salestailor", projectId: "proj_salestailor", slackChannelId: "C0A9ESC81UZ",
        organization: { id: "unson", name: "雲孫" },
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "salestailor-project", pathPrefix: "meetings/" }) }),
      expect.objectContaining({ id: "baao", projectId: "proj_baao", slackChannelId: "C08K58SUQ7N",
        organization: { id: "unson", name: "雲孫" },
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "baao-project", pathPrefix: "meetings/" }) }),
      expect.objectContaining({ id: "yakumokai", projectId: "proj_yakumokai", slackChannelId: "C08FSSHHAU9",
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "Drive", pathPrefix: "meetings/yakumokai/" }) }),
      expect.objectContaining({ id: "other-meetings", projectId: "proj_other", slackChannelId: "C0A2L9FEKEJ",
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "Drive", pathPrefix: "meetings/other/" }) }),
      expect.objectContaining({ id: "cursorvers", projectId: "proj_otawara_cursorvers", slackChannelId: "C0BHVFJGFK3",
        organization: { id: "unson-business", name: "雲孫 事業運営" },
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "Drive", pathPrefix: "meetings/cursorvers/" }) }),
      expect.objectContaining({ id: "kartz", projectId: "proj_kartz", contextProjectCode: "kartz",
        taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz",
        slackChannelId: "C0BQA5BGTEH",
        organization: { id: "unson-business", name: "雲孫 事業運営" },
        github: expect.objectContaining({ owner: "Unson-LLC", repo: "Drive", pathPrefix: "meetings/kartz/" }) }),
      expect.objectContaining({ id: "united", projectId: "proj_united", slackChannelId: "C0A4RB7739D",
        organization: { id: "tech-knight", name: "Tech Knight" },
        github: expect.objectContaining({ owner: "Tech-Knight-inc", repo: "HotelUnitedGAS", pathPrefix: "meetings/" }) }),
    ]));
    expect(JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON)).toContainEqual(expect.objectContaining({
      targetId: "minutes-kartz", channelId: "C0BQA5BGTEH", projectCodes: ["kartz"],
    }));
    expect(destinations).toContainEqual(expect.objectContaining({
      id: "unson-board",
      organization: { id: "unson-business", name: "雲孫 事業運営" },
      slackChannelId: "C0BKXCVSDCH",
      github: { owner: "Unson-LLC", repo: "Drive", branch: "main", pathPrefix: "meetings/unson-board/" },
    }));
    expect(JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON)).toContainEqual(expect.objectContaining({
      targetId: "minutes-unson-board", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
      channelId: "C0BKXCVSDCH", projectCodes: ["unson"],
    }));
    expect(JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON)).toContainEqual(expect.objectContaining({
      targetId: "minutes-legal-affairs", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
      channelId: "C0BKZ6CF3J8", projectCodes: ["unson"],
    }));
    expect(JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON)).toContainEqual(expect.objectContaining({
      targetId: "minutes-senpainurse", channelId: "C0A9J7UV1KL", projectCodes: ["senpainurse"],
    }));
    expect(JSON.parse(unson.vars.TASK_BOARD_TARGETS_JSON)).toContainEqual(expect.objectContaining({
      targetId: "minutes-techknight-executives", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB",
      channelId: "C08UXAH41U4", projectCodes: ["proj_techknight_board"],
    }));
    expect(destinations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "smartfront" }),
      expect.objectContaining({ name: "SmartFront" }),
    ]));
    expect(unson.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "v4", new_sqlite_classes: ["MeetingMinutesWorkspace"] }),
      expect.objectContaining({ tag: "v7", new_sqlite_classes: ["MeetingMinutesDeploymentGate"] }),
      expect.objectContaining({ tag: "v8", new_sqlite_classes: ["TaskBoardBinding"] }),
    ]));
    const raw = readFileSync(fileURLToPath(new URL("../../wrangler.unson-business.jsonc", import.meta.url)), "utf8");
    expect(raw.match(/"BRAINBASE_WORKSPACE_CONNECTIONS_JSON"/g) ?? []).toHaveLength(1);
    expect(raw).not.toContain('"GITHUB_TOKEN":');
  });

  it("wires signed interactions and meeting-minutes Queue handling without removing task entrypoints", () => {
    const worker = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(worker).toContain('url.pathname === "/slack/interactions"');
    expect(worker).toContain("handleMeetingMinutesInteractionEntrypoint(request");
    expect(worker).toContain("createTenantInteractionEffectResolver(env)");
    expect(worker).toContain("createMeetingMinutesTenantEffectGuard({");
    expect(worker).toContain("preflightMeetingMinutesDestinationSlackBindings");
    expect(worker).toContain("effects.preflightDestinationSlack(destinations)");
    const guardStart = worker.indexOf("function createMeetingMinutesTenantEffectGuard(");
    const guardEnd = worker.indexOf("function meetingMinutesClients(", guardStart);
    const guard = worker.slice(guardStart, guardEnd);
    expect(guard).toContain("tenantRuntimeClients(\n    input.env, input.tenant_context,");
    expect(guard).not.toContain("tenantRuntimeClients(input.env);");
    expect(guard.indexOf("resolveMeetingMinutesDestinationSlackBinding")).toBeGreaterThanOrEqual(0);
    expect(guard.indexOf("resolveMeetingMinutesDestinationSlackBinding")).toBeLessThan(
      guard.indexOf("resolveDerivedSlackTenantContext"),
    );
    expect(guard).toContain("app_id: appId");
    expect(worker).not.toContain("meetingMinutesClients(env)");
    expect(worker).not.toContain("env.TENANT_ID, env.SLACK_EXPECTED_TEAM_ID, runId");
    expect(worker).toContain('release: "on_expiration"');
    expect(worker).toContain("isTenantMeetingMinutesSelectionBody(message.body)");
    expect(worker).toContain("isTenantMeetingMinutesRedoBody(message.body)");
    expect(worker).toContain("isTenantMeetingMinutesRecoveryBody(message.body)");
    expect(worker).toContain("expectedTenantMeetingMinutesRedoScope(env, tenantBody)");
    expect(worker).toContain("meetingMinutesRecoveryProjectScope(body.tenant_context)");
    expect(worker).toContain("readAuthoritativeSnapshot: (runtimeEnv, tenantContext, connectionId)");
    expect(worker).toContain("executeSlack: ({ env: runtimeEnv, effectId, event, tenantContext");
    expect(worker).toContain("isMeetingMinutesRecovery(message.body)");
    expect(worker).toContain("armMeetingMinutesRecovery(");
    expect(worker).toContain('from "./meeting-minutes-recovery-production.js"');
    expect(worker).toContain("handleMeetingMinutesRecoveryQueue(");
    expect(worker).toContain("gateMeetingMinutesRouterQueueMessage(");
    expect(worker).toContain("gateMeetingMinutesCommandQueueMessage(");
    expect(worker).toContain("postIntakePausedToUser(command.channelId, command.userId, command.runId)");
    expect(worker).toContain("resolveSlackWorkerIngress({");
    expect(worker).toContain("meetingMinutesRecoveryEventId(recovery)");
    expect(worker).toContain('{ event: "meeting_minutes_recovery_failed", code: "FALLBACK_FORBIDDEN" }');
    expect(worker).toContain("isMeetingMinutesSlackEvent(tenantBody.payload, meetingMinutesConfig)");
    expect(worker).toContain("const childEventId = await childInteractionEventId(event.eventId, `meeting-minutes-file:${file.id}`)");
    expect(worker).toContain("const runId = `${childEvent.eventId}_${file.id}`");
    expect(worker).toContain('"https://tenant-runtime.internal", undefined,');
    expect(worker).toContain("env.BRAINBASE_TENANT_RUNTIME_SERVICE?.fetch.bind(env.BRAINBASE_TENANT_RUNTIME_SERVICE)");
    expect(worker).toContain("destination.projectId === projectId");
    expect(worker).toContain("destination.contextProjectCode === identity.project_code");
    expect(worker).toContain("tenantContext).resolve(identity, receiptId)");
    expect(worker).toContain("const childTenantContext = await resolveDerivedSlackTenantContext");
    expect(worker).toContain("tenant_context: childTenantContext");
    const ingestionStart = worker.indexOf("if (isMeetingMinutesSlackEvent(tenantBody.payload, meetingMinutesConfig))");
    const ingestionEnd = worker.indexOf("const ordinaryEvent = tenantBody.payload", ingestionStart);
    const ingestion = worker.slice(ingestionStart, ingestionEnd);
    expect(ingestion).not.toContain("withTenantCredentialLease({");
    expect(worker).toContain("processMeetingMinutesSelectionWithStatus(");
    expect(worker).not.toContain("credentialLeaseHandle");
    expect(worker).toContain("executeTenantContainerOperationWithRegistry({");
    expect(worker).toContain("namespace: env.TENANT_RUNTIME_STATE");
    expect(worker).toContain("tenantRuntimeClients(this.env, input.tenant_context,");
    expect(worker).not.toContain("const clients = tenantRuntimeClients(this.env);");
    expect(worker).toContain("processMeetingMinutesSlackEvent(");
    expect(worker).toContain("issueTaskWriteRequestContext(");
    expect(worker).toMatch(
      /issueTaskWriteRequestContext\(\s*event,\s*env,\s*Date\.now\(\),\s*placement,\s*requesterResolution\.personId,\s*\)/,
    );
    expect(worker).toContain("classifyMeetingMinutesDestinationInSandbox(");
    expect(worker).toContain("download: (fileId) => meetingClients.slack.downloadTextFile(fileId)");
    expect(worker).toContain("classifyDestination: (transcript, destinations) => meetingClients.classify(transcript, destinations)");
    expect(worker).toContain("resolveCrossWorkspaceMeetingMinutesSlackToken");
    expect(worker).toContain("destinationToken");
    expect(worker).toContain("credentialFetch");
    expect(worker).toContain("destinations.find((candidate) => candidate.slackChannelId === channelId)");
    expect(worker).toContain("isTenantTaskBoardRepairBody(message.body)");
    expect(worker).toContain("expectedTenantTaskBoardRepairScope(env, tenantBody)");
    expect(worker).toContain("processTaskBoardRepair(repair, env, runtimeTenantId, tenantCredentialFetch,");
    expect(worker).toContain('{ event: "task_board_repair_failed", code: "FALLBACK_FORBIDDEN" }');
    expect(worker.match(/tenantRuntimeClients\(env, tenantBody\.tenant_context,/g)).toHaveLength(4);
    expect(worker).toContain("tenantRuntimeClients(runtimeEnv, tenantContext,");
  });

  it("fails deployment closed behind the authenticated meeting-minutes drain gate", () => {
    const packageJson = JSON.parse(readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    )) as { scripts: Record<string, string> };
    expect(packageJson.scripts["deploy:unson-business"]).toContain("node scripts/deploy-unson-business.mjs");
    const worker = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(worker).toContain('url.pathname === "/admin/meeting-minutes/deploy-gate"');
    expect(worker).toContain("/admin\\/reply-judgment\\/episodes");
    expect(worker).toContain("readReplyJudgmentEpisode(workspace.fs");
    expect(worker).toContain('url.searchParams.get("tenant_id")');
    expect(worker).toContain('env.TENANT_RUNTIME_STATE, request, ["brainbase_proxy"]');
    expect(worker).toContain("tenantId !== tenantContext.tenant.tenant_id");
    expect(worker).toContain("workspaceId !== tenantContext.workspace_connection.workspace_id");
    expect(worker).toContain("channelId !== tenantContext.slack.channel_id");
    expect(worker).toContain("threadTs !== tenantContext.slack.thread_ts");
    expect(worker).toContain('error: "reply_judgment_scope_mismatch"');
    expect(worker).toContain('url.pathname === "/admin/meeting-minutes/intake"');
    expect(worker).toContain("/admin\\/meeting-minutes\\/runs");
    expect(worker).toContain("/authorized-retry$");
    expect(worker).toContain("/authorized-status$");
    expect(worker).toContain("meetingMinutesAdminRunStatus(run)");
    expect(worker).toContain("reissueMeetingMinutesAdminSelectionTenantContext(env, run, selection)");
    expect(worker).toContain("const clients = tenantRuntimeClients(env, undefined,\n    tenantConfiguredDesiredEffectByCapability(env));");
    expect(worker).toContain('error: "meeting_minutes_admin_retry_not_authorized"');
    expect(worker).toContain('error: "meeting_minutes_admin_retry_outcome_case_invalid"');
    expect(worker).toContain("OUTCOME_CASE_ID_PATTERN.test(payload.outcomeCaseId)");
    expect(worker).toContain('outcomeCaseSource: "admin_authorized_retry" as const');
    expect(worker).toContain('error: "meeting_minutes_task_adoption_outcome_case_forbidden"');
    expect(worker).toContain('event_id: meetingMinutesSelectionEventId(selection)');
    expect(worker).toContain("isIntakePaused()");
    expect(worker).toContain("isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN)");
    expect(worker).toContain("env, requiredRuntimeBinding(env.TENANT_ID),\n      ).status()");
    expect(worker).toContain("registeredCount: run.taskRegistration?.registered.length ?? 0");
    expect(worker).toContain("pendingPresent: Boolean(run.taskRegistration?.pending)");
    expect(worker).toContain("failure: run.taskRegistration?.failure");
    expect(worker).toContain("failedCandidateTitle: run.taskRegistration?.failure");
    expect(worker).toContain("sourceStatus: { outcome: run.statusProjection?.outcome");
    expect(worker).toContain("outcomeCaseId: run.outcomeCaseId");
    expect(worker).toContain("runReceipt: run.runReceipt ? { caseId: run.runReceipt.caseId, receiptId: run.runReceipt.receiptId,");
    expect(worker).toContain("status: run.runReceipt.status, deliveredAt: run.runReceipt.deliveredAt }");
    const retryWorkflow = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/retry-meeting-minutes.yml", import.meta.url)), "utf8");
    expect(retryWorkflow).toContain("      outcome_case_id:");
    expect(retryWorkflow).toContain("        required: false");
    expect(retryWorkflow).toContain("          OUTCOME_CASE_ID: ${{ inputs.outcome_case_id }}");
    expect(retryWorkflow).toContain(
      '          [[ -z "$OUTCOME_CASE_ID" || "$OUTCOME_CASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$ ]]',
    );
    expect(retryWorkflow).toContain(
      '              def safe_identifier_or_null: if type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$") then . else null end;',
    );
    expect(retryWorkflow).toContain("                outcomeCaseId: (.outcomeCaseId | safe_identifier_or_null),");
    expect(retryWorkflow).toContain("                    caseId: (.runReceipt.caseId | safe_identifier_or_null),");
    expect(retryWorkflow).toContain("                    receiptId: (.runReceipt.receiptId | safe_identifier_or_null),");
    expect(retryWorkflow).toContain('                    status: (.runReceipt.status | one_of(["pending","delivered"])),');
    expect(retryWorkflow).toContain("          baseline_outcome_case_id=\"$(jq -r '.outcomeCaseId // \"\"' \"$response_file\")\"");
    expect(retryWorkflow).toContain('          expected_outcome_case_id="$OUTCOME_CASE_ID"');
    expect(retryWorkflow).toContain('              --arg outcomeCaseId "$expected_outcome_case_id"');
    expect(retryWorkflow).toContain(
      "              '{tenantId:$tenantId,workspaceId:$workspaceId,actionTs:$actionTs,outcomeCaseId:$outcomeCaseId}')",
    );
    const retryBodyStart = retryWorkflow.indexOf('            --data "$(jq -cn');
    const retryBodyEnd = retryWorkflow.indexOf(
      '            "https://unson-business-mana-runtime',
      retryBodyStart,
    );
    expect(retryBodyStart).toBeGreaterThan(-1);
    expect(retryBodyEnd).toBeGreaterThan(retryBodyStart);
    expect(retryWorkflow.slice(retryBodyStart, retryBodyEnd)).not.toContain("SANDBOX_PROBE_TOKEN");
    expect(retryWorkflow).not.toContain('echo "$SANDBOX_PROBE_TOKEN"');
    expect(retryWorkflow).not.toContain("jq -n --arg token \"$SANDBOX_PROBE_TOKEN\"");
    expect(retryWorkflow).toContain("baseline_source_projected_at");
    expect(retryWorkflow).toContain('.sourceStatus.outcome == "completed"');
    expect(retryWorkflow).toContain(".sourceStatus.projectedAt != $baselineSourceProjectedAt");
    expect(retryWorkflow).toContain(".sourceStatus.projectionFailure == null");
    expect(retryWorkflow).toContain('.sourceStatus.outcome != "completed"');
    expect(retryWorkflow).toContain(".outcomeCaseId == $expectedOutcomeCaseId");
    expect(retryWorkflow).toContain('.runReceipt.status == "delivered"');
    expect(retryWorkflow).toContain(".runReceipt.caseId == $expectedOutcomeCaseId");
    expect(retryWorkflow).toContain("if ! jq -e '.checkpoint.hasGitHub == true and .checkpoint.hasSlackParent == true");
    expect(retryWorkflow).toContain("Fresh retry remained pending until the polling deadline");
    const pendingDeadline = retryWorkflow.indexOf("Fresh retry remained pending until the polling deadline");
    expect(pendingDeadline).toBeGreaterThan(-1);
    expect(retryWorkflow.lastIndexOf('if [[ "$attempt" == "90" ]]', pendingDeadline)).toBeLessThan(
      retryWorkflow.indexOf("sleep 10\n                continue", pendingDeadline),
    );
    expect(retryWorkflow).toContain("failurePoint: (.failurePoint");
    expect(retryWorkflow).toContain("scopeReason: (if .scopeReason");
    expect(worker).toContain('runAdminMatch[2] === "/adopt-tasks"');
    expect(worker).toContain("meeting_minutes_task_adoption_scope_mismatch");
    expect(worker).toContain("const incompleteAdoption =");
    expect(packageJson.scripts["meeting-minutes:intake:pause"]).toContain("meeting-minutes-intake-control.mjs pause");
    expect(packageJson.scripts["meeting-minutes:intake:resume"]).toContain("meeting-minutes-intake-control.mjs resume");
  });

  it("binds a durable write budget in every deployment and wires all task runtime entrypoints", () => {
    for (const config of [techKnight, unson]) {
      expect(config.durable_objects.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "TASK_WRITE_BUDGETS", class_name: "TaskWriteBudget" }),
      ]));
      expect(config.migrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: "v3", new_sqlite_classes: ["TaskWriteBudget"] }),
      ]));
    }
    const worker = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(worker).toContain("issueTaskWriteRequestContext(");
    expect(worker).toMatch(
      /issueTaskWriteRequestContext\(\s*event,\s*env,\s*Date\.now\(\),\s*placement,\s*requesterResolution\.personId,\s*\)/,
    );
    expect(worker).toContain("processTaskBoardRepair(repair, env, runtimeTenantId, tenantCredentialFetch,");
    expect(worker).toContain("enqueueScheduledTaskBoardRepair(");
    expect(worker).toContain("resolveTaskBoardRepairTenantContext(env, repair)");
    expect(worker).toContain("`task-board-repair:${targetId}:${run.runId}:${run.updatedAt}`");
    expect(worker).toContain('export { TaskWriteBudget } from "./task-write-budget.js"');
  });

  it("keeps board repair bounded, retryable, and enabled in the verified cutover config", () => {
    expect(unson.vars.RUNTIME_TASK_BOARD_ENABLED).toBe("true");
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
    expect(raw).toContain('"crons": ["*/15 * * * *", "0 0 * * 1-5"]');
    expect(unson.durable_objects.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "CONTRACT_LEDGER_STATE", class_name: "ContractLedgerState" }),
      expect.objectContaining({ name: "TENANT_RUNTIME_STATE", class_name: "TenantRuntimeState" }),
    ]));
    expect(unson.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "v9", new_sqlite_classes: ["ContractLedgerState"] }),
      expect.objectContaining({ tag: "v10", new_sqlite_classes: ["TenantRuntimeState"] }),
    ]));
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

  it("records matching production task mutation and Canvas evidence", () => {
    const story = readFileSync(
      fileURLToPath(new URL("../../../../docs/management/stories/active/story-requester-aware-write-broker.md", import.meta.url)),
      "utf8",
    );
    const evidence = loadProductionEvidence();
    expect(story).toContain("- [x] `AC-8`");
    expect(story).toContain("Brainbase正本とCanvasの一致");
    expect(story).toContain("Worker version、Container image digest、Git SHA");
    expect(evidence.cloudflare.mutation_e2e_deployment).toMatchObject({
      worker_version: "38c2737b-2a91-4ebe-b9bf-714327830441",
      git_sha: "d295c8660b5bd842125ffe7ce9e46b2ba171b7fa",
    });
    expect(evidence.cloudflare.container.image_digest).toBe(
      "sha256:e9c204b29e130ae387cd551260b302ad345a4598596c41dbf80f81c88ca4a985",
    );
    expect(evidence.slack_e2e.mutation.transition).toEqual({ version: 3, status: "completed" });
    expect(evidence.canvas.visible_titles).toContain("CF-BOARD-VISIBILITY-2026-08-13-D295C86");
    expect(evidence.canvas.screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records the disabled Lightsail task surfaces and rollback order", () => {
    const story = readFileSync(
      fileURLToPath(new URL("../../../../docs/management/stories/active/story-requester-aware-write-broker.md", import.meta.url)),
      "utf8",
    );
    const evidence = loadProductionEvidence();
    const runbook = readFileSync(
      fileURLToPath(new URL("../../../../docs/operations/cloudflare-task-migration-cutover-2026-08-13.md", import.meta.url)),
      "utf8",
    );
    expect(story).toContain("- [x] `AC-9`");
    expect(story).toContain("mana-accounting.enabled=false");
    expect(story).toContain("taskCanvas.enabled=false");
    expect(story).toContain("rollbackは逆順");
    expect(evidence.lightsail).toMatchObject({
      config_git_sha: "9139b37608b95df16e99cbaceb6bd880b422e12d",
      task_ownership: { placement_enabled: false, task_canvas_enabled: false },
    });
    expect(runbook).toContain("Cloudflareを先にOFF");
  });

  it("closes task migration without using the later minutes migration as evidence", () => {
    const story = readFileSync(
      fileURLToPath(new URL("../../../../docs/management/stories/active/story-requester-aware-write-broker.md", import.meta.url)),
      "utf8",
    );
    const evidence = loadProductionEvidence();
    expect(story).toContain("- [x] `AC-10`");
    expect(story).toContain("Cloudflareが対象チャンネル");
    expect(story).toContain("後続の議事録移行状態は本Storyの完了証拠に使わない");
    expect(evidence.ownership_assertion).toMatchObject({
      task_search_owner: "cloudflare",
      task_write_owner: "cloudflare",
      task_board_owner: "cloudflare",
      lightsail_task_owner_enabled: false,
    });
    expect(evidence.scope_boundary.meeting_minutes).toContain("PR #128");
    expect(evidence.scope_boundary.meeting_minutes).toContain(
      "neither state is used as evidence for this task migration",
    );
  });
});
