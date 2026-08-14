export interface NocodbRpcMessage {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface NocodbRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: { code: number; message: string };
}

export function processNocodbRpcMessage(
  message: NocodbRpcMessage,
  fetchImpl?: typeof fetch,
): Promise<NocodbRpcResponse>;
