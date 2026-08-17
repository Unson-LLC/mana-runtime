/** Canonical wire reference types. Keep in lock-step with ../schema.json. */

export type Revision = `${bigint}`;
export type ProtocolVersion = `1.${number}`;
export type Timestamp = string;
export type PrefixedUlid = `${
  | 'ten'
  | 'wsc'
  | 'dep'
  | 'cor'
  | 'op'
  | 'lease'
  | 'usage'
  | 'receipt'}_${string}`;
export type IdempotencyKey = `ik1_${string}`;
export type Sha256 = `sha256:${string}`;

export type CredentialMode =
  | 'cloud_standard'
  | 'customer_oauth'
  | 'customer_api';
export type CollectionState = 'collected' | 'partial' | 'not_collected';
export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export type DeploymentProfile =
  | 'shared_cloud'
  | 'dedicated_cloud'
  | 'customer_managed_oss';
export type RequiredCapability =
  | 'signed_tenant_context'
  | 'connection_revision_recheck'
  | 'tenant_scoped_authorization'
  | 'credential_broker_v1'
  | 'usage_receipt_v1'
  | 'idempotent_effects_v1'
  | 'container_sanitization_v1';

export interface ProtocolNegotiationRequest {
  message_type: 'protocol_negotiation_request';
  protocol_id: 'mana-brainbase-tenant-context';
  supported_range: '>=1.0 <2.0';
  supported_versions: ProtocolVersion[];
  required_capabilities: RequiredCapability[];
  optional_capabilities: string[];
  deployment_id: PrefixedUlid;
  deployment_profile: DeploymentProfile;
}

export interface OptionalCapabilityStatus {
  capability: string;
  status: 'supported' | 'unsupported' | 'non_applicable';
  reason?: string;
}

export interface ProtocolNegotiationResponse {
  message_type: 'protocol_negotiation_response';
  protocol_id: 'mana-brainbase-tenant-context';
  selected_version: ProtocolVersion;
  supported_range: '>=1.0 <2.0';
  supported_versions: ProtocolVersion[];
  required_capabilities: RequiredCapability[];
  optional_capabilities: OptionalCapabilityStatus[];
  compatibility_until: Timestamp;
}

export interface TenantContextUnsigned {
  schema_version: '1.0';
  protocol_id: 'mana-brainbase-tenant-context';
  protocol_version: ProtocolVersion;
  issuer: 'brainbase';
  audience: string[];
  tenant: {
    tenant_id: PrefixedUlid;
    tenant_revision: Revision;
  };
  workspace_connection: {
    connection_id: PrefixedUlid;
    connection_revision: Revision;
    status: 'active';
    provider: 'slack';
    installation_id: string;
    workspace_id: string;
    app_id: string;
  };
  actor: {
    principal_id: string;
    principal_type: 'person' | 'service';
    authenticated_subject_id: string;
    delegated_by?: string;
  };
  authorization: {
    organization_ids: string[];
    project_ids: string[];
    data_scopes: string[];
    capability_ids: string[];
  };
  placement: {
    deployment_id: PrefixedUlid;
    profile: DeploymentProfile;
  };
  slack: {
    event_id: string;
    channel_id: string;
    enterprise_id?: string;
    thread_ts?: string;
    requester_id?: string;
  };
  correlation_id: PrefixedUlid;
  operation_id: PrefixedUlid;
  idempotency_key: IdempotencyKey;
  contract_revision: Revision;
  credential: {
    mode: CredentialMode;
    credential_ref: string;
    billing_principal_id: string;
  };
  issued_at: Timestamp;
  expires_at: Timestamp;
}

export interface TenantContextEnvelope extends TenantContextUnsigned {
  integrity: {
    method: 'jws_detached';
    algorithm: 'EdDSA';
    key_id: string;
    value: string;
  };
}

