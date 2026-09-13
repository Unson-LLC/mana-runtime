import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workflowPath = fileURLToPath(new URL(
  "../../../../.github/workflows/retry-meeting-minutes.yml", import.meta.url,
));

interface WorkflowResult {
  status: number | null;
  stdout: string;
  stderr: string;
  postBody?: Record<string, unknown>;
}

interface RunFixtureOptions {
  baselineOutcomeCaseId?: string;
  completedOutcomeCaseId?: string;
  completedRunReceipt?: Record<string, unknown>;
  completedCheckpoint?: Record<string, unknown>;
  outcomeCaseIdInput?: string;
  operation?: "retry" | "status";
  statusResponse?: Record<string, unknown>;
}

function extractRetryStep(workflow: string): string {
  const step = workflow.slice(workflow.indexOf("      - name: 失敗済みrunを再投入"));
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  if (runStart < 0) throw new Error("retry_workflow_run_step_missing");
  return step.slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : "")
    .join("\n");
}

function runFixture(options: RunFixtureOptions = {}): {
  baseline: Record<string, unknown>;
  completed: Record<string, unknown>;
} {
  const baseline: Record<string, unknown> = options.statusResponse ?? {
    runId: "run_001",
    status: "failed",
    diagnostics: { failedAt: "2026-09-07T00:00:00.000Z" },
    sourceStatus: { projectedAt: "2026-09-07T00:00:01.000Z" },
  };
  if (!options.statusResponse) {
    if (options.baselineOutcomeCaseId) baseline.outcomeCaseId = options.baselineOutcomeCaseId;
    if (options.baselineOutcomeCaseId) baseline.runReceipt = { caseId: options.baselineOutcomeCaseId, status: "pending" };
  }

  const completed: Record<string, unknown> = {
    runId: "run_001",
    status: "completed",
    processing: {
      completedActionTs: "__ACTION_TS__",
      completedAt: "2026-09-08T00:00:10.000Z",
    },
    sourceStatus: {
      outcome: "completed",
      projectedAt: "2026-09-08T00:00:11.000Z",
      projectionFailure: null,
    },
    checkpoint: {
      hasGitHub: true,
      hasSlackParent: true,
      postedChunkCount: 1,
      hasTaskCard: true,
      ...options.completedCheckpoint,
    },
    taskRegistration: {
      registeredCount: 1,
      pendingPresent: false,
      failure: null,
    },
  };
  if (options.completedOutcomeCaseId) completed.outcomeCaseId = options.completedOutcomeCaseId;
  if (options.completedRunReceipt) completed.runReceipt = options.completedRunReceipt;
  return { baseline, completed };
}

