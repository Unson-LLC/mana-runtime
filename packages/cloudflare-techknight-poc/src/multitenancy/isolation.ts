import type {
  ContainerLease,
  ContainerSanitizationReceipt,
  TenantPartitionInput,
} from "./contracts.js";
import { deny } from "./errors.js";
import { assertCanonicalSharedId, createDeterministicSharedId } from "./ids.js";

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

const DESTROYED_WITHOUT_REUSE_CHECKS = {
  container_destroyed: true,
  fresh_container_per_attempt: true,
  no_reuse: true,
  cross_tenant_reuse_forbidden: true,
} as const;

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Records the terminal lifecycle of an ephemeral Container that can never be
 * reused. It is deliberately distinct from reuse sanitation and can never
 * authorize a later Container lease.
 */
export async function createDestroyedContainerSanitizationReceipt(input: {
  tenant_id: string;
  operation_id: string;
  container_id: string;
  completed_at: string;
}): Promise<ContainerSanitizationReceipt> {
  assertCanonicalSharedId(input.tenant_id, "ten_", "container_launch");
  assertCanonicalSharedId(input.operation_id, "op_", "container_launch");
  if (!input.container_id.trim() || !Number.isFinite(Date.parse(input.completed_at))) {
    deny("container_launch", "SCHEMA_INVALID");
  }
  const identity = `${input.tenant_id}\n${input.operation_id}\n${input.container_id}`;
  return {
    sanitation_receipt_id: await createDeterministicSharedId("csr_", `sanitation\n${identity}`),
    lease_id: await createDeterministicSharedId("lease_", `container-lease\n${identity}`),
    tenant_hash: `sha256:${await sha256(input.tenant_id)}`,
    operation_id: input.operation_id,
    checks: { ...DESTROYED_WITHOUT_REUSE_CHECKS },
    completed_at: input.completed_at,
    image_digest: "not_applicable:destroyed_without_reuse",
    purpose: "final_destruction",
    reuse_eligible: false,
    result: "passed",
  };
}

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
  const tenantHash = await sha256(lease.tenant_id);
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
    purpose: "reuse_sanitization",
    reuse_eligible: evidence.observable !== false
      && !crossTenant
      && complete
      && lease.state === "dirty"
      && lease.operation_id === operationId
      && unexpired,
    result: evidence.observable === false ? "unobservable"
      : crossTenant || !complete || lease.state !== "dirty" || lease.operation_id !== operationId || !unexpired
        ? "failed"
        : "passed",
  };
  if (receipt.result !== "passed" || !receipt.reuse_eligible) {
    await evidence.destroy();
    deny("container_launch", "CONTAINER_SANITIZATION_UNPROVEN", {
      destroyed: true,
      receipt,
    });
  }
  return receipt;
}