export interface CredentialLeaseBinding {
  tenant_id: PrefixedUlid;
  connection_id: PrefixedUlid;
  connection_revision: Revision;
  contract_revision: Revision;
  operation_id: PrefixedUlid;
  audience: string;
  credential_mode: CredentialMode;
  credential_ref: string;
}

export interface CredentialLeaseRequest {
  message_type: 'credential_lease_request';
  protocol_version: ProtocolVersion;
  binding: CredentialLeaseBinding;
  requested_ttl_seconds: number;
}

export interface CredentialLeaseResponse {
  message_type: 'credential_lease_response';
  protocol_version: ProtocolVersion;
  lease_id: PrefixedUlid;
  contract_revision: Revision;
  binding: CredentialLeaseBinding;
  issued_at: Timestamp;
  expires_at: Timestamp;
  max_uses: 1;
  /** Opaque broker handle. Never raw OAuth/API material. */
  lease_token: string;
}

export type QuotaDecisionValue =
  | 'allowed'
  | 'warning'
  | 'hard_stopped'
  | 'approval_required'
  | 'unavailable';

export interface QuotaDecision {
  message_type: 'quota_decision';
  tenant_id: PrefixedUlid;
  contract_revision: Revision;
  quota_revision: Revision;
  decision: QuotaDecisionValue;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  unit: string;
  window_started_at: Timestamp;
  window_ends_at: Timestamp;
  decided_at: Timestamp;
  failure_code?: string | null;
}

export interface UsageEvent {
  message_type: 'usage_event';
  usage_event_id: PrefixedUlid;
  protocol_version: ProtocolVersion;
  tenant_id: PrefixedUlid;
  connection_id: PrefixedUlid;
  connection_revision: Revision;
  contract_revision: Revision;
  deployment_id: PrefixedUlid;
  correlation_id: PrefixedUlid;
  operation_id: PrefixedUlid;
  idempotency_key: IdempotencyKey;
  kind: string;
  quantity: number | null;
  unit: string;
  collection_state: CollectionState;
  outcome: Outcome;
  failure_code: string | null;
  unknown_fields: string[];
  observed_at: Timestamp;
}

export interface OperationReceipt {
  message_type: 'operation_receipt';
  receipt_id: PrefixedUlid;
  protocol_version: ProtocolVersion;
  tenant_id: PrefixedUlid;
  connection_id: PrefixedUlid;
  connection_revision: Revision;
  contract_revision: Revision;
  deployment_id: PrefixedUlid;
  correlation_id: PrefixedUlid;
  operation_ids: PrefixedUlid[];
  idempotency_keys: IdempotencyKey[];
  actor_principal_id: string;
  project_id: string | null;
  capability_id: string;
  quota_decision: QuotaDecisionValue;
  credential_mode: CredentialMode;
  collection_state: CollectionState;
  outcome: Outcome;
  failure_code: string | null;
  usage_event_ids: PrefixedUlid[];
  reply: {
    state: 'not_attempted' | 'delivered' | 'failed' | 'unknown';
    reply_count: 0 | 1;
    legacy_reply_count: 0;
    slack_reply_ts?: string;
  };
  completed_at: Timestamp;
}

export type IdempotencyClaimScope =
  | 'credential_lease'
  | 'quota_decision'
  | 'business_effect'
  | 'usage_receipt'
  | 'queue_execution'
  | 'slack_delivery';

export interface IdempotencyClaim {
  message_type: 'idempotency_claim';
  owner: 'brainbase' | 'mana_runtime';
  scope: IdempotencyClaimScope;
  tenant_id: PrefixedUlid;
  connection_id: PrefixedUlid;
  slack_event_id: string;
  operation_id: PrefixedUlid;
  idempotency_key: IdempotencyKey;
  context_hash: Sha256;
  payload_hash: Sha256;
  state: 'pending' | 'claimed' | 'succeeded' | 'failed_terminal';
  retention_until: Timestamp;
}
