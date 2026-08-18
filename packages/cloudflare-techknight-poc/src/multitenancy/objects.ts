import { deny } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";
import { assertTenantPartition } from "./isolation.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export function resolveTemporaryObjectExpiry(input: {
  created_at: string;
  contract_ttl_seconds: number | undefined;
  profile_ttl_seconds: number | undefined;
}): string {
  if (input.contract_ttl_seconds === undefined || input.profile_ttl_seconds === undefined) {
    deny("temporary_object", "UPSTREAM_UNAVAILABLE");
  }
  if (input.contract_ttl_seconds <= 0 || input.profile_ttl_seconds <= 0) {
    deny("temporary_object", "TEMPORARY_OBJECT_POLICY_INVALID");
  }
  const createdAt = Date.parse(input.created_at);
  if (!Number.isFinite(createdAt)) deny("temporary_object", "TEMPORARY_OBJECT_POLICY_INVALID");
  const ttl = Math.min(input.contract_ttl_seconds, input.profile_ttl_seconds);
  return new Date(createdAt + ttl * 1_000).toISOString();
}

export interface DeletionReceipt {
  schema_version: "1.0";
  object_key_hash: string;
  tenant_id: string;
  reason: "expired" | "completed" | "revoked";
  deleted_at: string;
  outcome: "deleted" | "not_found" | "failed";
}

export function createDeletionReceipt(input: Omit<DeletionReceipt, "schema_version">): DeletionReceipt {
  assertCanonicalSharedId(input.tenant_id, "ten_", "temporary_object");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.object_key_hash)) deny("temporary_object", "TENANT_PARTITION_INVALID");
  return { schema_version: "1.0", ...structuredClone(input) };
}

export async function hashTenantObjectKey(objectKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(objectKey)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface TenantTemporaryObject {
  schema_version: "1.0";
  object_key: string;
  tenant_id: string;
  connection_id: string;
  correlation_id: string;
  source: "slack_attachment" | "tool_output";
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  expires_at: string;
  status: "available" | "quarantined" | "deleted";
  deletion_receipt_id?: string;
}

export function createTenantTemporaryObject(input: Omit<TenantTemporaryObject, "schema_version" | "expires_at"> & {
  contract: {
    max_size_bytes: number;
    mime_allowlist: string[];
    ttl_seconds: number | undefined;
  };
  deployment_profile_ttl_seconds: number | undefined;
}): TenantTemporaryObject {
  assertSecretArtifactFree(input);
  assertCanonicalSharedId(input.tenant_id, "ten_", "temporary_object");
  assertCanonicalSharedId(input.connection_id, "wsc_", "temporary_object");
  assertCanonicalSharedId(input.correlation_id, "cor_", "temporary_object");
  assertTenantPartition(input.object_key, input.tenant_id);
  if (!Number.isSafeInteger(input.contract.max_size_bytes) || input.contract.max_size_bytes <= 0
    || !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 0
    || input.size_bytes > input.contract.max_size_bytes
    || input.contract.mime_allowlist.length === 0
    || !input.contract.mime_allowlist.includes(input.mime_type)) {
    deny("temporary_object", "TEMPORARY_OBJECT_POLICY_INVALID");
  }
  const expiresAt = resolveTemporaryObjectExpiry({
    created_at: input.created_at,
    contract_ttl_seconds: input.contract.ttl_seconds,
    profile_ttl_seconds: input.deployment_profile_ttl_seconds,
  });
  const { contract: _contract, deployment_profile_ttl_seconds: _profileTtl, ...object } = input;
  return { schema_version: "1.0", ...structuredClone(object), expires_at: expiresAt };
}
