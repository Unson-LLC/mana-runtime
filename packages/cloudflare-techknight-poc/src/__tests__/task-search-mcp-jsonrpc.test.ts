import {
  processTaskSearchRpcMessage,
  taskSearchToolDefinition,
} from "../../container/task-search-mcp-server.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("task-search stdio MCP", () => {
  it("serves initialize and tools/list over newline JSON-RPC as a child process", () => {
    const server = fileURLToPath(new URL("../../container/task-search-mcp-server.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [server], {
      input: [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "",
      ].join("\n"),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "mana-task-search" } } });
    expect(responses[1]).toMatchObject({ id: 2, result: { tools: [{ name: "search_tasks" }] } });
  });

  it("exposes only the bounded search_tasks schema", async () => {
    const result = await processTaskSearchRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [taskSearchToolDefinition] },
    });
    expect(taskSearchToolDefinition.name).toBe("search_tasks");
    expect(taskSearchToolDefinition.inputSchema).toMatchObject({
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 20 },
      },
    });
  });

  it("keeps zero partial and upstream failure distinct", async () => {
    const pages = [
      Response.json({ items: [], has_more: false, next_cursor: null, read_status: "complete" }),
      Response.json({ items: [{ id: "1", title: "契約更新" }], has_more: true, next_cursor: "next", read_status: "partial" }),
      Response.json({ error: "task_search_upstream_failed" }, { status: 502 }),
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(pages.shift()));
    const call = (id: number) => processTaskSearchRpcMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_tasks", arguments: { query: "契約" } },
    }, fetchMock);

    const zero = await call(1);
    const partial = await call(2);
    const failure = await call(3);
    expect(zero?.result).toMatchObject({ isError: false });
    expect(partial?.result).toMatchObject({ isError: false });
    expect(failure?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(zero)).toContain('\\"read_status\\":\\"complete\\"');
    expect(JSON.stringify(partial)).toContain('\\"read_status\\":\\"partial\\"');
    expect(JSON.stringify(failure)).toContain("task_search_upstream_failed");
  });

  it("uses only the fixed synthetic endpoint and allowed query fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [], has_more: false }));
    await processTaskSearchRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_tasks",
        arguments: { query: "契約", limit: 4, status: "waiting", cursor: "opaque+/=" },
      },
    }, fetchMock);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://task-search.internal/api/companion/tasks/search?query=%E5%A5%91%E7%B4%84&status=waiting&cursor=opaque%2B%2F%3D&limit=4");
    expect(url).not.toContain("project_code");
  });

  it("propagates only bounded trace metadata to the Worker proxy", async () => {
    vi.stubEnv("MANA_TRACE_ID", "EvTrace123");
    vi.stubEnv("MANA_TRACE_PLACEMENT_ID", "mana-dev-biz");
    vi.stubEnv("MANA_TRACE_PROJECT_CODES", "unson");
    try {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [], has_more: false }));
      await processTaskSearchRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_tasks", arguments: { query: "SYNTHETIC_PERSON_QUERY" } },
      }, fetchMock);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("x-mana-trace-id")).toBe("EvTrace123");
      expect(headers.get("x-mana-trace-placement-id")).toBe("mana-dev-biz");
      expect(headers.get("x-mana-trace-project-codes")).toBe("unson");
      expect(headers.get("x-mana-trace-call-index")).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("limits one MCP process to three bounded searches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [], has_more: false }));
    const state = { searchCalls: 0 };
    const call = (id: number) => processTaskSearchRpcMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_tasks", arguments: { query: "契約" } },
    }, fetchMock, state);

    await call(1);
    await call(2);
    await call(3);
    const rejected = await call(4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rejected?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).toContain("task_search_call_limit_exceeded");
  });
});
