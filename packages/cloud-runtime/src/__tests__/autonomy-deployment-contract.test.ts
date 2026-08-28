import { describe, expect, it } from "vitest";

import {
  parseAutonomyDeploymentContract,
} from "../autonomy-deployment-contract.js";

function contract() {
  return {
    version: "mana-autonomy-deployment.v1",
    tenant: {
      tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      tenant_key: "unson-business",
      tenant_revision: "7",
    },
    organization: { organization_id: "unson" },
    project: {
      project_id: "proj_brainbase",
      project_code: "brainbase",
    },
    workspace_connection: {
      connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      connection_revision: "11",
      workspace_id: "T_UNSON",
      app_id: "A_MANA",
      deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      profile: "shared_cloud",
      contract_revision: "13",
    },
    service_actor: {
      actor_id: "mana_autonomy_v0",
      placement_id: "mana-autonomy",
      registry_capabilities: ["create_task", "read_graph"],
    },
    runtime: {
      channel_id: "C0BKE4D0TK9",
      company_capability_id: "task.create",
      resource_ref: "project:brainbase",
      max_task_writes: 10,
      per_run_budget: 2,
    },
  };
}

describe("autonomy deployment contract", () => {
  it("accepts one exact non-secret canonical rollout snapshot", () => {
    expect(parseAutonomyDeploymentContract(contract())).toEqual(contract());
  });

  it("rejects guessed project scope, actor, capability and hidden fields", () => {
    const mutations: Array<(value: ReturnType<typeof contract>) => void> = [
      (value) => { value.runtime.resource_ref = "project:brainbase-deployment"; },
      (value) => { value.service_actor.actor_id = "slack-user" as "mana_autonomy_v0"; },
      (value) => { value.runtime.company_capability_id = "task.update" as "task.create"; },
      (value) => { (value as unknown as Record<string, unknown>).secret = "forbidden"; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(contract());
      mutate(value);
      expect(() => parseAutonomyDeploymentContract(value)).toThrow();
    }
  });

  it("rejects unsafe budgets, unsupported profile and malformed identifiers", () => {
    for (const mutate of [
      (value: ReturnType<typeof contract>) => { value.runtime.per_run_budget = 4; },
      (value: ReturnType<typeof contract>) => { value.runtime.max_task_writes = 0; },
      (value: ReturnType<typeof contract>) => {
        value.workspace_connection.profile = "dedicated_cloud" as "shared_cloud";
      },
      (value: ReturnType<typeof contract>) => { value.runtime.channel_id = "not a channel"; },
    ]) {
      const value = structuredClone(contract());
      mutate(value);
      expect(() => parseAutonomyDeploymentContract(value)).toThrow();
    }
  });
});
