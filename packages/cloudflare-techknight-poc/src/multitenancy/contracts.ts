export const TENANT_PROTOCOL_ID = "mana-brainbase-tenant-context" as const;
export const TENANT_PROTOCOL_MAJOR = 1;
export const TENANT_CONTEXT_MAX_TTL_SECONDS = 300;
export const TENANT_CONTEXT_CLOCK_SKEW_SECONDS = 30;

export const REQUIRED_TENANT_CAPABILITIES = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
] as const;

export type DeploymentProfileName =
  | "shared_cloud"
  | "dedicated_cloud"
  | "customer_managed_oss";
export type CredentialMode = "cloud_standard" | "customer_oauth" | "customer_api";
export type WorkspaceConnectionStatus =
  | "active"
  | "reauth_required"
  | "revoked"
  | "uninstalled"
  | "expired";

export interface WorkspaceConnectionSnapshot {
  connection_id: string;
  connection_revision: string;
  tenant_id: string;
  installation_id: string;
  workspace_id: string;
  enterprise_id?: string;
  app_id: string;
  installer_id: string;
  granted_scopes: string[];
  status: WorkspaceConnectionStatus;
  deployment_id: string;
  profile: DeploymentProfileName;
  credential_mode: CredentialMode;
  contract_revision: string;
}

export interface UnsignedTenantContextEnvelope {
  schema_version: "1.0";
  protocol_id: typeof TENANT_PROTOCOL_ID;
  protocol_version: `1.${number}`;
  issuer: "brainbase";
  audience: string[];
  tenant: { tenant_id: string; tenant_revision: string };
  workspace_connection: {
    connection_id: string;
    connection_revision: string;
    provider: "slack";
    installation_id: string;
    workspace_id: string;
    enterprise_id?: string;
    app_id: string;
    status: WorkspaceConnectionStatus;
  };
  actor: {
    principal_id: string;
    principal_type: "person" | "service";
    authenticated_subject_id: string;
    delegated_by?: string;
  };
  authorization: {
    organization_ids: string[];
    project_ids: string[];
    data_scopes: string[];
    capability_ids: string[];
  };
  placement: { deployment_id: string; profile: DeploymentProfileName };
  slack: {
    event_id: string;
    channel_id: string;
    enterprise_id?: string;
    thread_ts?: string;
    requester_id?: string;
  };
  correlation_id: string;
  operation_id: string;
  idempotency_key: string;
  contract_revision: string;
  credential: {
    mode: CredentialMode;
    credential_ref: string;
    billing_principal_id: string;
  };
  issued_at: string;
  expires_at: string;
}

export interface TenantContextEnvelope extends UnsignedTenantContextEnvelope {
  integrity: {
    method: "jws_detached";
    algorithm: "EdDSA";
    key_id: string;
    value: string;
  };
}

export type BoundaryName =
  | "worker_ingress"
  | "queue_consumer"
  | "durable_object"
  | "container_launch"
  | "mcp_gateway"
  | "brainbase_proxy"
  | "slack_delivery"
  | "credential_lease";

export interface ExpectedTenantScope {
  audience: string;
  workspace_id: string;
  app_id: string;
  channel_id: string;
  thread_ts: string;
  actor_principal_id: string;
  project_id: string;
  capability_id: string;
  deployment_id: string;
}

export interface TenantPartitionInput {
  tenant_id: string;
  resource_type:
    | "durable_object"
    | "session"
    | "thread_history"
    | "file"
    | "object"
    | "cache"
    | "workspace"
    | "mcp_config"
    | "secret_handle"
    | "usage"
    | "idempotency";
  connection_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  resource_id: string;
}

export interface ContainerLease {
  container_id: string;
  tenant_id: string;
  lease_id: string;
  operation_id: string;
  state: "clean" | "leased" | "dirty" | "destroyed";
  sanitization_receipt_id?: string;
  leased_at: string;
  expires_at: string;
}

export interface ContainerSanitizationReceipt {
  sanitation_receipt_id: string;
  lease_id: string;
  tenant_hash: string;
  operation_id: string;
  checks: Record<string, boolean>;
  completed_at: string;
  image_digest: string;
  result: "passed" | "failed" | "unobservable";
}

export interface DeploymentProfile {
  profile: DeploymentProfileName;
  physical_isolation: "tenant_partition" | "deployment";
  supported_credential_modes: CredentialMode[];
  capabilities: string[];
  runtime_version: string;
}

export interface CredentialLeaseBinding {
  tenant_id: string;
  connection_id: string;
  connection_revision: string;
  contract_revision: string;
  operation_id: string;
  audience: string;
  credential_mode: CredentialMode;
  credential_ref: string;
}

export interface CredentialLeaseRequest {
  message_type: "credential_lease_request";
  protocol_version: `1.${number}`;
  binding: CredentialLeaseBinding;
  requested_ttl_seconds: number;
}

export interface CredentialLease {
  message_type: "credential_lease_response";
  protocol_version: `1.${number}`;
  lease_id: string;
  contract_revision: string;
  binding: CredentialLeaseBinding;
  issued_at: string;
  expires_at: string;
  max_uses: 1;
  lease_token: string;
}

export interface QuotaDecision {
  message_type: "quota_decision";
  tenant_id: string;
  contract_revision: string;
  quota_revision: string;
  decision: "allowed" | "warning" | "hard_stopped" | "approval_required" | "unavailable";
  limit: number | null;
  used: number | null;
  remaining: number | null;
  unit: string;
  window_started_at: string;
  window_ends_at: string;
  decided_at: string;
  failure_code?: string | null;
}

export type CollectionState = "collected" | "partial" | "not_collected";
export type OperationOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
