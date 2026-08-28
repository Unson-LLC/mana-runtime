import { signTaskWriteCapability } from "@openryoko/write-broker";
import { createTaskWriteProxyHandler } from "../task-write-proxy.js";

const SECRET = "write-capability-secret-at-least-32-bytes";
const TASK_TOKEN = "brainbase-task-secret";
const REQUEST_ID = "EvWrite123";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RUNTIME_TASK_WRITE_ENABLED: "true",
    RUNTIME_PROJECT_CODES: "back-office",
    RUNTIME_PLACEMENT_ID: "mana-accounting",
    BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
    BRAINBASE_TASK_API_TOKEN: TASK_TOKEN,
    TASK_WRITE_CAPABILITY_SECRET: SECRET,
    TASK_WRITE_POLICY_JSON: JSON.stringify({ version: "test-v1", rules: [{ effect: "auto", actors: ["U_REQUESTER"], placements: ["mana-accounting"], projects: ["back-office"], operations: ["task.create", "task.update"] }] }),
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
    SLACK_BOT_TOKEN: "xoxb-test",
    TASK_WRITE_BUDGETS: budgetNamespace(),
    TASK_WRITE_APPROVALS: approvalNamespace(),
    ...overrides,
  };
}

function approvalNamespace() {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  return { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch })), fetch };
}

function budgetNamespace() {
  const slots = new Map<string, string>();
  const receipts = new Map<string, {
    state: "claimed" | "completed";
    resultRef?: string;
  }>();
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/claim") {
      const body = await request.json() as {
        requestId: string;
        nonce: string;
        callIndex: number;
        fingerprint: string;
      };
      const key = `${body.requestId}:${body.nonce}:${body.callIndex}`;
      const existing = slots.get(key);
      if (existing === body.fingerprint) return Response.json({ disposition: "replay" });
      if (existing) {
        return Response.json({ error: "task_write_budget_slot_reused" }, { status: 409 });
      }
      slots.set(key, body.fingerprint);
      receipts.set(body.fingerprint, { state: "claimed" });
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await request.json() as { fingerprint: string; resultRef?: string };
      const receipt = receipts.get(body.fingerprint);
      if (!receipt) {
        return Response.json({ error: "task_write_receipt_missing" }, { status: 404 });
      }
      receipts.set(body.fingerprint, {
        state: "completed",
        ...(body.resultRef ? { resultRef: body.resultRef } : {}),
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/receipt") {
      const receipt = receipts.get(url.searchParams.get("fingerprint") ?? "");
      return receipt
        ? Response.json(receipt)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch })),
    slots,
    receipts,
    fetch,
  };
}

async function capability(overrides: Record<string, unknown> = {}): Promise<string> {
  return signTaskWriteCapability({
    version: 1,
    audience: "mana-task-write",
    requestId: REQUEST_ID,
    actor: { provider: "slack", id: "U_REQUESTER", workspace: "T_UNSON" },
    placementId: "mana-accounting",
    projects: ["back-office"],
    operations: ["task.create", "task.update", "task.transition"],
    expiresAt: Date.now() + 60_000,
    nonce: "nonce-1",
    budget: 3,
    ...overrides,
  }, SECRET);
}

function request(body: Record<string, unknown>, token?: string): Promise<Request> | Request {
  const make = (value: string) => new Request("https://task-write.internal/api/task-write", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mana-task-write-capability": value },
    body: JSON.stringify({ request_id: REQUEST_ID, project: "back-office", call_index: 1, ...body }),
  });
  return token === undefined ? capability().then(make) : make(token);
}

const task = {
  id: "task-1",
  version: 4,
  title: "契約更新",
  description: null,
  status: "pending",
  priority: "high",
  project_codes: ["back-office"],
  assignee_person_id: null,
  assignee_display_name: null,
  due_at: null,
  waiting_on: null,
  completed_at: null,
};

