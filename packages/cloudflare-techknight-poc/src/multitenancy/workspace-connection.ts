import type { WorkspaceConnectionSnapshot } from "./contracts.js";
import { deny } from "./errors.js";

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
