import { processTaskSearchRpcMessage } from "../../container/task-search-mcp-server.mjs";
import { createTaskSearchProxyHandler } from "../task-search-proxy.js";

describe("task-search MCP to Worker boundary integration", () => {
  it("carries one bounded multi-project search through MCP and the Worker proxy", async () => {
    const canonical = vi.fn().mockResolvedValue(Response.json({
      items: [{
        id: "task-1",
        title: "契約更新",
        version: 7,
        status: "waiting",
        priority: "high",
        assignee_display_name: "梅田さん",
        project_codes: ["back-office"],
      }],
      has_more: true,
      next_cursor: "opaque+/=",
      read_status: "partial",
    }));
    const proxy = createTaskSearchProxyHandler(canonical);
    const env = {
      RUNTIME_TASK_SEARCH_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office,brainbase",
      BRAINBASE_TASK_API_BASE_URL: "https://canonical.example.test",
      BRAINBASE_TASK_API_TOKEN: "brainbase-secret-canary",
    };
    const throughWorker = (input: RequestInfo | URL, init?: RequestInit) =>
      proxy(new Request(input, init), env);

    const rpc = await processTaskSearchRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_tasks",
        arguments: { query: "契約更新", limit: 1 },
      },
    }, throughWorker);

    expect(rpc?.result).toMatchObject({ isError: false });
    const [canonicalUrl, canonicalInit] = canonical.mock.calls[0] as [string, RequestInit];
    const url = new URL(canonicalUrl);
    expect(url.pathname).toBe("/api/companion/tasks/search");
    expect(url.searchParams.get("query")).toBe("契約更新");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.getAll("project_code")).toEqual(["back-office", "brainbase"]);
    expect(new Headers(canonicalInit.headers).get("authorization")).toBe("Bearer brainbase-secret-canary");
    const resultText = (rpc?.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(resultText)).toMatchObject({
      items: [{
        title: "契約更新",
        version: 7,
        status: "waiting",
        assignee_display_name: "梅田さん",
        project_codes: ["back-office"],
      }],
      has_more: true,
      next_cursor: "opaque+/=",
      read_status: "partial",
    });
    expect(resultText).not.toContain("brainbase-secret-canary");
  });
});
