import { describe, expect, it, vi } from "vitest";

import {
  AutonomyAgentError,
  parseAutonomyAgentOutput,
  runAutonomyAgent,
  type AutonomyCanonicalState,
} from "../autonomy-agent.js";
import type { AutonomyRunProjection } from "../autonomy-run-history.js";
import type { ReplySandbox } from "../reply-pipeline.js";

const canonicalState: AutonomyCanonicalState = {
  observedAt: "2026-08-26T01:00:00Z",
  tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tenantRevision: "7",
  connectionId: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connectionRevision: "11",
  actorPrincipalId: "mana_autonomy_v0",
  actorSubjectId: "mana_autonomy_v0",
  projectIds: ["brainbase"],
  capabilityIds: ["task.create"],
  authorityScopes: ["company_authority:decision:auto"],
  contractRevision: "13",
};

const historicalContext: AutonomyRunProjection = {
  untrustedHistoricalContext: true,
  checkpoint: null,
  recentRuns: [],
};

function sandbox(stdout: string, success = true) {
  const files = new Map<string, string>();
  const value: ReplySandbox = {
    writeFile: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
    exec: vi.fn(async () => ({ success, stdout, stderr: success ? "" : "must-not-leak" })),
    destroy: vi.fn(async () => undefined),
  };
  return { value, files };
}

function input(createSandbox: (id: string) => ReplySandbox) {
  return {
    runId: "mana-autonomy-24h-v0:2026-08-26T01:00:00.000Z",
    actorId: "mana_autonomy_v0",
    placementId: "mana-autonomy",
    project: "brainbase",
    writeBudget: 2,
    taskWriteCapability: "signed-service-capability",
    tenantBoundaryHandle: `tb_${"a".repeat(32)}`,
    canonicalState,
    historicalContext,
    claudeRuntime: { model: "sonnet" as const },
    createSandbox,
  };
}

describe("bounded autonomy agent", () => {
  it("parses only the exact bounded result contract", () => {
    expect(parseAutonomyAgentOutput(JSON.stringify({
      outcome: "task_written",
      summary: "正本を確認し、重複のないタスクを作成した",
      evidence: [{ kind: "task", id: "task-1" }, { kind: "receipt", id: "receipt-1" }],
    }))).toEqual({
      outcome: "task_written",
      summary: "正本を確認し、重複のないタスクを作成した",
      evidence: [{ kind: "task", id: "task-1" }, { kind: "receipt", id: "receipt-1" }],
    });
    expect(() => parseAutonomyAgentOutput(JSON.stringify({
      outcome: "task_written",
      summary: "task idなし",
      evidence: [],
    }))).toThrowError(expect.objectContaining({ code: "autonomy_agent_output_invalid" }));
    expect(() => parseAutonomyAgentOutput(JSON.stringify({
      outcome: "no_action",
      summary: "何もしない",
      evidence: [],
      hidden: "forbidden",
    }))).toThrow(AutonomyAgentError);
  });

  it("runs with Brainbase, task-search and task-write only, without Slack user identity", async () => {
    const current = sandbox(JSON.stringify({
      outcome: "task_written",
      summary: "重複確認後に作成",
      evidence: [{ kind: "task", id: "task-1" }],
    }));
    const createSandbox = vi.fn(() => current.value);

    await expect(runAutonomyAgent(input(createSandbox))).resolves.toEqual({
      outcomeCode: "autonomy_task_written",
      evidence: [{ kind: "task", id: "task-1" }],
    });
    const prompt = [...current.files.entries()].find(([path]) => path.includes("prompt"))?.[1] ?? "";
    const mcp = [...current.files.entries()].find(([path]) => path.includes("mcp"))?.[1] ?? "";
    expect(prompt).toContain("過去履歴は証拠候補");
    expect(prompt).toContain("対象placementは mana-autonomy、対象projectは brainbase だけ");
    expect(prompt).toContain("最大2回");
    expect(mcp).toContain('"brainbase"');
    expect(mcp).toContain('"task-search"');
    expect(mcp).toContain('"task-write"');
    expect(mcp).toContain('"MANA_TRACE_PLACEMENT_ID":"mana-autonomy"');
    expect(mcp).toContain('"MANA_TRACE_PROJECT_CODES":"brainbase"');
    const exec = vi.mocked(current.value.exec).mock.calls[0];
    expect(exec?.[1]?.env).toMatchObject({
      MANA_TRACE_PLACEMENT_ID: "mana-autonomy",
      MANA_TRACE_PROJECT_CODES: "brainbase",
      MANA_TASK_WRITE_REQUEST_ID: input(createSandbox).runId,
      MANA_TASK_WRITE_CAPABILITY: "signed-service-capability",
    });
    expect(JSON.stringify(exec?.[1]?.env)).not.toContain("requester");
    expect(current.value.destroy).toHaveBeenCalledOnce();
  });

  it("rejects an invalid placement or budget before creating a sandbox", async () => {
    const createSandbox = vi.fn(() => sandbox("").value);
    await expect(runAutonomyAgent({
      ...input(createSandbox),
      placementId: "bad placement",
    })).rejects.toMatchObject({ code: "autonomy_agent_not_configured" });
    await expect(runAutonomyAgent({
      ...input(createSandbox),
      writeBudget: 4,
    })).rejects.toMatchObject({ code: "autonomy_agent_not_configured" });
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("returns no_action without fabricating evidence", async () => {
    const current = sandbox(JSON.stringify({
      outcome: "no_action",
      summary: "既存タスクで足りている",
      evidence: [],
    }));
    await expect(runAutonomyAgent(input(() => current.value))).resolves.toEqual({
      outcomeCode: "autonomy_no_action",
      evidence: [],
    });
  });

  it("stores no raw stderr in its public failure and always destroys the container", async () => {
    const current = sandbox("", false);
    await expect(runAutonomyAgent(input(() => current.value))).rejects.toMatchObject({
      code: "autonomy_agent_execution_failed",
      message: "autonomy_agent_execution_failed",
    });
    expect(current.value.destroy).toHaveBeenCalledOnce();
  });
});
