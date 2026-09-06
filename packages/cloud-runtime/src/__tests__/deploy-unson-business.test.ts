import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { collectMeetingMinutesProjectBindings } from "../../scripts/brainbase-project-binding-check.mjs";

function runScript(script: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stderr }));
  });
}

describe("unson business deploy wrapper", () => {
  it("installs dependencies without creating an untracked lockfile before the clean checkout gate", async () => {
    const workflow = await readFile(
      fileURLToPath(new URL("../../../../.github/workflows/deploy-unson-business.yml", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain("pnpm install --no-frozen-lockfile --lockfile=false");
  });

  it("fails closed unless the direct Task API credential required by meeting-minutes redo is deployed", async () => {
    const workflow = await readFile(
      fileURLToPath(new URL("../../../../.github/workflows/deploy-unson-business.yml", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain('test -n "$BRAINBASE_TASK_API_TOKEN"');
    expect(workflow.match(/BRAINBASE_TASK_API_TOKEN: \$\{\{ secrets\.BRAINBASE_TASK_API_TOKEN \}\}/g)).toHaveLength(2);
  });

  it("provisions and passes the run-receipt credential without printing it", async () => {
    const workflow = await readFile(
      fileURLToPath(new URL("../../../../.github/workflows/deploy-unson-business.yml", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain('test -n "$BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN"');
    expect(workflow).toContain("wrangler secret put BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN");
    expect(workflow.match(/BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN: \$\{\{ secrets\.BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN \}\}/g)).toHaveLength(3);
    expect(workflow).not.toContain('echo "$BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN"');
  });

  it("keeps Container rollout enabled by default and allows an explicit Worker-only recovery", async () => {
    const workflow = await readFile(
      fileURLToPath(new URL("../../../../.github/workflows/deploy-unson-business.yml", import.meta.url)),
      "utf8",
    );
    const script = await readFile(
      fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain("skip_container_rollout:");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("MANA_SKIP_CONTAINER_ROLLOUT: ${{ inputs.skip_container_rollout }}");
    expect(script).toContain('skipContainerRollout !== "true"');
    expect(script).toContain('skipContainerRollout !== "false"');
    expect(script).toContain('args.push("--containers-rollout", "none")');
  });

  it("fails closed before preflight when the Container rollout option is invalid", () => {
    const script = fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: "/path-that-does-not-contain-pnpm",
        MANA_SKIP_CONTAINER_ROLLOUT: "unexpected",
      },
    });

    expect(result.status).toBe(9);
    expect(result.stderr).toContain("tenant_runtime_container_rollout_option_invalid");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("fails closed before any network preflight when the receipt credential is absent", () => {
    const script = fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: "/path-that-does-not-contain-pnpm",
      },
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("brainbase_run_receipt_service_token_missing");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("stops before deployment when Brainbase project preflight fails", () => {
    const script = fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: "/path-that-does-not-contain-pnpm",
        BRAINBASE_GRAPH_API_BASE_URL: "https://brainbase.invalid",
        BRAINBASE_TASK_API_TOKEN: "",
        BRAINBASE_GRAPH_API_TOKEN: "",
        BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN: "receipt-token-never-log",
      },
    });

    expect(result.status).toBe(6);
    expect(result.stderr).toContain("meeting_minutes_brainbase_project_check_auth_missing");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("stops before Wrangler when deployment authorization is unavailable", async () => {
    const script = fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url));
    const configPath = fileURLToPath(new URL("../../wrangler.unson-business.jsonc", import.meta.url));
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const { requiredCodes } = collectMeetingMinutesProjectBindings(config);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/info/graph/entities")) {
        response.end(JSON.stringify({ records: requiredCodes.map((id) => ({ id })) }));
        return;
      }
      if (request.url?.startsWith("/api/companion/tasks")) {
        response.end(JSON.stringify({ items: [] }));
        return;
      }
      if (request.url === "/admin/meeting-minutes/deploy-gate") {
        response.end(JSON.stringify({ allowed: true, activeRuns: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_address_missing");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const result = await runScript(script, {
        ...process.env,
        PATH: "/path-that-does-not-contain-pnpm",
        BRAINBASE_TASK_API_BASE_URL: baseUrl,
        BRAINBASE_GRAPH_API_BASE_URL: baseUrl,
        BRAINBASE_TASK_API_TOKEN: "task-token-never-log",
        BRAINBASE_GRAPH_API_TOKEN: "graph-token-never-log",
        BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN: "receipt-token-never-log",
        UNSON_BUSINESS_WORKER_URL: baseUrl,
        SANDBOX_PROBE_TOKEN: "probe-token-never-log",
      });

      expect(result.status).toBe(7);
      expect(result.stderr).toMatch(
        /tenant_runtime_source_lock_preflight_failed:tenant_context:(?:deploy_not_allowed|deployment_authorization_context_missing|deployment_authorization_expired|deployment_authorization_invalid)/,
      );
      expect(result.stderr).not.toContain("token-never-log");
      expect(result.stderr).not.toContain("ENOENT");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
