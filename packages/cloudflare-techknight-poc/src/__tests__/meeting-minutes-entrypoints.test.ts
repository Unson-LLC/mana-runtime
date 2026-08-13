import { isMeetingMinutesSlackEvent, meetingMinutesRuntimeConfig } from "../meeting-minutes-entrypoints.js";

const destinations = JSON.stringify([{ id: "mana", projectId: "mana", name: "mana", slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } }]);

describe("meeting minutes entrypoints", () => {
  it("defaults to disabled without requiring authority config", () => {
    expect(meetingMinutesRuntimeConfig({})).toEqual({ enabled: false, routerChannelId: "", destinations: [], operatorUserIds: new Set() });
  });
  it("fails closed when enabled authority config is incomplete", () => {
    expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true" })).toThrow("meeting_minutes_config_incomplete");
  });
  it("classifies only txt file shares in the dedicated router", () => {
    const config = meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
      MEETING_MINUTES_DESTINATIONS_JSON: destinations, MEETING_MINUTES_OPERATOR_USER_IDS: "U1,U2" });
    expect(isMeetingMinutesSlackEvent({ tenantId: "unson", eventId: "E1", workspaceId: "T1", channelId: "CROUTER",
      threadTs: "1", messageTs: "1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
      files: [{ id: "F1", name: "meeting.txt" }] }, config)).toBe(true);
    expect(isMeetingMinutesSlackEvent({ tenantId: "unson", eventId: "E2", workspaceId: "T1", channelId: "COTHER",
      threadTs: "1", messageTs: "1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
      files: [{ id: "F1", name: "meeting.txt" }] }, config)).toBe(false);
  });
});
