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
  refresh?: {
    issue(): Promise<TenantContextEnvelope>;
    now(): string;
    before_expiry_ms?: number;
  };
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
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let refreshInFlight: Promise<void> | undefined;
      let stopped = false;
      let rejectRefresh: ((reason?: unknown) => void) | undefined;
      const refreshFailure = new Promise<never>((_resolve, reject) => { rejectRefresh = reject; });
      const scheduleRefresh = (context: TenantContextEnvelope): void => {
        if (!input.refresh) return;
        const beforeExpiryMs = input.refresh.before_expiry_ms ?? 60_000;
        const delayMs = Math.max(0, Date.parse(context.expires_at) - Date.parse(input.refresh.now()) - beforeExpiryMs);
        refreshTimer = setTimeout(() => {
          refreshInFlight = (async () => {
            const fresh = await input.refresh!.issue();
            if (stopped) return;
            await registry.refresh(handle, { tenant_context: fresh, now: input.refresh!.now() });
            if (!stopped) scheduleRefresh(fresh);
          })();
          void refreshInFlight.catch(rejectRefresh);
        }, delayMs);
      };
      try {
        scheduleRefresh(input.tenant_context);
        return input.refresh
          ? await Promise.race([input.execute(handle), refreshFailure])
          : await input.execute(handle);
      } finally {
        stopped = true;
        if (refreshTimer !== undefined) clearTimeout(refreshTimer);
        await refreshInFlight?.catch(() => undefined);
        if (input.release !== "on_expiration") await registry.dispose(handle);
      }
    },
  });
}
