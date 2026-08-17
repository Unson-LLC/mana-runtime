import { isMeetingMinutesRedo, isMeetingMinutesSelection, isMeetingMinutesSlackEvent,
  meetingMinutesRuntimeConfig } from "../meeting-minutes-entrypoints.js";

const destinations = JSON.stringify([{ id: "mana", projectId: "mana", name: "mana",
  organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
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
  it("combines additional destinations and validates the complete set", () => {
    const additional = JSON.stringify([{ id: "extra", projectId: "extra", name: "Extra",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "CEXTRA",
      github: { owner: "Unson-LLC", repo: "Drive", pathPrefix: "meetings/extra/" } }]);
    const config = meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true", MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
      MEETING_MINUTES_DESTINATIONS_JSON: destinations, MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON: additional,
      MEETING_MINUTES_OPERATOR_USER_IDS: "U1" });
    expect(config.destinations.map((destination) => destination.id)).toEqual(["mana", "extra"]);
  });
  it.each([
    { taskProjectCodes: [] }, { taskProjectCodes: [""] }, { taskProjectCodes: ["unson", "unson"] },
    { taskProjectCodes: Array.from({ length: 11 }, (_, index) => `p${index}`) },
  ])("rejects invalid explicit task project codes: $taskProjectCodes", ({ taskProjectCodes }) => {
    const invalid = JSON.stringify([{ id: "mana", projectId: "mana", taskProjectCodes, name: "mana",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
      github: { owner: "Unson-LLC", repo: "mana" } }]);
    expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true",
      MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_DESTINATIONS_JSON: invalid,
      MEETING_MINUTES_OPERATOR_USER_IDS: "U1" })).toThrow("meeting_minutes_destinations_invalid");
  });
  it.each(["", "contains space", "../outside"])("rejects invalid explicit context project code: %s",
    (contextProjectCode) => {
      const invalid = JSON.stringify([{ id: "mana", projectId: "proj_mana", contextProjectCode, name: "mana",
        organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
        github: { owner: "Unson-LLC", repo: "mana" } }]);
      expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true",
        MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_DESTINATIONS_JSON: invalid,
        MEETING_MINUTES_OPERATOR_USER_IDS: "U1" })).toThrow("meeting_minutes_destinations_invalid");
    });
  it("recognizes only a complete selection Queue message", () => {
    expect(isMeetingMinutesSelection({ kind: "meeting_minutes_selection", runId: "E1_F1", destinationId: "mana",
      workspaceId: "T1", appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesSelection({ kind: "meeting_minutes_selection", runId: "E1_F1" })).toBe(false);
  });
  it("recognizes only a complete redo Queue message", () => {
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", workspaceId: "T1",
      channelId: "C1", userId: "U1", actionTs: "2.1" })).toBe(false);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1" })).toBe(false);
  });
});
