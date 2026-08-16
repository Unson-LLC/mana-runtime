import { deny } from "./errors.js";

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
  object_key: string;
  tenant_id: string;
  reason: "expired" | "operation_complete" | "revoked" | "manual_policy";
  deleted_at: string;
  outcome: "deleted" | "not_found" | "failed";
}

export function createDeletionReceipt(input: Omit<DeletionReceipt, "schema_version">): DeletionReceipt {
  if (!input.object_key.startsWith("tp1/")) deny("temporary_object", "TENANT_PARTITION_INVALID");
  return { schema_version: "1.0", ...structuredClone(input) };
}
