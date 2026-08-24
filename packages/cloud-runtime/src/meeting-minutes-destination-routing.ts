import type { MeetingMinutesDestination } from "./meeting-minutes-contracts.js";
import type { WorkspaceConnectionSnapshot } from "./multitenancy/contracts.js";
import { deny } from "./multitenancy/errors.js";

/**
 * The legacy deployment binding contained only an organization -> workspace
 * map.  Keep accepting that shape, but allow the deployment contract to pin
 * the app as well.  An app must never be inferred from the source worker when
 * a destination is a different workspace.
 */
export type MeetingMinutesDestinationTeamBinding = string | {
  workspace_id?: unknown;
  workspaceId?: unknown;
  app_id?: unknown;
  appId?: unknown;
};

export interface MeetingMinutesDestinationSlackBinding {
  workspace_id: string;
  app_id: string;
}

const identifierPattern = /^[A-Za-z0-9_-]{2,64}$/;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertIdentifier(value: string | undefined): string {
  if (!value || !identifierPattern.test(value)) deny("runtime_configuration", "CONFIGURATION_INVALID");
  return value;
}

function normalizeBinding(value: unknown): MeetingMinutesDestinationTeamBinding {
  if (typeof value === "string") return assertIdentifier(value.trim());
  const candidate = object(value);
  if (!candidate) deny("runtime_configuration", "CONFIGURATION_INVALID");
  const workspaceId = text(candidate.workspace_id) ?? text(candidate.workspaceId);
  const appId = text(candidate.app_id) ?? text(candidate.appId);
  return {
    workspace_id: assertIdentifier(workspaceId),
    app_id: assertIdentifier(appId),
  };
}

/** Parse the organization -> destination workspace[/app] deployment contract. */
export function parseMeetingMinutesDestinationTeamBindings(
  value: string | undefined,
): Readonly<Record<string, MeetingMinutesDestinationTeamBinding>> {
  if (!value?.trim()) deny("runtime_configuration", "CONFIGURATION_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    deny("runtime_configuration", "CONFIGURATION_INVALID");
  }
  const record = object(parsed);
  if (!record) deny("runtime_configuration", "CONFIGURATION_INVALID");
  const bindings: Record<string, MeetingMinutesDestinationTeamBinding> = {};
  for (const [organizationId, binding] of Object.entries(record)) {
    if (!identifierPattern.test(organizationId)) deny("runtime_configuration", "CONFIGURATION_INVALID");
    bindings[organizationId] = normalizeBinding(binding);
  }
  return bindings;
}

function destinationConfiguredBinding(
  destination: MeetingMinutesDestination,
): MeetingMinutesDestinationSlackBinding | undefined {
  const candidate = destination as MeetingMinutesDestination & {
    slackWorkspaceId?: unknown;
    slackAppId?: unknown;
    workspaceId?: unknown;
    appId?: unknown;
  };
  const workspaceId = text(candidate.slackWorkspaceId) ?? text(candidate.workspaceId);
  const appId = text(candidate.slackAppId) ?? text(candidate.appId);
  if (workspaceId === undefined && appId === undefined) return undefined;
  return {
    workspace_id: assertIdentifier(workspaceId),
    app_id: assertIdentifier(appId),
  };
}

function trustedDestinationConnections(input: {
  workspaceId: string;
  trustedWorkspaceConnections: readonly WorkspaceConnectionSnapshot[];
  sourceTenantId?: string;
  sourceDeploymentId?: string;
  sourceProfile?: WorkspaceConnectionSnapshot["profile"];
}): WorkspaceConnectionSnapshot[] {
  const allWorkspaceMatches = input.trustedWorkspaceConnections.filter((connection) =>
    connection.workspace_id === input.workspaceId);
  const tenantIds = new Set(allWorkspaceMatches.map((connection) => connection.tenant_id));
  if ((input.sourceTenantId === undefined && tenantIds.size > 1) ||
    (input.sourceTenantId !== undefined && allWorkspaceMatches.some((connection) =>
      connection.tenant_id !== input.sourceTenantId))) {
    deny("slack_delivery", "CROSS_TENANT_CANDIDATE");
  }
  return allWorkspaceMatches.filter((connection) =>
    (input.sourceTenantId === undefined || connection.tenant_id === input.sourceTenantId) &&
    (input.sourceDeploymentId === undefined || connection.deployment_id === input.sourceDeploymentId) &&
    (input.sourceProfile === undefined || connection.profile === input.sourceProfile));
}

