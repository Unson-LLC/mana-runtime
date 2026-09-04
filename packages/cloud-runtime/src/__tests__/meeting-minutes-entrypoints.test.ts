import { currentMeetingMinutesActionTs, isMeetingMinutesRedo, isMeetingMinutesRouterFileEvent, isMeetingMinutesSelection, isMeetingMinutesSlackEvent,
  meetingMinutesRuntimeConfig } from "../meeting-minutes-entrypoints.js";

const destinations = JSON.stringify([{ id: "mana", projectId: "mana", contextProjectCode: "mana",
  taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana", name: "mana",
  organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
  github: { owner: "Unson-LLC", repo: "mana", pathPrefix: "docs" } }]);

describe("meeting minutes entrypoints", () => {
  it("defaults to disabled without requiring authority config", () => {
    expect(meetingMinutesRuntimeConfig({})).toEqual({ enabled: false, routerChannelId: "", destinations: [], operatorUserIds: new Set() });
  });
  it("retains the router identity while disabled so paused intake can reject new files", () => {
    const config = meetingMinutesRuntimeConfig({ MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER",
      MEETING_MINUTES_OPERATOR_USER_IDS: "U1" });
    const event = { tenantId: "unson", eventId: "E1", workspaceId: "T1", channelId: "CROUTER",
      threadTs: "1", messageTs: "1", eventType: "message", subtype: "file_share", text: "", receivedAt: "now",
      files: [{ id: "F1", name: "meeting.txt" }] };
    expect(config).toEqual({ enabled: false, routerChannelId: "CROUTER", destinations: [], operatorUserIds: new Set(["U1"]) });
    expect(isMeetingMinutesRouterFileEvent(event, config.routerChannelId)).toBe(true);
    expect(isMeetingMinutesSlackEvent(event, config)).toBe(false);
  });
  it("retains trusted destinations while disabled so existing task controls keep working", () => {
    const config = meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "false",
      MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_OPERATOR_USER_IDS: "U1",
      MEETING_MINUTES_DESTINATIONS_JSON: destinations });
    expect(config).toEqual(expect.objectContaining({ enabled: false, destinations: [expect.objectContaining({
      id: "mana", contextProjectCode: "mana", taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana",
    })] }));
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
    const additional = JSON.stringify([{ id: "extra", projectId: "extra", contextProjectCode: "mana",
      taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-extra", name: "Extra",
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
    const invalid = JSON.stringify([{ id: "mana", projectId: "mana", contextProjectCode: "mana",
      taskProjectCodes, taskBoardTargetId: "minutes-mana", name: "mana",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
      github: { owner: "Unson-LLC", repo: "mana" } }]);
    expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true",
      MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_DESTINATIONS_JSON: invalid,
      MEETING_MINUTES_OPERATOR_USER_IDS: "U1" })).toThrow("meeting_minutes_destinations_invalid");
  });
  it.each(["", "contains space", "../outside"])("rejects invalid explicit context project code: %s",
    (contextProjectCode) => {
      const invalid = JSON.stringify([{ id: "mana", projectId: "proj_mana", contextProjectCode,
        taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana", name: "mana",
        organization: { id: "unson", name: "雲孫" }, slackChannelId: "CDEST",
        github: { owner: "Unson-LLC", repo: "mana" } }]);
      expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true",
        MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_DESTINATIONS_JSON: invalid,
        MEETING_MINUTES_OPERATOR_USER_IDS: "U1" })).toThrow("meeting_minutes_destinations_invalid");
    });
  it("rejects destinations without every explicit Brainbase binding", () => {
    for (const field of ["contextProjectCode", "taskProjectCodes", "taskBoardTargetId"] as const) {
      const destination = JSON.parse(destinations) as Array<Record<string, unknown>>;
      delete destination[0]![field];
      expect(() => meetingMinutesRuntimeConfig({ MEETING_MINUTES_ENABLED: "true",
        MEETING_MINUTES_ROUTER_CHANNEL_ID: "CROUTER", MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify(destination),
        MEETING_MINUTES_OPERATOR_USER_IDS: "U1" })).toThrow("meeting_minutes_destinations_invalid");
    }
  });
  it("recognizes only a complete selection Queue message", () => {
    expect(isMeetingMinutesSelection({ kind: "meeting_minutes_selection", runId: "E1_F1", destinationId: "mana",
      workspaceId: "T1", appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesSelection({ kind: "meeting_minutes_selection", runId: "E1_F1" })).toBe(false);
  });
  it("formats an administrative retry timestamp as a valid Slack action timestamp", () => {
    const actionTs = currentMeetingMinutesActionTs(1_787_046_249_000);
    expect(actionTs).toBe("1787046249.000000");
    expect(isMeetingMinutesSelection({ kind: "meeting_minutes_selection", runId: "E1_F1", destinationId: "mana",
      workspaceId: "T1", appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs })).toBe(true);
  });
  it("recognizes only a complete redo Queue message", () => {
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", revision: 0, workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", revision: 1, workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(true);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", revision: -1, workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(false);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", revision: "1", workspaceId: "T1",
      appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" })).toBe(false);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1", workspaceId: "T1",
      channelId: "C1", userId: "U1", actionTs: "2.1" })).toBe(false);
    expect(isMeetingMinutesRedo({ kind: "meeting_minutes_redo", runId: "E1_F1" })).toBe(false);
  });
});
