export interface TenantAnthropicProxy {
  baseUrl: string;
  close(): Promise<void>;
}

export function startTenantAnthropicProxy(options: {
  tenantBoundaryHandle: string;
  fetchImpl?: typeof fetch;
}): Promise<TenantAnthropicProxy>;
