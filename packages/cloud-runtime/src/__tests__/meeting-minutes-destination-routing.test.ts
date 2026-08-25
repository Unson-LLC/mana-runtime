import { describe, expect, it } from "vitest";

import type { MeetingMinutesDestination } from "../meeting-minutes-contracts.js";
import {
  destinationTeamIdsForTaskActions,
  preflightMeetingMinutesDestinationSlackBindings,
  resolveMeetingMinutesDestinationSlackBinding,
} from "../meeting-minutes-destination-routing.js";
import type { WorkspaceConnectionSnapshot } from "../multitenancy/contracts.js";

const destination: MeetingMinutesDestination = {
  id: "alternate-destination",
  projectId: "project-alternate",
  contextProjectCode: "alternate",
  taskProjectCodes: ["alternate"],
  taskBoardTargetId: "board-alternate",
  name: "Alternate destination",
  organization: { id: "alternate", name: "Alternate" },
  slackChannelId: "C-ALT",
  github: { owner: "owner", repo: "repo", branch: "main", pathPrefix: "meetings/" },
};

function connection(overrides: Partial<WorkspaceConnectionSnapshot> = {}): WorkspaceConnectionSnapshot {
  return {
    connection_id: "wsc-source",
    connection_revision: "1",
    tenant_id: "tenant-source",
    installation_id: "slack-source",
    workspace_id: "T-SOURCE",
    app_id: "A-SOURCE",
    installer_id: "brainbase-control-plane",
    granted_scopes: ["chat:write"],
    status: "active",
    deployment_id: "deployment-1",
    profile: "shared_cloud",
    credential_mode: "customer_oauth",
    contract_revision: "1",
    ...overrides,
  };
}

describe("meeting minutes destination Slack routing", () => {
  it("uses the trusted alternate app for direct destination delivery", () => {
    const result = resolveMeetingMinutesDestinationSlackBinding({
      organizationId: "alternate",
      destination,
      destinationTeamIdsJson: JSON.stringify({ alternate: "T-ALT" }),
      trustedWorkspaceConnections: [
        connection(),
        connection({
          connection_id: "wsc-alternate",
          installation_id: "slack-alternate",
          workspace_id: "T-ALT",
          app_id: "A-ALT",
        }),
      ],
      sourceTenantId: "tenant-source",
      sourceWorkspaceId: "T-SOURCE",
      sourceAppId: "A-SOURCE",
      sourceDeploymentId: "deployment-1",
      sourceProfile: "shared_cloud",
    });

    expect(result).toEqual({ workspace_id: "T-ALT", app_id: "A-ALT" });
  });

  it("accepts an explicit workspace/app destination contract without a hint", () => {
    const result = resolveMeetingMinutesDestinationSlackBinding({
      organizationId: "alternate",
      destination: { ...destination, slackWorkspaceId: "T-ALT", slackAppId: "A-ALT" },
      destinationTeamIdsJson: JSON.stringify({
        alternate: { workspace_id: "T-ALT", app_id: "A-ALT" },
      }),
      trustedWorkspaceConnections: [],
      sourceTenantId: "tenant-source",
      sourceWorkspaceId: "T-SOURCE",
      sourceAppId: "A-SOURCE",
      sourceDeploymentId: "deployment-1",
      sourceProfile: "shared_cloud",
    });

    expect(result).toEqual({ workspace_id: "T-ALT", app_id: "A-ALT" });
  });

  it("rejects a trusted destination workspace belonging to another tenant", () => {
    expect(() => resolveMeetingMinutesDestinationSlackBinding({
      organizationId: "alternate",
      destination,
      destinationTeamIdsJson: JSON.stringify({ alternate: "T-ALT" }),
      trustedWorkspaceConnections: [connection({
        connection_id: "wsc-other",
        tenant_id: "tenant-other",
        workspace_id: "T-ALT",
        app_id: "A-ALT",
      })],
      sourceTenantId: "tenant-source",
      sourceWorkspaceId: "T-SOURCE",
      sourceAppId: "A-SOURCE",
      sourceDeploymentId: "deployment-1",
      sourceProfile: "shared_cloud",
    })).toThrow(expect.objectContaining({
      boundary: "slack_delivery",
      code: "CROSS_TENANT_CANDIDATE",
    }));
  });

  it("rejects ambiguous tenant candidates when the source tenant is unavailable", () => {
    expect(() => resolveMeetingMinutesDestinationSlackBinding({
      organizationId: "alternate",
      destination,
      destinationTeamIdsJson: JSON.stringify({ alternate: "T-ALT" }),
      trustedWorkspaceConnections: [
        connection({
          connection_id: "wsc-source-tenant",
          tenant_id: "tenant-source",
          workspace_id: "T-ALT",
          app_id: "A-ALT-1",
        }),
        connection({
          connection_id: "wsc-other-tenant",
          tenant_id: "tenant-other",
          workspace_id: "T-ALT",
          app_id: "A-ALT-2",
        }),
      ],
    })).toThrow(expect.objectContaining({
      boundary: "slack_delivery",
      code: "CROSS_TENANT_CANDIDATE",
    }));
  });

  it("keeps task-action scope checks on the destination workspace for object bindings", () => {
    expect(destinationTeamIdsForTaskActions(JSON.stringify({
      alternate: { workspace_id: "T-ALT", app_id: "A-ALT" },
    }))).toEqual({ alternate: "T-ALT" });
  });

  it("preflights every configured destination with its authoritative workspace/app binding", () => {
    const sameWorkspace: MeetingMinutesDestination = {
      ...destination,
      id: "same-workspace",
      organization: { id: "same-workspace", name: "Same workspace" },
      slackChannelId: "C-SAME",
    };

    expect(preflightMeetingMinutesDestinationSlackBindings({
      destinations: [destination, sameWorkspace],
      destinationTeamIdsJson: JSON.stringify({
        alternate: { workspace_id: "T-ALT", app_id: "A-ALT" },
        "same-workspace": "T-SOURCE",
      }),
      trustedWorkspaceConnections: [
        connection(),
        connection({
          connection_id: "wsc-alternate",
          installation_id: "slack-alternate",
          workspace_id: "T-ALT",
          app_id: "A-ALT",
        }),
      ],
      sourceTenantId: "tenant-source",
      sourceWorkspaceId: "T-SOURCE",
      sourceAppId: "A-SOURCE",
      sourceDeploymentId: "deployment-1",
      sourceProfile: "shared_cloud",
    })).toEqual({
      "alternate-destination": { workspace_id: "T-ALT", app_id: "A-ALT" },
      "same-workspace": { workspace_id: "T-SOURCE", app_id: "A-SOURCE" },
    });
  });

  it("fails the preflight for a cross-workspace destination without an app binding", () => {
    expect(() => preflightMeetingMinutesDestinationSlackBindings({
      destinations: [destination],
      destinationTeamIdsJson: JSON.stringify({ alternate: "T-ALT" }),
      trustedWorkspaceConnections: [],
      sourceTenantId: "tenant-source",
      sourceWorkspaceId: "T-SOURCE",
      sourceAppId: "A-SOURCE",
      sourceDeploymentId: "deployment-1",
      sourceProfile: "shared_cloud",
    })).toThrow(expect.objectContaining({
      boundary: "slack_delivery",
      code: "DELIVERY_SCOPE_MISMATCH",
    }));
  });
});