async function runRetryWorkflow(options: RunFixtureOptions = {}): Promise<WorkflowResult> {
  const directory = await mkdtemp(join(tmpdir(), "mana-retry-workflow-"));
  const scriptPath = join(directory, "retry-step.sh");
  const curlPath = join(directory, "curl");
  const sleepPath = join(directory, "sleep");
  const seqPath = join(directory, "seq");
  const baselinePath = join(directory, "baseline.json");
  const completedPath = join(directory, "completed.json");
  const postResponsePath = join(directory, "post-response.json");
  const postBodyPath = join(directory, "post-body.json");
  const callCountPath = join(directory, "curl-call-count");
  const summaryPath = join(directory, "summary.md");
  const fixture = runFixture(options);
  const workflow = await readFile(workflowPath, "utf8");

  const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
method="GET"
response_file=""
data=""
while (($#)); do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -o) response_file="$2"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "$response_file" ]]; then exit 2; fi
if [[ "$method" == "POST" ]]; then
  printf '%s' "$data" > "$CURL_POST_BODY_FILE"
  cp "$CURL_POST_RESPONSE_FILE" "$response_file"
else
  count=0
  if [[ -f "$CURL_CALL_COUNT_FILE" ]]; then count="$(cat "$CURL_CALL_COUNT_FILE")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$CURL_CALL_COUNT_FILE"
  if [[ "$count" == "1" ]]; then
    cp "$CURL_BASELINE_FILE" "$response_file"
  else
    action_ts="$(jq -r '.actionTs' "$CURL_POST_BODY_FILE")"
    jq --arg actionTs "$action_ts" '.processing.completedActionTs = $actionTs' \
      "$CURL_COMPLETED_FILE" > "$response_file"
  fi
fi
printf '200'
  `;
  const fakeSleep = "#!/usr/bin/env bash\nexit 0\n";
  const fakeSeq = "#!/usr/bin/env bash\nprintf '1\\n'\n";

  try {
    await Promise.all([
      writeFile(scriptPath, extractRetryStep(workflow), "utf8"),
      writeFile(curlPath, fakeCurl, "utf8"),
      writeFile(sleepPath, fakeSleep, "utf8"),
      writeFile(seqPath, fakeSeq, "utf8"),
      writeFile(baselinePath, JSON.stringify(fixture.baseline), "utf8"),
      writeFile(completedPath, JSON.stringify(fixture.completed), "utf8"),
      writeFile(postResponsePath, JSON.stringify({ runId: "run_001", status: "failed", enqueued: true }), "utf8"),
      writeFile(summaryPath, "", "utf8"),
    ]);
    await Promise.all([
      chmod(scriptPath, 0o755), chmod(curlPath, 0o755), chmod(sleepPath, 0o755), chmod(seqPath, 0o755),
    ]);

    const child = spawn("bash", [scriptPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        RUN_ID: "run_001",
        TENANT_ID: "tenant_001",
        WORKSPACE_ID: "T01ABC",
        OUTCOME_CASE_ID: options.outcomeCaseIdInput ?? "",
        OPERATION: options.operation ?? "retry",
        RETRY_REASON: "workflow test",
        SANDBOX_PROBE_TOKEN: "probe-token",
        GITHUB_STEP_SUMMARY: summaryPath,
        CURL_BASELINE_FILE: baselinePath,
        CURL_COMPLETED_FILE: completedPath,
        CURL_POST_RESPONSE_FILE: postResponsePath,
        CURL_POST_BODY_FILE: postBodyPath,
        CURL_CALL_COUNT_FILE: callCountPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    let postBody: Record<string, unknown> | undefined;
    try {
      postBody = JSON.parse(await readFile(postBodyPath, "utf8")) as Record<string, unknown>;
    } catch {
      // A preflight failure can happen before the retry POST; the caller checks
      // the process result and does not need a synthetic request body.
    }
    return { status, stdout, stderr, postBody };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("retry meeting-minutes workflow", () => {
  it("retries a run without an OutcomeCase and omits the optional field", async () => {
    const result = await runRetryWorkflow();

    expect(result.status).toBe(0);
    expect(result.postBody).toEqual(expect.objectContaining({
      tenantId: "tenant_001",
      workspaceId: "T01ABC",
      actionTs: expect.any(String),
    }));
    expect(result.postBody).not.toHaveProperty("outcomeCaseId");
  });

  it("preserves the existing OutcomeCase and its receipt completion contract", async () => {
    const result = await runRetryWorkflow({
      baselineOutcomeCaseId: "case_01",
      completedOutcomeCaseId: "case_01",
      completedRunReceipt: {
        caseId: "case_01",
        receiptId: "receipt_01",
        status: "delivered",
        deliveredAt: "2026-09-08T00:00:12.000Z",
      },
    });

    expect(result.status).toBe(0);
    expect(result.postBody).toEqual(expect.objectContaining({ outcomeCaseId: "case_01" }));
  });

  it("keeps the generation and delivery checkpoints required for a case-free retry", async () => {
    const result = await runRetryWorkflow({ completedCheckpoint: { hasGitHub: false } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fresh retry completed with an incomplete task integration");
    expect(result.postBody).not.toHaveProperty("outcomeCaseId");
  });

  it("does not weaken receipt completion when an OutcomeCase exists", async () => {
    const result = await runRetryWorkflow({
      baselineOutcomeCaseId: "case_01",
      completedOutcomeCaseId: "case_01",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fresh retry did not satisfy the completion contract before the polling deadline");
  });

  it("preserves nested task-registration failure details during status readback", async () => {
    const result = await runRetryWorkflow({
      operation: "status",
      statusResponse: {
        runId: "run_001",
        status: "failed",
        updatedAt: "2026-09-14T00:00:00.000Z",
        taskRegistration: {
          registeredCount: 0,
          pendingPresent: true,
          failure: {
            stage: "task_registration",
            failurePoint: "task_create",
            code: "TASK_API_REJECTED",
            status: 403,
            boundary: "task_api",
            scopeReason: "project_code_not_allowed",
            message: "project_code_not_allowed",
            failedAt: "2026-09-14T00:00:01.000Z",
          },
        },
        stage: "task_board",
        failurePoint: "assignee_resolution",
        code: "ROOT_SPOOF",
        boundary: "root_spoof",
        scopeReason: "root_spoof",
        message: "root_spoof",
        failedAt: "2026-09-14T00:00:02.000Z",
      },
    });

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(receipt.taskRegistration).toEqual({
      registeredCount: 0,
      pendingPresent: true,
      hasFailure: true,
      failure: {
        stage: "task_registration",
        failurePoint: "task_create",
        code: "TASK_API_REJECTED",
        status: 403,
        boundary: "task_api",
        scopeReason: "project_code_not_allowed",
        message: "project_code_not_allowed",
        failedAt: "2026-09-14T00:00:01.000Z",
      },
    });
  });
});
