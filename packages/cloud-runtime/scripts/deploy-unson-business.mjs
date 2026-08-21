import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBrainbaseMeetingMinutesRuntimeProjects } from "./brainbase-project-binding-check.mjs";
import { assertMeetingMinutesDeployAllowed } from "./deploy-gate-check.mjs";
import {
  assertTenantRuntimeAuthorizationOnlyChild,
  assertTenantRuntimeDeploymentPreflight,
  assertTenantRuntimeHealthReady,
} from "./tenant-runtime-deploy-readiness.mjs";

const configPath = fileURLToPath(new URL("../wrangler.unson-business.jsonc", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function candidateCheckoutHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function assertAuthorizationOnlyCommit(reviewedCommit, candidateCommit) {
  const parentLine = execFileSync("git", ["rev-list", "--parents", "-n", "1", candidateCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split(/\s+/);
  if (parentLine.shift() !== candidateCommit) {
    throw new Error("tenant_runtime_deploy_authorization_parent_invalid");
  }
  const changed = execFileSync("git", ["diff", "--name-status", reviewedCommit, candidateCommit, "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean).sort();
  return assertTenantRuntimeAuthorizationOnlyChild({
    reviewedCommit,
    candidateCommit,
    candidateParentCommits: parentLine,
    changedEntries: changed,
  });
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
  const reviewedCommit = process.env.MANA_DEPLOY_REVIEWED_COMMIT;
  deploymentConfig = await assertTenantRuntimeDeploymentPreflight({
    configPath,
    candidateCommit,
    reviewedCommit,
  });
  const actualCandidateCommit = candidateCheckoutHead();
  assertReviewedCandidateCheckout(actualCandidateCommit);
  assertAuthorizationOnlyCommit(reviewedCommit, actualCandidateCommit);
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant_runtime_deploy_preflight_failed");
  process.exit(7);
}

const deployExit = await new Promise((resolve) => {
  const child = spawn("pnpm", ["exec", "wrangler", "deploy", "--config", configPath], {
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
    expectedBootstrapMode: deploymentConfig.bootstrapMode,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant_runtime_post_deploy_not_ready");
  process.exit(8);
}
