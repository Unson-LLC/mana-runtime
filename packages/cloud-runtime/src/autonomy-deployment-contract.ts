const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const CHANNEL_ID = /^[A-Z0-9]{2,64}$/u;
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/u;
const CONNECTION_ID = /^wsc_[0-9A-HJKMNP-TV-Z]{26}$/u;

export interface AutonomyDeploymentContract {
  version: "mana-autonomy-deployment.v1";
  tenant: {
    tenant_id: string;
    tenant_key: string;
    tenant_revision: string;
  };
  organization: {
    organization_id: string;
  };
  project: {
    project_id: string;
    project_code: string;
  };
  workspace_connection: {
    connection_id: string;
    connection_revision: string;
    workspace_id: string;
    app_id: string;
    deployment_id: string;
    profile: "shared_cloud";
    contract_revision: string;
  };
  service_actor: {
    actor_id: "mana_autonomy_v0";
    placement_id: string;
    registry_capabilities: string[];
  };
  runtime: {
    channel_id: string;
    company_capability_id: "task.create";
    resource_ref: string;
    max_task_writes: number;
    per_run_budget: number;
  };
}

export class AutonomyDeploymentContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutonomyDeploymentContractError";
  }
}

function fail(): never {
  throw new AutonomyDeploymentContractError("autonomy_deployment_contract_invalid");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
}

function text(value: unknown, pattern = IDENTIFIER, max = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value) || !pattern.test(value)) fail();
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) fail();
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail();
  return Number(value);
}

function registryCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) fail();
  const normalized = value.map((item) => text(item));
  if (new Set(normalized).size !== normalized.length) fail();
  return normalized.sort((left, right) => left.localeCompare(right));
}

export function parseAutonomyDeploymentContract(value: unknown): AutonomyDeploymentContract {
  const root = record(value);
  exactKeys(root, ["version", "tenant", "organization", "project", "workspace_connection", "service_actor", "runtime"]);
  if (root.version !== "mana-autonomy-deployment.v1") fail();

  const tenant = record(root.tenant);
  exactKeys(tenant, ["tenant_id", "tenant_key", "tenant_revision"]);
  const organization = record(root.organization);
  exactKeys(organization, ["organization_id"]);
  const project = record(root.project);
  exactKeys(project, ["project_id", "project_code"]);
  const connection = record(root.workspace_connection);
  exactKeys(connection, [
    "connection_id", "connection_revision", "workspace_id", "app_id",
    "deployment_id", "profile", "contract_revision",
  ]);
  const actor = record(root.service_actor);
  exactKeys(actor, ["actor_id", "placement_id", "registry_capabilities"]);
  const runtime = record(root.runtime);
  exactKeys(runtime, [
    "channel_id", "company_capability_id", "resource_ref",
    "max_task_writes", "per_run_budget",
  ]);

  const projectId = text(project.project_id);
  const projectCode = text(project.project_code);
  const resourceRef = text(runtime.resource_ref, /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,499}$/u);
  if (resourceRef !== `project:${projectCode}` && resourceRef !== `project:${projectId}`) fail();
  if (actor.actor_id !== "mana_autonomy_v0") fail();
  if (runtime.company_capability_id !== "task.create") fail();
  if (connection.profile !== "shared_cloud") fail();

  return Object.freeze({
    version: "mana-autonomy-deployment.v1",
    tenant: Object.freeze({
      tenant_id: text(tenant.tenant_id, TENANT_ID),
      tenant_key: text(tenant.tenant_key),
      tenant_revision: revision(tenant.tenant_revision),
    }),
    organization: Object.freeze({
      organization_id: text(organization.organization_id),
    }),
    project: Object.freeze({ project_id: projectId, project_code: projectCode }),
    workspace_connection: Object.freeze({
      connection_id: text(connection.connection_id, CONNECTION_ID),
      connection_revision: revision(connection.connection_revision),
      workspace_id: text(connection.workspace_id),
      app_id: text(connection.app_id),
      deployment_id: text(connection.deployment_id),
      profile: "shared_cloud",
      contract_revision: revision(connection.contract_revision),
    }),
    service_actor: Object.freeze({
      actor_id: "mana_autonomy_v0",
      placement_id: text(actor.placement_id),
      registry_capabilities: Object.freeze(registryCapabilities(actor.registry_capabilities)) as unknown as string[],
    }),
    runtime: Object.freeze({
      channel_id: text(runtime.channel_id, CHANNEL_ID),
      company_capability_id: "task.create",
      resource_ref: resourceRef,
      max_task_writes: integer(runtime.max_task_writes, 1, 20),
      per_run_budget: integer(runtime.per_run_budget, 1, 3),
    }),
  });
}
