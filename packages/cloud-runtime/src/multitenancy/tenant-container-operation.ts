import {
  createDurableTenantBoundaryRegistry,
  type TenantBoundaryContextNamespace,
} from "./durable-tenant-boundary.js";
import {
  type ExpectedTenantScope,
  type TenantContextEnvelope,
} from "./contracts.js";
import {
  executeTenantBoundary,
  TenantRuntimeBoundaryVerifier,
} from "./runtime-boundaries.js";

export function executeTenantContainerOperation<T>(input: {
  namespace: TenantBoundaryContextNamespace;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  now: string;
  release?: "on_completion" | "on_expiration";
  company_authority_envelope?: unknown;
  execute(tenantBoundaryHandle: string): Promise<T>;
}): Promise<T> {
  return executeTenantBoundary({
    boundary: "container_launch",
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    verifier: input.verifier,
    now: input.now,
    execute: async () => {
      const registry = createDurableTenantBoundaryRegistry(input.namespace);
      const handle = await registry.register({
        tenant_context: input.tenant_context,
        expected_scope: input.expected_scope,
        ...(input.company_authority_envelope !== undefined
          ? { company_authority_envelope: input.company_authority_envelope }
          : {}),
        now: input.now,
      });
      try {
        return await input.execute(handle);
      } finally {
        if (input.release !== "on_expiration") await registry.dispose(handle);
      }
    },
  });
}
