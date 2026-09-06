import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBrainbaseMeetingMinutesRuntimeProjects } from "./brainbase-project-binding-check.mjs";
import { assertMeetingMinutesDeployAllowed } from "./deploy-gate-check.mjs";
import {
  assertTenantRuntimeDeploymentPreflight,
  assertTenantRuntimeHealthReady,
} from "./tenant-runtime-deploy-readiness.mjs";

const configPath = fileURLToPath(new URL("../wrangler.unson-business.jsonc", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function wranglerDeployArgs() {
  const skipContainerRollout = process.env.MANA_SKIP_CONTAINER_ROLLOUT;
  if (skipContainerRollout !== undefined
    && skipContainerRollout !== "true"
    && skipContainerRollout !== "false") {
    throw new Error("tenant_runtime_container_rollout_option_invalid");
  }

  const args = ["exec", "wrangler", "deploy", "--config", configPath];
  if (skipContainerRollout === "true") {
    args.push("--containers-rollout", "none");
  }
  return args;
}

let deployArgs;
try {
  deployArgs = wranglerDeployArgs();
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant_runtime_container_rollout_option_invalid");
  process.exit(9);
}

function candidateCheckoutHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function reviewedCheckoutParent() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return process.env.MANA_DEPLOY_CANDIDATE_COMMIT;
  }
}

function assertAuthorizationOnlyCommit() {
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean).sort();
  const allowed = [
    "contracts/brainbase-trusted-provider-forwarder/v1/source-lock.json",
    "contracts/mana-brainbase-tenant-context/v1/source-lock.json",
  ].sort();
  if (JSON.stringify(changed) !== JSON.stringify(allowed)) {
    throw new Error("tenant_runtime_deploy_authorization_commit_invalid");
  }
}

function assertReviewedCandidateCheckout(actual) {
  const expected = process.env.MANA_DEPLOY_CANDIDATE_COMMIT;
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (!expected || expected !== actual || dirty) {
    throw new Error("tenant_runtime_deploy_candidate_checkout_invalid");
  }
}

function assertRunReceiptServiceToken() {
  if (typeof process.env.BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN !== "string"
    || process.env.BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN.trim() === "") {
    throw new Error("brainbase_run_receipt_service_token_missing");
  }
}

try {
  assertRunReceiptServiceToken();
} catch (error) {
  console.error(error instanceof Error ? error.message : "brainbase_run_receipt_service_token_missing");
  process.exit(7);
}

try {
  await assertBrainbaseMeetingMinutesRuntimeProjects({
    taskBaseUrl: process.env.BRAINBASE_TASK_API_BASE_URL,
    graphBaseUrl: process.env.BRAINBASE_GRAPH_API_BASE_URL,
    taskToken: process.env.BRAINBASE_TASK_API_TOKEN,
    graphToken: process.env.BRAINBASE_GRAPH_API_TOKEN,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "meeting_minutes_brainbase_project_check_failed");
  process.exit(6);
}

const baseUrl = process.env.UNSON_BUSINESS_WORKER_URL;
const token = process.env.SANDBOX_PROBE_TOKEN;
try {
  await assertMeetingMinutesDeployAllowed({ baseUrl, token,
    allowMissingGate: process.env.MEETING_MINUTES_DEPLOY_GATE_BOOTSTRAP === "true" });
} catch (error) {
  console.error(error instanceof Error ? error.message : "meeting_minutes_deploy_gate_failed");
  process.exit(5);
}

let deploymentConfig;
try {
  const candidateCommit = process.env.MANA_DEPLOY_CANDIDATE_COMMIT;
  deploymentConfig = await assertTenantRuntimeDeploymentPreflight({
    configPath,
    candidateCommit,
    reviewedCommit: reviewedCheckoutParent(),
  });
  assertReviewedCandidateCheckout(candidateCheckoutHead());
  assertAuthorizationOnlyCommit();
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant_runtime_deploy_preflight_failed");
  process.exit(7);
}

const deployExit = await new Promise((resolve) => {
  const child = spawn("pnpm", deployArgs, {
    stdio: "inherit", shell: false,
  });
  child.on("error", () => resolve(1));
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
if (deployExit !== 0) process.exit(deployExit);

try {
  await assertTenantRuntimeHealthReady({
    baseUrl,
    expectedTenantId: deploymentConfig.tenantId,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant_runtime_post_deploy_not_ready");
  process.exit(8);
}
