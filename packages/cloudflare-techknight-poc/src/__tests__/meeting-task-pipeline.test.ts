import { TaskApiClient } from "@openryoko/task-runtime-core";
import {
  isMeetingTaskRequest,
  processMeetingTaskEvent,
  taskIdempotencyKey,
  type MeetingTaskPipelineOptions,
} from "../meeting-task-pipeline.js";
import type { RuntimeBinding } from "../runtime-config.js";
import type { SlackQueueEvent } from "../types.js";
import { resolveClaudeRuntimeConfig } from "../claude-runtime-config.js";

class MemoryFs {
  readonly files = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async ls(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return value;
  }
  async writeFile(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
}

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvMinutes123",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1786500000.000001",
    messageTs: "1786500001.000001",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> この議事録をタスク化して。橋本さんが請求書を送る。",
    receivedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

const binding: RuntimeBinding = {
  tenantId: "techknight",
  workspaceId: "T_TECHKNIGHT",
  channelId: "C_MANA_TEST",
  projectCodes: ["back-office", "brainbase"],
};

function harness(overrides: Partial<MeetingTaskPipelineOptions> = {}) {
  const sandbox = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({
      success: true,
      stdout: JSON.stringify({ tasks: [
        { title: "請求書を送付", description: "橋本さんが送付する", priority: "high", project_codes: ["attacker"] },
        { title: "契約内容を確認", due_at: "2026-08-20" },
      ] }),
      stderr: "",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  let taskIndex = 0;
  const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/companion/tasks")) {
      taskIndex += 1;
      return new Response(JSON.stringify({ id: `task-${taskIndex}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1786500010.000001" }), { status: 200 });
  });
  const options: MeetingTaskPipelineOptions = {
    binding,
    brainbaseApiBaseUrl: "https://brainbase.example",
    brainbaseTaskToken: "brainbase-secret",
    slackBotToken: "slack-secret",
    oauthConfigured: true,
    claudeRuntime: resolveClaudeRuntimeConfig({
      RUNTIME_CLAUDE_MODEL: "opus",
      RUNTIME_CLAUDE_EFFORT: "xhigh",
    }),
    createSandbox: vi.fn(() => sandbox),
    fetch: fetchMock,
    now: () => "2026-08-12T00:05:00.000Z",
    ...overrides,
  };
  return { options, sandbox, fetchMock };
}

describe("Cloudflare meeting task pipeline", () => {
  it("starts only for an explicit human app mention", () => {
    expect(isMeetingTaskRequest(event())).toBe(true);
    expect(isMeetingTaskRequest(event({ eventType: "message" }))).toBe(false);
    expect(isMeetingTaskRequest(event({ botId: "B_BOT", userId: undefined }))).toBe(false);
    expect(isMeetingTaskRequest(event({ text: "<@U_BOT> 議事録を要約して" }))).toBe(false);
  });

  it("assigns trusted deployment project codes to every registered task", async () => {
    const sharedCreate = vi.spyOn(TaskApiClient.prototype, "createTask");
    const fs = new MemoryFs();
    const { options, sandbox, fetchMock } = harness();

    await expect(processMeetingTaskEvent(fs, event({
      threadContext: "[Slack thread context]\n<@U_ROOT>: 7月分請求書を橋本さんが送付する\n",
    }), options)).resolves.toEqual({
      outcome: "tasks_registered",
      registered: 2,
      responseTs: "1786500010.000001",
    });

    const taskCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/companion/tasks"));
    expect(taskCalls).toHaveLength(2);
    expect(sharedCreate).toHaveBeenCalledTimes(2);
    expect(sharedCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "請求書を送付",
        project_codes: ["back-office", "brainbase"],
      }),
      await taskIdempotencyKey("EvMinutes123", 0),
    );
    const prompt = sandbox.writeFile.mock.calls[0][1] as string;
    expect(prompt).toContain("7月分請求書を橋本さんが送付する");
    expect(prompt.match(/この議事録をタスク化して/g)).toHaveLength(1);
    for (const [index, [, request]] of taskCalls.entries()) {
      const body = JSON.parse(String((request as RequestInit).body));
      expect(body.project_codes).toEqual(["back-office", "brainbase"]);
      expect(body.project_codes).not.toContain("attacker");
      const headers = new Headers((request as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer brainbase-secret");
      expect(headers.get("idempotency-key")).toBe(
        await taskIdempotencyKey("EvMinutes123", index),
      );
    }
    const slackCall = fetchMock.mock.calls.find(([url]) => String(url).includes("chat.postMessage"));
    expect(slackCall).toBeDefined();
    expect(JSON.parse(String((slackCall?.[1] as RequestInit).body))).toMatchObject({
      channel: "C_MANA_TEST",
      thread_ts: "1786500000.000001",
    });
    const statusCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("assistant.threads.setStatus")
    );
    expect(statusCalls).toHaveLength(2);
    expect(JSON.parse(String((statusCalls[0][1] as RequestInit).body))).toMatchObject({
      channel_id: "C_MANA_TEST",
      thread_ts: "1786500000.000001",
      status: "分析しています…",
    });
    expect(JSON.parse(String((statusCalls[1][1] as RequestInit).body))).toMatchObject({ status: "" });
    const reactionCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/reactions."));
    expect(reactionCalls).toHaveLength(2);
    expect(String(reactionCalls[0][0])).toContain("reactions.add");
    expect(JSON.parse(String((reactionCalls[0][1] as RequestInit).body))).toEqual({
      channel: "C_MANA_TEST",
      timestamp: "1786500001.000001",
      name: "eyes",
    });
    expect(String(reactionCalls[1][0])).toContain("reactions.remove");
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(sandbox.exec.mock.invocationCallOrder[0]);
    expect(sandbox.exec).toHaveBeenCalledWith(
      'claude --print --model opus --effort xhigh --permission-mode bypassPermissions "$(cat /tmp/meeting-task-prompt.txt)"',
      {
        timeout: 120_000,
        env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
      },
    );
    sharedCreate.mockRestore();
  });

  it("uses deterministic task idempotency keys", async () => {
    await expect(taskIdempotencyKey("EvMinutes123", 0)).resolves.toBe(
      await taskIdempotencyKey("EvMinutes123", 0),
    );
    await expect(taskIdempotencyKey("EvMinutes123", 0)).resolves.not.toBe(
      await taskIdempotencyKey("EvMinutes123", 1),
    );
  });

  it("partitions ephemeral meeting-task containers by the verified tenant boundary", async () => {
    const tenantA = harness({ tenantBoundaryHandle: "tb_tenant_a" });
    const tenantB = harness({ tenantBoundaryHandle: "tb_tenant_b" });

    await processMeetingTaskEvent(new MemoryFs(), event(), tenantA.options);
    await processMeetingTaskEvent(new MemoryFs(), event(), tenantB.options);

    const tenantAId = vi.mocked(tenantA.options.createSandbox).mock.calls[0][0];
    const tenantBId = vi.mocked(tenantB.options.createSandbox).mock.calls[0][0];
    expect(tenantAId).toMatch(/^meeting-tasks-[0-9a-f-]{36}$/);
    expect(tenantBId).toMatch(/^meeting-tasks-[0-9a-f-]{36}$/);
    expect(tenantAId).not.toBe(tenantBId);
    expect(tenantAId.length).toBeLessThanOrEqual(63);
    expect(tenantBId.length).toBeLessThanOrEqual(63);
  });

  it("uses the tenant operation boundary for each Claude provider request", async () => {
    const boundaryHandle = "tb_opaque_operation_handle_1234567890";
    const { options, sandbox } = harness({
      credentialLeaseHandle: "lease_handle_abcdefghijklmnopqrstuvwxyz12",
      tenantBoundaryHandle: boundaryHandle,
    });
    await processMeetingTaskEvent(new MemoryFs(), event(), options);
    expect(sandbox.exec).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ env: expect.objectContaining({
      CLAUDE_CODE_OAUTH_TOKEN: `mana-tenant-boundary-v1:${boundaryHandle}`,
      MANA_TENANT_BOUNDARY_HANDLE: boundaryHandle,
    }) }));
  });

  it("does not repeat Claude, Brainbase, or Slack after completion", async () => {
    const fs = new MemoryFs();
    const { options, sandbox, fetchMock } = harness();
    await processMeetingTaskEvent(fs, event(), options);

    await expect(processMeetingTaskEvent(fs, event(), options)).resolves.toEqual({
      outcome: "already_completed",
      registered: 0,
    });
    expect(sandbox.exec).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("resumes from the failed candidate without recreating successful tasks", async () => {
    const fs = new MemoryFs();
    let secondCandidateAttempts = 0;
    const partialFetch = vi.fn().mockImplementation(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/api/companion/tasks")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.title === "契約内容を確認") {
          secondCandidateAttempts += 1;
          if (secondCandidateAttempts === 1) {
            return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
          }
        }
        return new Response(JSON.stringify({ id: body.title }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true, ts: "1786500012.000001" }), { status: 200 });
    });
    const { options, sandbox } = harness({ fetch: partialFetch });

    await expect(processMeetingTaskEvent(fs, event(), options)).rejects.toMatchObject({
      code: "brainbase_task_registration_partial",
    });
    const initialSlackCall = partialFetch.mock.calls.find(([url]) => String(url).includes("chat.postMessage"));
    expect(JSON.parse(String((initialSlackCall?.[1] as RequestInit).body)).text).toContain(
      "Brainbaseタスク登録: 成功1件・失敗1件",
    );
    await expect(processMeetingTaskEvent(fs, event(), options)).resolves.toMatchObject({
      outcome: "tasks_registered",
      registered: 2,
    });

    expect(sandbox.exec).toHaveBeenCalledOnce();
    const taskBodies = partialFetch.mock.calls
      .filter(([url]) => String(url).includes("/api/companion/tasks"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(taskBodies.filter((body) => body.title === "請求書を送付")).toHaveLength(1);
    expect(taskBodies.filter((body) => body.title === "契約内容を確認")).toHaveLength(2);
    const updateCall = partialFetch.mock.calls.find(([url]) => String(url).includes("chat.update"));
    expect(JSON.parse(String((updateCall?.[1] as RequestInit).body))).toMatchObject({
      channel: "C_MANA_TEST",
      ts: "1786500012.000001",
      text: expect.stringContaining("Brainbaseタスク登録: 成功2件・失敗0件"),
    });
  });

  it("rejects malformed Claude output before Brainbase or Slack is called", async () => {
    const fs = new MemoryFs();
    const sandbox = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ success: true, stdout: "not-json", stderr: "" }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const { options, fetchMock } = harness({ createSandbox: () => sandbox });

    await expect(processMeetingTaskEvent(fs, event(), options)).rejects.toMatchObject({
      code: "task_candidates_invalid",
    });
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("assistant.threads.setStatus")
    )).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/reactions.")))
      .toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/companion/tasks"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("chat.postMessage"))).toBe(false);
    expect([...fs.files.keys()]).not.toContain("/task-runs/EvMinutes123.json");
  });

  it("resumes Slack notification without recreating registered tasks", async () => {
    const fs = new MemoryFs();
    let slackAttempts = 0;
    const retryFetch = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/api/companion/tasks")) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify({ id: body.title }), { status: 201 });
        }
        if (String(input).includes("assistant.threads.setStatus") || String(input).includes("/reactions.")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        slackAttempts += 1;
        return new Response(JSON.stringify(slackAttempts === 1
          ? { ok: false, error: "temporary" }
          : { ok: true, ts: "1786500011.000001" }), { status: 200 });
      });
    const { options, sandbox } = harness({
      fetch: retryFetch,
    });

    await expect(processMeetingTaskEvent(fs, event(), options)).rejects.toMatchObject({ code: "slack_post_failed" });
    await expect(processMeetingTaskEvent(fs, event(), options)).resolves.toMatchObject({
      outcome: "tasks_registered",
      registered: 2,
    });
    expect(sandbox.exec).toHaveBeenCalledOnce();
    expect(retryFetch.mock.calls.filter(([url]) => String(url).includes("/api/companion/tasks"))).toHaveLength(2);
  });

  it("does not expose secrets in sandbox input or persisted results", async () => {
    const fs = new MemoryFs();
    const { options, sandbox } = harness();
    await processMeetingTaskEvent(fs, event(), options);
    const sandboxInput = JSON.stringify([sandbox.writeFile.mock.calls, sandbox.exec.mock.calls]);
    const persisted = [...fs.files.values()].join("\n");
    for (const secret of ["brainbase-secret", "slack-secret"]) {
      expect(sandboxInput).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).not.toContain("proxy-injected");
  });
});