describe("Cloudflare requester-scoped task write proxy", () => {
  it("creates a task with trusted project scope and deterministic idempotency", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json(task));
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "create",
      title: "契約更新",
      priority: "high",
    }), env());

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bb.example.test/api/companion/tasks");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers)).toMatchObject(expect.any(Headers));
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TASK_TOKEN}`);
    expect(new Headers(init.headers).get("idempotency-key")).toBe("slack:EvWrite123:1");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "契約更新",
      priority: "high",
      project_codes: ["back-office"],
    });
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ untrusted_data: true, task: { id: "task-1", version: 4 } });
    expect(JSON.stringify(payload)).not.toContain(TASK_TOKEN);
  });

  it("never publishes a raw tenant TaskBoard repair after a successful write", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const bindings = { ...env(), TENANT_ID: "unson-business", TASK_BOARD_REPAIRS: { send },
      TASK_BOARD_TARGETS_JSON: JSON.stringify([
        { targetId: "back-office", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
          channelId: "C0BKS6RL99T", projectCodes: ["back-office"], enabled: true,
          manaCanvasId: "FBACKOFFICE", bindingRevision: 4 },
        { targetId: "pms", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB",
          channelId: "C0BKX9Y169F", projectCodes: ["proj_pms"], enabled: true,
          manaCanvasId: "FPMS", bindingRevision: 2 },
        { targetId: "back-office-disabled", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
          channelId: "C0BKS6RL99U", projectCodes: ["back-office"], enabled: false,
          manaCanvasId: null, bindingRevision: null },
      ]) };
    const response = await createTaskWriteProxyHandler(vi.fn().mockResolvedValue(Response.json(task)))(await request({
      operation: "create", title: "契約更新",
    }), bindings);
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("calls the injected fetch without binding TaskApiClient as its receiver", async () => {
    const upstream = vi.fn(async function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Response.json(task);
    });

    const response = await createTaskWriteProxyHandler(upstream as typeof fetch)(await request({
      operation: "create",
      title: "契約更新",
    }), env());

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("checks the current project before transition and forwards expected_version", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json(task))
      .mockResolvedValueOnce(Response.json({ ...task, status: "completed", version: 5 }));
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "transition",
      task_id: "task-1",
      expected_version: 4,
      to_status: "completed",
    }), env({ TASK_WRITE_POLICY_JSON: JSON.stringify({ version: "legacy-transition-test", rules: [{ effect: "auto", actors: ["U_REQUESTER"], placements: ["mana-accounting"], projects: ["back-office"], operations: ["task.transition"] }] }) }));

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://bb.example.test/api/companion/tasks/task-1");
    const transition = upstream.mock.calls[1] as [string, RequestInit];
    expect(transition[0]).toBe("https://bb.example.test/api/companion/tasks/task-1/transitions");
    expect(JSON.parse(String(transition[1].body))).toEqual({ expected_version: 4, to_status: "completed" });
  });

  it("returns a non-retryable conflict distinctly", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json(task))
      .mockResolvedValueOnce(Response.json({ code: "version_conflict", message: "stale" }, { status: 409 }));
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "update",
      task_id: "task-1",
      expected_version: 3,
      title: "変更",
    }), env());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "task_write_conflict" });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("logs only bounded upstream status and code while keeping the external error generic", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      code: "task_write_scope_missing",
      message: "must not be copied into Worker logs",
      token: "must-not-leak",
    }, { status: 403 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "create",
      title: "契約更新",
    }), env());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_write_upstream_failed" });
    expect(errorLog).toHaveBeenCalledOnce();
    const receipt = JSON.parse(String(errorLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(receipt).toEqual({
      event: "task_write_upstream_error",
      requestId: REQUEST_ID,
      operation: "task.create",
      upstreamStatus: 403,
      upstreamCode: "task_write_scope_missing",
    });
    expect(JSON.stringify(receipt)).not.toContain("must not be copied");
    expect(JSON.stringify(receipt)).not.toContain("must-not-leak");
    errorLog.mockRestore();
  });

  it("does not confuse an upstream error message with a local authorization failure", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      code: "task_store_forbidden",
      message: "task_write_denied",
    }, { status: 403 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "create",
      title: "契約更新",
    }), env());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_write_upstream_failed" });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      event: "task_write_upstream_error",
      upstreamStatus: 403,
      upstreamCode: "task_store_forbidden",
    });
    errorLog.mockRestore();
  });

  it("classifies network failures without logging the exception message", async () => {
    const upstream = vi.fn().mockRejectedValue(new Error("request carried must-not-leak-token"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "create",
      title: "契約更新",
    }), env());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_write_upstream_failed" });
    const receipt = JSON.parse(String(errorLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(receipt).toEqual({
      event: "task_write_upstream_error",
      requestId: REQUEST_ID,
      operation: "task.create",
      upstreamStatus: null,
      upstreamCode: "task_write_network_error",
    });
    expect(JSON.stringify(receipt)).not.toContain("must-not-leak-token");
    errorLog.mockRestore();
  });

  it.each([
    ["feature disabled", env({ RUNTIME_TASK_WRITE_ENABLED: "false" }), { operation: "create", title: "x" }, 503],
    ["untrusted project", env(), { operation: "create", project: "outside", title: "x" }, 403],
    ["budget exceeded", env(), { operation: "create", title: "x", call_index: 4 }, 400],
    ["missing expected version", env(), { operation: "update", task_id: "task-1", title: "x" }, 400],
    ["zero expected version", env(), { operation: "update", task_id: "task-1", expected_version: 0, title: "x" }, 400],
    ["unknown field", env(), { operation: "create", title: "x", token: "forged" }, 400],
  ])("rejects %s before an upstream mutation", async (_name, bindings, body, status) => {
    const upstream = vi.fn();
    const response = await createTaskWriteProxyHandler(upstream)(await request(body), bindings);
    expect(response.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a capability bound to another placement", async () => {
    const upstream = vi.fn();
    const forged = await capability({ placementId: "other-placement" });
    const response = await createTaskWriteProxyHandler(upstream)(await request({ operation: "create", title: "x" }, forged), env());
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the signed placement scope when one worker serves multiple placements", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ...task, project_codes: ["unson"] }));
    const token = await capability({ placementId: "biz-meeting-router", projects: ["unson"] });
    const policy = JSON.stringify({ version: "test-v2", rules: [{ effect: "approval", actors: ["U_REQUESTER"], placements: ["biz-meeting-router"], projects: ["unson"], operations: ["task.create"], approvers: ["U_APPROVER"], ttlSeconds: 120 }] });
    const placements = JSON.stringify([
      { placementId: "mana-accounting", channelId: "C_BACK_OFFICE", projectCodes: ["back-office"], taskWriteEnabled: true },
      { placementId: "biz-meeting-router", channelId: "C_ROUTER", projectCodes: ["unson"], taskWriteEnabled: true },
    ]);
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "create", project: "unson", title: "Router task",
    }, token), env({ RUNTIME_PLACEMENTS_JSON: placements, TASK_WRITE_POLICY_JSON: policy }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "approval_required", policy_version: "test-v2" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("fails closed when no requester policy is configured", async () => {
    const upstream = vi.fn();
    const response = await createTaskWriteProxyHandler(upstream)(await request({ operation: "create", title: "x" }), env({ TASK_WRITE_POLICY_JSON: undefined }));
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns approval without mutating when requester policy requires it", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const policy = JSON.stringify({ version: "test-v2", rules: [{ effect: "approval", actors: ["U_REQUESTER"], placements: ["mana-accounting"], projects: ["back-office"], operations: ["task.create"], approvers: ["U_APPROVER"], ttlSeconds: 120 }] });
    const response = await createTaskWriteProxyHandler(upstream)(await request({ operation: "create", title: "x" }), env({ TASK_WRITE_POLICY_JSON: policy }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "approval_required", policy_version: "test-v2" });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
  });

  it("routes approval cards to the dedicated validation channel", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const policy = JSON.stringify({ version: "test-v2", rules: [{ effect: "approval", actors: ["U_REQUESTER"], placements: ["mana-accounting"], projects: ["back-office"], operations: ["task.create"], approvers: ["U_APPROVER"], ttlSeconds: 120 }] });
    const response = await createTaskWriteProxyHandler(upstream)(await request({ operation: "create", title: "x" }), env({
      TASK_WRITE_POLICY_JSON: policy,
      TASK_WRITE_APPROVAL_CHANNEL_ID: "C_MANA_DEV",
    }));
    expect(response.status).toBe(202);
    const init = upstream.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ channel: "C_MANA_DEV" });
  });

  it("denies operations outside the requester policy", async () => {
    const upstream = vi.fn();
    const response = await createTaskWriteProxyHandler(upstream)(await request({ operation: "transition", task_id: "task-1", expected_version: 4, to_status: "completed" }), env());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "task_write_policy_denied" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed when the existing task has no trusted project", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ...task, project_codes: ["outside"] }));
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "update",
      task_id: "task-1",
      expected_version: 4,
      title: "変更",
    }), env());
    expect(response.status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rejects reuse of one capability call slot for a different mutation", async () => {
    const budget = budgetNamespace();
    const bindings = { ...env(), TASK_WRITE_BUDGETS: budget };
    const upstream = vi.fn().mockResolvedValue(Response.json(task));
    const handler = createTaskWriteProxyHandler(upstream);

    const first = await handler(await request({ operation: "create", title: "A", call_index: 1 }), bindings);
    const second = await handler(await request({ operation: "create", title: "B", call_index: 1 }), bindings);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
    expect(budget.fetch).toHaveBeenCalledTimes(3);
  });
});
