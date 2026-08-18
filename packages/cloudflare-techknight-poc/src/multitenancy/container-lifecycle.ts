import { deny } from "./errors.js";

export interface TenantContainerResource {
  destroy(): Promise<void>;
}

/**
 * Canonical tenant operations never reuse a pre-existing Container. A fresh,
 * unguessable identity is used for every attempt, including Queue retries.
 */
export function freshTenantContainerId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function assertFreshTenantContainer(
  tenantBoundaryHandle: string | undefined,
  reuseCandidate: unknown,
): void {
  if (tenantBoundaryHandle && reuseCandidate !== undefined) {
    deny("container_launch", "CONTAINER_REUSE_FORBIDDEN");
  }
}

/**
 * A failed destroy leaves sanitization unproven. Never report the tenant
 * operation as successful in that state and never expose the provider error.
 */
export async function destroyTenantContainer(resource: TenantContainerResource): Promise<void> {
  try {
    await resource.destroy();
  } catch {
    deny("container_launch", "CONTAINER_SANITIZATION_UNPROVEN");
  }
}
