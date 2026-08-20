import { processTaskWriteRpcMessage, taskWriteTools } from "../../container/task-write-mcp-server.mjs";

describe("requester-scoped task-write stdio MCP", () => {
  it("exposes only create, update, and transition with bounded call indexes", async () => {
    const result = await processTaskWriteRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: taskWriteTools } });
    expect(taskWriteTools.map((tool) => tool.name)).toEqual(["create_task", "update_task", "transition_task"]);
    for (const tool of taskWriteTools) {
      expect(tool.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: { call_index: { type: "integer", minimum: 1, maximum: 3 } },
      });
    }
    for (const toolName of ["update_task", "transition_task"]) {
      const tool = taskWriteTools.find((candidate) => candidate.name === toolName);
      expect(tool?.inputSchema).toMatchObject({
        properties: { expected_version: { type: "integer", minimum: 1 } },
      });
    }
  });

  it("sends only request capability and arguments to the synthetic endpoint", async () => {
    const previousRequest = process.env.MANA_TASK_WRITE_REQUEST_ID;
    const previousCapability = process.env.MANA_TASK_WRITE_CAPABILITY;
    process.env.MANA_TASK_WRITE_REQUEST_ID = "EvWrite123";
    process.env.MANA_TASK_WRITE_CAPABILITY = "signed-capability";
    try {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ task: { id: "task-1" } }));
      const result = await processTaskWriteRpcMessage({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "create_task", arguments: { project: "back-office", call_index: 1, title: "契約更新" } },
      }, fetchMock);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://task-write.internal/api/task-write");
      expect(new Headers(init.headers).get("x-mana-task-write-capability")).toBe("signed-capability");
      expect(JSON.parse(String(init.body))).toEqual({
        project: "back-office", call_index: 1, title: "契約更新", request_id: "EvWrite123", operation: "create",
      });
      expect(result?.result).toMatchObject({ isError: false });
    } finally {
      if (previousRequest === undefined) delete process.env.MANA_TASK_WRITE_REQUEST_ID;
      else process.env.MANA_TASK_WRITE_REQUEST_ID = previousRequest;
      if (previousCapability === undefined) delete process.env.MANA_TASK_WRITE_CAPABILITY;
      else process.env.MANA_TASK_WRITE_CAPABILITY = previousCapability;
    }
  });

  it("fails closed without a server-issued request capability", async () => {
    const previousRequest = process.env.MANA_TASK_WRITE_REQUEST_ID;
    const previousCapability = process.env.MANA_TASK_WRITE_CAPABILITY;
    delete process.env.MANA_TASK_WRITE_REQUEST_ID;
    delete process.env.MANA_TASK_WRITE_CAPABILITY;
    try {
      const fetchMock = vi.fn();
      const result = await processTaskWriteRpcMessage({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "create_task", arguments: { project: "back-office", call_index: 1, title: "x" } },
      }, fetchMock);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result?.result).toMatchObject({ isError: true });
    } finally {
      if (previousRequest !== undefined) process.env.MANA_TASK_WRITE_REQUEST_ID = previousRequest;
      if (previousCapability !== undefined) process.env.MANA_TASK_WRITE_CAPABILITY = previousCapability;
    }
  });
});
