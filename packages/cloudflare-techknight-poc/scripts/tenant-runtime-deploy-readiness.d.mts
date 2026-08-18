export interface WranglerDeploymentConfig {
  vars?: Record<string, unknown>;
  services?: Array<{ binding?: unknown; service?: unknown }>;
  durable_objects?: { bindings?: Array<{ name?: unknown; class_name?: unknown }> };
}

export interface DeploymentPreflightResult {
  ready: boolean;
  missing_bindings: string[];
}

export function assessTenantRuntimeDeploymentConfig(
  config: WranglerDeploymentConfig,
  secretNames: Iterable<string>,
): DeploymentPreflightResult;

export function parseWranglerSecretNames(output: string): string[];

export function assertTenantRuntimeDeploymentConfig(
  config: WranglerDeploymentConfig,
  secretNames: Iterable<string>,
): DeploymentPreflightResult;

export function assertTenantRuntimeDeploymentPreflight(options: {
  configPath: string;
  execFileImpl?: (
    file: string,
    args: string[],
    options: { cwd: string; encoding: "utf8"; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
}): Promise<{ config: WranglerDeploymentConfig; tenantId: string }>;

export function assertTenantRuntimeHealthReady(options: {
  baseUrl: string;
  expectedTenantId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; tenant_runtime: { ready: true; missing_bindings: [] }; tenant: string }>;
