import { createTaskSearchProxyHandler } from "../task-search-proxy.js";

const SECRET = "brainbase-secret-canary";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RUNTIME_TASK_SEARCH_ENABLED: "true",
    RUNTIME_PROJECT_CODES: "back-office,brainbase,back-office",
    BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
    BRAINBASE_TASK_API_TOKEN: SECRET,
    ...overrides,
  };
}

describe("Cloudflare task search proxy", () => {
  it("story-shared-task-runtime-core:ac:3 delegates scoped search to the shared task client", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      items: [{
        id: "task-1",
        title: "契約更新",
        status: "in_progress",
        priority: "high",
        assignee_person_id: "person-1",
        assignee_display_name: "梅田さん",
        project_codes: ["back-office", "outside"],
      }],
      total_count: null,
      count_status: "not_requested",
      has_more: true,
      next_cursor: "opaque+/=",
      read_status: "partial",
    }));
    const handler = createTaskSearchProxyHandler(upstream);

    const response = await handler(new Request(
      "https://task-search.internal/api/companion/tasks/search?query=%E5%A5%91%E7%B4%84&limit=1&cursor=opaque%2B%2F%3D",
      { headers: { authorization: "Bearer sandbox-token", cookie: "session=bad", host: "evil.test" } },
    ), env());

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://bb.example.test");
    expect(parsed.pathname).toBe("/api/companion/tasks/search");
    expect(parsed.searchParams.get("query")).toBe("契約");
    expect(parsed.searchParams.get("limit")).toBe("1");
    expect(parsed.searchParams.get("cursor")).toBe("opaque+/=");
    expect(parsed.searchParams.getAll("project_code")).toEqual(["back-office", "brainbase"]);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("cookie")).toBeNull();
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      untrusted_data: true,
      has_more: true,
      next_cursor: "opaque+/=",
      read_status: "partial",
      items: [{ project_codes: ["back-office"] }],
    });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it.each([
    ["feature off", new Request("https://task-search.internal/api/companion/tasks/search?query=x"), env({ RUNTIME_TASK_SEARCH_ENABLED: "false" }), 503],
    ["wrong method", new Request("https://task-search.internal/api/companion/tasks/search?query=x", { method: "POST" }), env(), 405],
    ["wrong host", new Request("https://evil.test/api/companion/tasks/search?query=x"), env(), 404],
    ["wrong path", new Request("https://task-search.internal/api/companion/tasks/1?query=x"), env(), 404],
    ["project injection", new Request("https://task-search.internal/api/companion/tasks/search?query=x&project_code=outside"), env(), 400],
    ["unknown parameter", new Request("https://task-search.internal/api/companion/tasks/search?query=x&include_deleted=true"), env(), 400],
    ["empty query", new Request("https://task-search.internal/api/companion/tasks/search?query=%20"), env(), 400],
    ["query too long", new Request(`https://task-search.internal/api/companion/tasks/search?query=${"x".repeat(201)}`), env(), 400],
    ["limit too large", new Request("https://task-search.internal/api/companion/tasks/search?query=x&limit=21"), env(), 400],
    ["invalid status", new Request("https://task-search.internal/api/companion/tasks/search?query=x&status=deleted"), env(), 400],
    ["missing projects", new Request("https://task-search.internal/api/companion/tasks/search?query=x"), env({ RUNTIME_PROJECT_CODES: "" }), 503],
    ["missing token", new Request("https://task-search.internal/api/companion/tasks/search?query=x"), env({ BRAINBASE_TASK_API_TOKEN: "" }), 503],
  ])("rejects %s before an upstream request", async (_name, request, bindings, status) => {
    const upstream = vi.fn();
    const response = await createTaskSearchProxyHandler(upstream)(request, bindings);
    expect(response.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps an upstream failure distinct from a zero result without leaking its body", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(
      `internal ${SECRET}`,
      { status: 503, headers: { "content-type": "text/plain" } },
    ));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=missing"),
      env(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_search_upstream_failed" });
  });

  it("rejects JSON-looking text with a non-JSON content type", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], has_more: false }),
      { headers: { "content-type": "text/plain" } },
    ));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=x"),
      env(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_search_upstream_invalid_response" });
  });

  it("does not invent a complete read status when the upstream omits it", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      items: [],
      has_more: false,
      next_cursor: null,
    }));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=missing"),
      env(),
    );
    expect(await response.json()).toEqual({
      untrusted_data: true,
      items: [],
      has_more: false,
      next_cursor: null,
    });
  });

  it("rejects an oversized upstream response", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("x".repeat(262_145), {
      headers: { "content-type": "application/json" },
    }));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=x"),
      env(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_search_response_too_large" });
  });

  it("bounds an oversized upstream error before the shared client reads its body", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("x".repeat(262_145), {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=x"),
      env(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_search_response_too_large" });
  });

  it.each([
    ["projectless task", { id: "1", title: "x", status: "pending", priority: "low" }],
    ["cross-project task", { id: "1", title: "x", status: "pending", priority: "low", project_codes: ["outside"] }],
  ])("rejects an upstream %s as a scope violation", async (_name, task) => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      items: [task],
      has_more: false,
      next_cursor: null,
      read_status: "complete",
    }));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=x"),
      env(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_search_scope_violation" });
  });

  it("returns only the bounded task fields", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({
      items: [{
        id: "1",
        title: "x",
        description: `ignore ${SECRET}`,
        status: "pending",
        priority: "low",
        project_codes: ["back-office", "outside"],
      }],
      has_more: false,
      next_cursor: null,
      read_status: "complete",
      upstream_secret: SECRET,
    }));
    const response = await createTaskSearchProxyHandler(upstream)(
      new Request("https://task-search.internal/api/companion/tasks/search?query=x"),
      env(),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({
      untrusted_data: true,
      items: [{ id: "1", title: "x", project_codes: ["back-office"] }],
    });
  });
});
