import type {
  ContainerLease,
  ContainerSanitizationReceipt,
  TenantPartitionInput,
} from "./contracts.js";
import { deny } from "./errors.js";

const SANITATION_CHECKS = [
  "child_processes_stopped",
  "workspace_removed",
  "tmp_removed",
  "home_removed",
  "environment_rebuilt",
  "credential_mount_scrubbed",
  "transcript_removed",
  "session_removed",
  "cache_removed",
  "open_handles_closed",
  "same_tenant",
  "fresh_signed_context",
] as const;

export function tenantPartitionKey(input: TenantPartitionInput): string {
  const components = [
    input.tenant_id,
    input.resource_type,
    input.connection_id,
    input.workspace_id,
    input.channel_id,
    input.thread_ts,
    input.resource_id,
  ].map(encodeURIComponent);
  return `tp1/${components.join("/")}`;
}

export function assertTenantPartition(key: string, tenantId: string): string {
  const [version, encodedTenant, ...remaining] = key.split("/");
  if (version !== "tp1" || !encodedTenant || remaining.length !== 6) deny("tenant_partition", "TENANT_PARTITION_INVALID");
  let partitionTenant: string;
  try {
    partitionTenant = decodeURIComponent(encodedTenant);
  } catch {
    deny("tenant_partition", "TENANT_PARTITION_INVALID");
  }
  if (partitionTenant !== tenantId) deny("tenant_partition", "CROSS_TENANT_CANDIDATE");
  return key;
}

export async function prepareContainerReuse(
  lease: ContainerLease,
  nextTenantId: string,
  operationId: string,
  evidence: {
    image_digest: string;
    completed_at: string;
    checks: Record<string, boolean>;
    destroy: () => Promise<void>;
  },
): Promise<ContainerSanitizationReceipt> {
  const crossTenant = lease.tenant_id !== nextTenantId;
  const complete = SANITATION_CHECKS.every((check) => evidence.checks[check] === true);
  if (crossTenant || !complete || lease.state !== "dirty" || lease.operation_id !== operationId) {
    await evidence.destroy();
    deny("container_launch", "CONTAINER_SANITIZATION_UNPROVEN", {
      container_id: lease.container_id,
      destroyed: true,
    });
  }
  return {
    schema_version: "1.0",
    container_id: lease.container_id,
    previous_tenant_id: lease.tenant_id,
    next_tenant_id: nextTenantId,
    operation_id: operationId,
    image_digest: evidence.image_digest,
    completed_at: evidence.completed_at,
    checks: structuredClone(evidence.checks),
    result: "passed",
  };
}
