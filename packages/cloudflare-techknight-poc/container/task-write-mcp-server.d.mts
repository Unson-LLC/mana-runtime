export interface TaskWriteToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, unknown>;
  };
}

export interface TaskWriteRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: { tools?: readonly TaskWriteToolDefinition[]; content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

export const taskWriteTools: readonly TaskWriteToolDefinition[];
export function processTaskWriteRpcMessage(message: unknown, fetchImpl?: typeof fetch): Promise<TaskWriteRpcResponse>;