/**
 * Resolve the exact workspace and app used by destination Slack delivery.
 * Trusted workspace connections win over legacy workspace-only bindings.  A
 * workspace-only binding is allowed to reuse the source app only for the same
 * workspace; cross-workspace delivery requires an explicit app or a trusted
 * connection carrying that app.
 */
export function resolveMeetingMinutesDestinationSlackBinding(input: {
  organizationId: string;
  destination: MeetingMinutesDestination;
  destinationTeamIdsJson: string | undefined;
  trustedWorkspaceConnections: readonly WorkspaceConnectionSnapshot[];
  sourceTenantId?: string;
  sourceWorkspaceId?: string;
  sourceAppId?: string;
  sourceDeploymentId?: string;
  sourceProfile?: WorkspaceConnectionSnapshot["profile"];
}): MeetingMinutesDestinationSlackBinding {
  const configured = parseMeetingMinutesDestinationTeamBindings(input.destinationTeamIdsJson)[input.organizationId];
  if (configured === undefined) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");

  const configuredBinding: MeetingMinutesDestinationSlackBinding = typeof configured === "string"
    ? { workspace_id: configured, app_id: "" }
    : {
      workspace_id: assertIdentifier(text(configured.workspace_id) ?? text(configured.workspaceId)),
      app_id: assertIdentifier(text(configured.app_id) ?? text(configured.appId)),
    };
  const destinationBinding = destinationConfiguredBinding(input.destination);
  if (destinationBinding && destinationBinding.workspace_id !== configuredBinding.workspace_id) {
    deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
  }
  if (destinationBinding && configuredBinding.app_id && destinationBinding.app_id !== configuredBinding.app_id) {
    deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
  }

  const workspaceId = destinationBinding?.workspace_id ?? configuredBinding.workspace_id;
  const trusted = trustedDestinationConnections({
    workspaceId,
    trustedWorkspaceConnections: input.trustedWorkspaceConnections,
    sourceTenantId: input.sourceTenantId,
    sourceDeploymentId: input.sourceDeploymentId,
    sourceProfile: input.sourceProfile,
  });
  const trustedAppIds = [...new Set(trusted.map((connection) => connection.app_id))];
  if (trustedAppIds.length > 1) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");

  const configuredAppId = destinationBinding?.app_id ?? (configuredBinding.app_id || undefined);
  if (configuredAppId && trustedAppIds.length === 1 && configuredAppId !== trustedAppIds[0]) {
    deny("slack_delivery", "WORKSPACE_OR_APP_MISMATCH");
  }
  const appId = trustedAppIds[0] ?? configuredAppId ??
    (workspaceId === input.sourceWorkspaceId ? text(input.sourceAppId) : undefined);
  if (!appId) deny("slack_delivery", "DELIVERY_SCOPE_MISMATCH");
  return { workspace_id: workspaceId, app_id: assertIdentifier(appId) };
}

/** Preserve task-action compatibility when the destination map uses objects. */
export function destinationTeamIdsForTaskActions(
  value: string | undefined,
): Readonly<Record<string, string>> {
  const bindings = parseMeetingMinutesDestinationTeamBindings(value);
  return Object.fromEntries(Object.entries(bindings).map(([organizationId, binding]) => [
    organizationId,
    typeof binding === "string"
      ? binding
      : assertIdentifier(text(binding.workspace_id) ?? text(binding.workspaceId)),
  ]));
}
