import { describe, expect, it } from "vitest";
import { normalizeMeetingMinutesDestinations } from "../meeting-minutes-destinations.js";

describe("normalizeMeetingMinutesDestinations", () => {
  it("keeps legacy destinations source-local and promotes legacy share destinations to direct choices", () => {
    const result = normalizeMeetingMinutesDestinations({
      sourceConnectorInstanceId: "slack",
      destinations: [{ projectId: "p1", name: "Primary", channelId: "C_PRIMARY" }],
      shareDestinations: [{
        shareId: "p1-client",
        projectId: "p1",
        name: "Client workspace",
        connectorInstanceId: "slack-client",
        workspaceId: "T_CLIENT",
        channelId: "C_CLIENT",
      }],
    });

    expect(result).toEqual([
      expect.objectContaining({ destinationId: "legacy:p1:C_PRIMARY", connectorInstanceId: "slack", authorityMode: "legacy-source" }),
      expect.objectContaining({ destinationId: "p1-client", connectorInstanceId: "slack-client", workspaceId: "T_CLIENT", authorityMode: "explicit" }),
    ]);
  });

  it("rejects incomplete authority and duplicate destination identities", () => {
    expect(() => normalizeMeetingMinutesDestinations({
      sourceConnectorInstanceId: "slack",
      destinations: [{ projectId: "p1", name: "Broken", channelId: "C1", connectorInstanceId: "slack-client" }],
    })).toThrow("authority is incomplete");

    expect(() => normalizeMeetingMinutesDestinations({
      sourceConnectorInstanceId: "slack",
      destinations: [{ destinationId: "same", projectId: "p1", name: "One", channelId: "C1" }],
      shareDestinations: [{ shareId: "same", projectId: "p2", name: "Two", connectorInstanceId: "slack-client", workspaceId: "T2", channelId: "C2" }],
    })).toThrow("duplicate meeting-minutes destinationId");
  });
});
