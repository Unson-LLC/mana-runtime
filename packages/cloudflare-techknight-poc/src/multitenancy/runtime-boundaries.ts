import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { validateTenantBoundary } from "./envelope.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { assertSecretArtifactFree } from "./secret-guard.js";
import type { WorkspaceConnectionLookup } from "./workspace-connection.js";

export interface SlackIngressIdentity extends WorkspaceConnectionLookup {
  installation_id: string;
  event_id: string;
  channel_id: string;
  thread_ts: string;
  requester_id: string;
}

export interface TenantContextIssueRequest {
  workspace_connection: WorkspaceConnectionSnapshot;
  slack: Pick<SlackIngressIdentity,
    "event_id" | "channel_id" | "thread_ts" | "requester_id" | "enterprise_id">;
  required_authorization: {
    audience: string;
    project_id: string;
    capability_id: string;
  };
}

export interface TenantAuthorityClient {
  resolve_workspace_connection(lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot>;
  read_workspace_connection(connectionId: string): Promise<WorkspaceConnectionSnapshot>;
  issue_tenant_context(request: TenantContextIssueRequest): Promise<TenantContextEnvelope>;
}

export interface TenantRuntimeBoundaryVerifierOptions {
  read_authoritative_snapshot(connectionId: string): Promise<WorkspaceConnectionSnapshot>;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
}

async function readAuthoritativeSnapshot(
  read: (connectionId: string) => Promise<WorkspaceConnectionSnapshot>,
  connectionId: string,
  boundary: BoundaryName,
): Promise<WorkspaceConnectionSnapshot> {
  try {
    const snapshot = await read(connectionId);
    if (!snapshot) deny(boundary, "WORKSPACE_CONNECTION_UNAVAILABLE");
    return snapshot;
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny(boundary, "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
}

export class TenantRuntimeBoundaryVerifier {
  readonly #readAuthoritativeSnapshot: TenantRuntimeBoundaryVerifierOptions["read_authoritative_snapshot"];
  readonly #resolveVerificationKey: TenantRuntimeBoundaryVerifierOptions["resolve_verification_key"];

  constructor(options: TenantRuntimeBoundaryVerifierOptions) {
    this.#readAuthoritativeSnapshot = options.read_authoritative_snapshot;
    this.#resolveVerificationKey = options.resolve_verification_key;
  }

  async validate(input: {
    boundary: BoundaryName;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    now: string;
  }): Promise<TenantContextEnvelope> {
    const snapshot = await readAuthoritativeSnapshot(
      this.#readAuthoritativeSnapshot,
      input.tenant_context.workspace_connection.connection_id,
      input.boundary,
    );
    return validateTenantBoundary({
      boundary: input.boundary,
      envelope: input.tenant_context,
      authoritative_snapshot: snapshot,
      expected_scope: input.expected_scope,
      now: input.now,
      resolve_verification_key: this.#resolveVerificationKey,
    });
  }
}

function assertActiveIngressConnection(
  identity: SlackIngressIdentity,
  snapshot: WorkspaceConnectionSnapshot,
  requiredScopes: readonly string[],
): void {
  if (snapshot.status === "revoked" || snapshot.status === "uninstalled" || snapshot.status === "expired") {
    deny("worker_ingress", "WORKSPACE_CONNECTION_REVOKED");
  }
  if (snapshot.status !== "active") deny("worker_ingress", "WORKSPACE_CONNECTION_REAUTH_REQUIRED");
  if (snapshot.app_id !== identity.app_id || snapshot.workspace_id !== identity.workspace_id
    || snapshot.installation_id !== identity.installation_id
    || (identity.enterprise_id !== undefined && snapshot.enterprise_id !== identity.enterprise_id)) {
    deny("worker_ingress", "WORKSPACE_OR_APP_MISMATCH");
  }
  if (requiredScopes.some((scope) => !snapshot.granted_scopes.includes(scope))) {
    deny("worker_ingress", "WORKSPACE_SCOPE_INSUFFICIENT");
  }
}

export async function resolveSlackWorkerIngress(input: {
  identity: SlackIngressIdentity;
  required_scopes: readonly string[];
  required_authorization: TenantContextIssueRequest["required_authorization"];
  authority: TenantAuthorityClient;
  now: string;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
}): Promise<{
  tenant_context: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
}> {
  const lookup: WorkspaceConnectionLookup = {
    provider: "slack",
    app_id: input.identity.app_id,
    workspace_id: input.identity.workspace_id,
    ...(input.identity.enterprise_id ? { enterprise_id: input.identity.enterprise_id } : {}),
  };
  let resolved: WorkspaceConnectionSnapshot;
  try {
    resolved = await input.authority.resolve_workspace_connection(lookup);
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny("worker_ingress", "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
  assertActiveIngressConnection(input.identity, resolved, input.required_scopes);

  const issueRequest: TenantContextIssueRequest = {
    workspace_connection: structuredClone(resolved),
    slack: {
      event_id: input.identity.event_id,
      channel_id: input.identity.channel_id,
      thread_ts: input.identity.thread_ts,
      requester_id: input.identity.requester_id,
      ...(input.identity.enterprise_id ? { enterprise_id: input.identity.enterprise_id } : {}),
    },
    required_authorization: structuredClone(input.required_authorization),
  };
  assertSecretArtifactFree(issueRequest);
  let tenantContext: TenantContextEnvelope;
  try {
    tenantContext = await input.authority.issue_tenant_context(issueRequest);
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny("worker_ingress", "UPSTREAM_UNAVAILABLE");
  }
  if (tenantContext.actor.authenticated_subject_id !== input.identity.requester_id) {
    deny("worker_ingress", "ACTOR_SCOPE_MISMATCH");
  }
  if (tenantContext.slack.event_id !== input.identity.event_id
    || tenantContext.slack.channel_id !== input.identity.channel_id
    || tenantContext.slack.thread_ts !== input.identity.thread_ts
    || tenantContext.slack.requester_id !== input.identity.requester_id) {
    deny("worker_ingress", "DELIVERY_SCOPE_MISMATCH");
  }
  const verifier = new TenantRuntimeBoundaryVerifier({
    read_authoritative_snapshot: (connectionId) => input.authority.read_workspace_connection(connectionId),
    resolve_verification_key: input.resolve_verification_key,
  });
  await verifier.validate({
    boundary: "worker_ingress",
    tenant_context: tenantContext,
    expected_scope: {
      ...input.required_authorization,
      workspace_id: input.identity.workspace_id,
      app_id: input.identity.app_id,
      channel_id: input.identity.channel_id,
      thread_ts: input.identity.thread_ts,
      actor_principal_id: tenantContext.actor.principal_id,
      deployment_id: resolved.deployment_id,
    },
    now: input.now,
  });
  return { tenant_context: tenantContext, authoritative_snapshot: resolved };
}

export async function executeTenantBoundary<T>(input: {
  boundary: BoundaryName;
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  now: string;
  verifier: TenantRuntimeBoundaryVerifier;
  execute(): Promise<T>;
}): Promise<T> {
  await input.verifier.validate({
    boundary: input.boundary,
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    now: input.now,
  });
  return input.execute();
}

export interface TenantQueueBody<T> {
  schema_version: "1.0";
  tenant_context: TenantContextEnvelope;
  payload: T;
}

export interface TenantQueueMessageLike<T> {
  body: TenantQueueBody<T>;
  ack(): void;
  retry(): void;
}

const RETRYABLE_BOUNDARY_CODES = new Set(["WORKSPACE_CONNECTION_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]);

export async function consumeTenantQueueMessage<T, R>(
  message: TenantQueueMessageLike<T>,
  options: {
    verifier: TenantRuntimeBoundaryVerifier;
    expected_scope(body: TenantQueueBody<T>): ExpectedTenantScope;
    now(): string;
    process(payload: T, tenantContext: TenantContextEnvelope): Promise<R>;
    log?(entry: Record<string, string>): void;
    log_error?(entry: Record<string, string>): void;
  },
): Promise<void> {
  const eventId = message.body.tenant_context.slack.event_id;
  try {
    assertSecretArtifactFree(message.body);
    await options.verifier.validate({
      boundary: "queue_consumer",
      tenant_context: message.body.tenant_context,
      expected_scope: options.expected_scope(message.body),
      now: options.now(),
    });
    await options.process(message.body.payload, message.body.tenant_context);
    options.log?.({ event: "tenant_queue_completed", event_id: eventId });
    message.ack();
  } catch (error) {
    const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
    options.log_error?.({ event: "tenant_queue_failed", event_id: eventId, code });
    if (RETRYABLE_BOUNDARY_CODES.has(code)) message.retry();
    else message.ack();
  }
}
