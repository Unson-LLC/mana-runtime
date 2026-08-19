import type { WorkspaceConnectionSnapshot } from "./contracts.js";
import { deny } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export interface WorkspaceConnectionLookup {
  provider: "slack";
  app_id: string;
  workspace_id: string;
  enterprise_id?: string;
}

function sameLookup(snapshot: WorkspaceConnectionSnapshot, lookup: WorkspaceConnectionLookup): boolean {
  return snapshot.app_id === lookup.app_id
    && snapshot.workspace_id === lookup.workspace_id
    && (lookup.enterprise_id === undefined || snapshot.enterprise_id === lookup.enterprise_id);
}

export class WorkspaceConnectionRegistry {
  readonly #connections = new Map<string, WorkspaceConnectionSnapshot>();

  register(snapshot: WorkspaceConnectionSnapshot): WorkspaceConnectionSnapshot {
    if (this.#connections.has(snapshot.connection_id)) deny("workspace_connection", "WORKSPACE_CONNECTION_ALREADY_EXISTS");
    const stored = structuredClone(snapshot);
    this.#connections.set(snapshot.connection_id, stored);
    return structuredClone(stored);
  }

  resolve(lookup: WorkspaceConnectionLookup): WorkspaceConnectionSnapshot {
    const matches = [...this.#connections.values()].filter((snapshot) => sameLookup(snapshot, lookup));
    if (matches.length === 0) deny("workspace_connection", "TENANT_UNKNOWN");
    if (matches.length !== 1) deny("workspace_connection", "TENANT_AMBIGUOUS");
    return structuredClone(matches[0]);
  }

  resolveActive(
    lookup: WorkspaceConnectionLookup,
    expected: { required_scopes: string[]; expected_revision: string },
  ): WorkspaceConnectionSnapshot {
    const snapshot = this.resolve(lookup);
    if (snapshot.status === "revoked" || snapshot.status === "uninstalled" || snapshot.status === "expired") {
      deny("workspace_connection", "WORKSPACE_CONNECTION_REVOKED");
    }
    if (snapshot.status !== "active") deny("workspace_connection", "WORKSPACE_CONNECTION_REAUTH_REQUIRED");
    if (snapshot.connection_revision !== expected.expected_revision) {
      deny("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
    }
    if (expected.required_scopes.some((scope) => !snapshot.granted_scopes.includes(scope))) {
      deny("workspace_connection", "WORKSPACE_SCOPE_INSUFFICIENT");
    }
    return snapshot;
  }

  revise(
    connectionId: string,
    expectedRevision: string,
    update: Partial<WorkspaceConnectionSnapshot>,
  ): WorkspaceConnectionSnapshot {
    const current = this.#connections.get(connectionId);
    if (!current) deny("workspace_connection", "TENANT_UNKNOWN");
    if (current.connection_revision !== expectedRevision) {
      deny("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
    }
    if (update.connection_id && update.connection_id !== connectionId) deny("workspace_connection", "CROSS_TENANT_CANDIDATE");
    if (update.tenant_id && update.tenant_id !== current.tenant_id) deny("workspace_connection", "CROSS_TENANT_CANDIDATE");
    const next = { ...current, ...structuredClone(update), connection_id: connectionId, tenant_id: current.tenant_id };
    this.#connections.set(connectionId, next);
    return structuredClone(next);
  }
}

export interface WorkspaceConnectionManagementPort {
  register_slack_installation(
    input: {
      provider: "slack";
      app_id: string;
      workspace_id: string;
      enterprise_id?: string;
      installation_id: string;
      installer_id: string;
      granted_scopes: string[];
      authorization_code_ref: string;
    },
    expectedRevision: string,
  ): Promise<WorkspaceConnectionSnapshot>;
  revise_workspace_connection(
    connectionId: string,
    expectedRevision: string,
    update: Partial<Pick<WorkspaceConnectionSnapshot,
      "installation_id" | "installer_id" | "granted_scopes" | "status">>,
  ): Promise<WorkspaceConnectionSnapshot>;
  resolve_workspace_connection(lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot>;
}

export type SlackInstallationLifecycleEvent =
  | {
    kind: "oauth_callback";
    expected_revision: string;
    app_id: string;
    workspace_id: string;
    enterprise_id?: string;
    installation_id: string;
    installer_id: string;
    granted_scopes: string[];
    authorization_code_ref: string;
  }
  | {
    kind: "reauthorized";
    connection_id: string;
    expected_revision: string;
    installation_id: string;
    installer_id: string;
    granted_scopes: string[];
  }
  | {
    kind: "scope_changed";
    connection_id: string;
    expected_revision: string;
    granted_scopes: string[];
  }
  | {
    kind: "app_uninstalled" | "tokens_revoked";
    connection_id: string;
    expected_revision: string;
  };

function assertManagedSnapshot(snapshot: WorkspaceConnectionSnapshot): WorkspaceConnectionSnapshot {
  assertCanonicalSharedId(snapshot.connection_id, "wsc_", "workspace_connection");
  assertCanonicalSharedId(snapshot.tenant_id, "ten_", "workspace_connection");
  assertCanonicalSharedId(snapshot.deployment_id, "dep_", "workspace_connection");
  if (!snapshot.connection_revision || !snapshot.contract_revision || !snapshot.workspace_id
    || !snapshot.app_id || !snapshot.installation_id || !snapshot.installer_id) {
    deny("workspace_connection", "WORKSPACE_CONNECTION_UNAVAILABLE");
  }
  return structuredClone(snapshot);
}

export class SlackInstallationAdapter {
  constructor(private readonly port: WorkspaceConnectionManagementPort) {}

  async apply(event: SlackInstallationLifecycleEvent): Promise<WorkspaceConnectionSnapshot> {
    assertSecretArtifactFree(event);
    if (!event.expected_revision) deny("workspace_connection", "WORKSPACE_CONNECTION_STALE_REVISION");
    if (event.kind === "oauth_callback") {
      const snapshot = await this.port.register_slack_installation({
        provider: "slack",
        app_id: event.app_id,
        workspace_id: event.workspace_id,
        ...(event.enterprise_id ? { enterprise_id: event.enterprise_id } : {}),
        installation_id: event.installation_id,
        installer_id: event.installer_id,
        granted_scopes: [...event.granted_scopes],
        authorization_code_ref: event.authorization_code_ref,
      }, event.expected_revision);
      if (snapshot.app_id !== event.app_id || snapshot.workspace_id !== event.workspace_id
        || snapshot.installation_id !== event.installation_id
        || (event.enterprise_id !== undefined && snapshot.enterprise_id !== event.enterprise_id)) {
        deny("workspace_connection", "WORKSPACE_OR_APP_MISMATCH");
      }
      return assertManagedSnapshot(snapshot);
    }

    const update = event.kind === "reauthorized"
      ? { installation_id: event.installation_id, installer_id: event.installer_id,
        granted_scopes: [...event.granted_scopes], status: "active" as const }
      : event.kind === "scope_changed"
        ? { granted_scopes: [...event.granted_scopes], status: "reauth_required" as const }
        : { status: event.kind === "app_uninstalled" ? "uninstalled" as const : "revoked" as const };
    const snapshot = await this.port.revise_workspace_connection(
      event.connection_id,
      event.expected_revision,
      update,
    );
    if (snapshot.connection_id !== event.connection_id) deny("workspace_connection", "CROSS_TENANT_CANDIDATE");
    return assertManagedSnapshot(snapshot);
  }

  async resolve(lookup: WorkspaceConnectionLookup): Promise<WorkspaceConnectionSnapshot> {
    return assertManagedSnapshot(await this.port.resolve_workspace_connection(structuredClone(lookup)));
  }
}
