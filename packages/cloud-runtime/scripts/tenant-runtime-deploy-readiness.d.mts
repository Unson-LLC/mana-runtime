export interface WranglerDeploymentConfig {
  vars?: Record<string, unknown>;
  services?: Array<{ binding?: unknown; service?: unknown }>;
  durable_objects?: { bindings?: Array<{ name?: unknown; class_name?: unknown }> };
  migrations?: Array<{ tag?: unknown; new_sqlite_classes?: unknown }>;
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

export interface TenantRuntimeSourceLockPaths {
  tenantContext: string;
  trustedProviderForwarder: string;
}

export interface TenantRuntimeDeploymentAuthorizationContext {
  deploymentTarget?: string;
  candidateCommit?: string;
  reviewedCommit?: string;
  now?: string | Date;
}

export function assertTenantRuntimeAuthorizationOnlyChild(options: {
  reviewedCommit?: string;
  candidateCommit?: string;
  candidateParentCommits?: string[];
  changedEntries?: string[];
}): { reviewedCommit: string; candidateCommit: string };

export function assertTenantRuntimeSourceLocks(options?: {
  readFileImpl?: (path: string, encoding: "utf8") => Promise<string | Buffer>;
  sourceLockPaths?: TenantRuntimeSourceLockPaths;
  deploymentTarget?: string;
  candidateCommit?: string;
  reviewedCommit?: string;
  now?: string | Date;
}): Promise<{ tenantContext: Record<string, unknown>; trustedProviderForwarder: Record<string, unknown> }>;

export function assertTenantRuntimeDeploymentPreflight(options: {
  configPath: string;
  execFileImpl?: (
    file: string,
    args: string[],
    options: { cwd: string; encoding: "utf8"; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
  readFileImpl?: (path: string, encoding: "utf8") => Promise<string | Buffer>;
  sourceLockPaths?: TenantRuntimeSourceLockPaths;
  deploymentTarget?: string;
  candidateCommit?: string;
  reviewedCommit?: string;
  now?: string | Date;
}): Promise<{ config: WranglerDeploymentConfig; tenantId: string }>;

export function assertTenantRuntimeHealthReady(options: {
  baseUrl: string;
  expectedTenantId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; tenant_runtime: { ready: true; missing_bindings: [] }; tenant: string }>;
