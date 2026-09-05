import { describe, expect, it } from "vitest";

import type { MeetingMinutesRecoveryAuthorization } from "../meeting-minutes-contracts.js";
import type { TenantContextEnvelope } from "../multitenancy/contracts.js";
import { hasStableMeetingMinutesRecoveryAuthority } from "../meeting-minutes-recovery-authority.js";

const authorization: MeetingMinutesRecoveryAuthorization = {
  tenantId: "tenant-a",
  tenantRevision: "1",
  connectionId: "connection-old",
  connectionRevision: "1",
  workspaceId: "T-WORKSPACE",
  appId: "A-MANA",
  channelId: "C-ROUTER",
  threadTs: "100.200",
  requesterId: "U-REQUESTER",
  actorPrincipalId: "person-a",
  projectIds: ["project-a"],
  audience: "mana-runtime",
  capabilityId: "task.write",
  deploymentId: "deployment-a",
  profile: "shared_cloud",
};

function freshContext(): TenantContextEnvelope {
  return {
    tenant: { tenant_id: "tenant-a", tenant_revision: "2" },
    workspace_connection: {
      connection_id: "connection-new",
      connection_revision: "2",
      workspace_id: "T-WORKSPACE",
      app_id: "A-MANA",
    },
    actor: { principal_id: "person-a", authenticated_subject_id: "U-REQUESTER" },
    slack: {
      channel_id: "C-ROUTER",
      thread_ts: "100.200",
      requester_id: "U-REQUESTER",
    },
    audience: ["mana-runtime"],
    authorization: { project_ids: ["project-a"], capability_ids: ["task.write"] },
    placement: { deployment_id: "deployment-a", profile: "shared_cloud" },
  } as TenantContextEnvelope;
}

describe("hasStableMeetingMinutesRecoveryAuthority", () => {
  it("accepts refreshed revisions and a canonicalized principal for the same external identity and scope", () => {
    const value = freshContext();
    value.actor.principal_id = "person-canonical";
    expect(hasStableMeetingMinutesRecoveryAuthority(value, authorization)).toBe(true);
  });

  it("rejects a different tenant, workspace, authenticated subject, or project", () => {
    for (const mutate of [
      (value: TenantContextEnvelope) => { value.tenant.tenant_id = "tenant-b"; },
      (value: TenantContextEnvelope) => { value.workspace_connection.workspace_id = "T-OTHER"; },
      (value: TenantContextEnvelope) => { value.actor.authenticated_subject_id = "U-OTHER"; },
      (value: TenantContextEnvelope) => { value.authorization.project_ids = ["project-b"]; },
    ]) {
      const value = freshContext();
      mutate(value);
      expect(hasStableMeetingMinutesRecoveryAuthority(value, authorization)).toBe(false);
    }
  });
});
