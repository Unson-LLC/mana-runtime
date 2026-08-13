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
    SLACK_EXPECTED_TEAM_ID: "T_UNSON",
    SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
    TASK_WRITE_BUDGETS: budgetNamespace(),
    ...overrides,
  };
}

function budgetNamespace() {
  const slots = new Map<string, string>();
  const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }));
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch })),
    slots,
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

  it("checks the current project before transition and forwards expected_version", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json(task))
      .mockResolvedValueOnce(Response.json({ ...task, status: "completed", version: 5 }));
    const response = await createTaskWriteProxyHandler(upstream)(await request({
      operation: "transition",
      task_id: "task-1",
      expected_version: 4,
      to_status: "completed",
    }), env());

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
    budget.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ error: "task_write_budget_slot_reused" }, { status: 409 }));
    const bindings = { ...env(), TASK_WRITE_BUDGETS: budget };
    const upstream = vi.fn().mockResolvedValue(Response.json(task));
    const handler = createTaskWriteProxyHandler(upstream);

    const first = await handler(await request({ operation: "create", title: "A", call_index: 1 }), bindings);
    const second = await handler(await request({ operation: "create", title: "B", call_index: 1 }), bindings);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
    expect(budget.fetch).toHaveBeenCalledTimes(2);
  });
});
