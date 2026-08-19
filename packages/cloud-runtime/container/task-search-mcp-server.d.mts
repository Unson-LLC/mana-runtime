export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export const taskSearchToolDefinition: {
  name: "search_tasks";
  description: string;
  inputSchema: Record<string, unknown>;
};

export function processTaskSearchRpcMessage(
  message: JsonRpcRequest,
  fetchImpl?: typeof fetch,
  state?: { searchCalls: number },
): Promise<Record<string, unknown> | null>;
