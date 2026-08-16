import { spawn } from "node:child_process";
import { assertBrainbaseMeetingMinutesProjects } from "./brainbase-project-binding-check.mjs";
import { assertMeetingMinutesDeployAllowed } from "./deploy-gate-check.mjs";

try {
  await assertBrainbaseMeetingMinutesProjects({
    baseUrl: process.env.BRAINBASE_GRAPH_API_BASE_URL ?? process.env.BRAINBASE_TASK_API_BASE_URL,
    token: process.env.BRAINBASE_TASK_API_TOKEN,
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

const child = spawn("pnpm", ["exec", "wrangler", "deploy", "--config", "wrangler.unson-business.jsonc"], {
  stdio: "inherit", shell: false,
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
