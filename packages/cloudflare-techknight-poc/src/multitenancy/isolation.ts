import type {
  ContainerLease,
  ContainerSanitizationReceipt,
  TenantPartitionInput,
} from "./contracts.js";
import { deny } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";

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
  assertCanonicalSharedId(input.tenant_id, "ten_", "tenant_partition");
  const encode = (value: string): string => {
    if (value === "") return "_";
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const components = [
    encode(input.tenant_id),
    input.resource_type,
    input.connection_id,
    input.workspace_id,
    input.channel_id,
    input.thread_ts,
    input.resource_id,
  ].map((value, index) => index < 2 ? value : encode(value));
  return `tp1/${components.join("/")}`;
}

export function assertTenantPartition(key: string, tenantId: string): string {
  const [version, encodedTenant, ...remaining] = key.split("/");
  if (version !== "tp1" || !encodedTenant || remaining.length !== 6) deny("tenant_partition", "TENANT_PARTITION_INVALID");
  let partitionTenant: string;
  try {
    const normalized = encodedTenant.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    partitionTenant = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
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
    sanitation_receipt_id: string;
    checks: Record<string, boolean>;
    observable?: boolean;
    destroy: () => Promise<void>;
  },
): Promise<ContainerSanitizationReceipt> {
  assertCanonicalSharedId(lease.container_id, "ctr_", "container_launch");
  assertCanonicalSharedId(lease.tenant_id, "ten_", "container_launch");
  assertCanonicalSharedId(nextTenantId, "ten_", "container_launch");
  assertCanonicalSharedId(operationId, "op_", "container_launch");
  const tenantDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(lease.tenant_id),
  ));
  const tenantHash = [...tenantDigest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const crossTenant = lease.tenant_id !== nextTenantId;
  const complete = SANITATION_CHECKS.every((check) => evidence.checks[check] === true);
  const completedAt = Date.parse(evidence.completed_at);
  const unexpired = Number.isFinite(completedAt) && completedAt <= Date.parse(lease.expires_at);
  const receipt: ContainerSanitizationReceipt = {
    sanitation_receipt_id: evidence.sanitation_receipt_id,
    lease_id: lease.lease_id,
    tenant_hash: `sha256:${tenantHash}`,
    operation_id: operationId,
    checks: structuredClone(evidence.checks),
    completed_at: evidence.completed_at,
    image_digest: evidence.image_digest,
    result: evidence.observable === false ? "unobservable"
      : crossTenant || !complete || lease.state !== "dirty" || lease.operation_id !== operationId || !unexpired
        ? "failed"
        : "passed",
  };
  if (receipt.result !== "passed") {
    await evidence.destroy();
    deny("container_launch", "CONTAINER_SANITIZATION_UNPROVEN", {
      destroyed: true,
      receipt,
    });
  }
  return receipt;
}
