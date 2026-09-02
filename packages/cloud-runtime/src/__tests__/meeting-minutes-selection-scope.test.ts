import { describe, expect, it } from "vitest";

import type { MeetingMinutesDestination, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import { meetingMinutesSelectionDestination } from "../meeting-minutes-selection-scope.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";

const selection: MeetingMinutesSelection = {
  kind: "meeting_minutes_selection", runId: "Ev1_F1", destinationId: "council",
  workspaceId: "T1", appId: "A1", channelId: "C1", threadTs: "1.0", userId: "U1", actionTs: "1.1",
};
const council: MeetingMinutesDestination = {
  id: "council", projectId: "proj_council", contextProjectCode: "techknight",
  taskProjectCodes: ["techknight"], taskBoardTargetId: "council", name: "評議会",
  organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2",
  github: { owner: "Tech-Knight-inc", repo: "tech-knight-project", pathPrefix: "meetings/council/" },
};

describe("meetingMinutesSelectionDestination", () => {
  it("resolves the selected destination instead of the source channel placement", () => {
    expect(meetingMinutesSelectionDestination(selection, [council])).toBe(council);
  });

  it("fails closed when a forged destination is not configured", () => {
    try {
      meetingMinutesSelectionDestination(
        { ...selection, destinationId: "missing" },
        [council],
      );
      throw new Error("expected meetingMinutesSelectionDestination to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TenantBoundaryError);
      expect((error as TenantBoundaryError).code).toBe(
        "PROJECT_SCOPE_MISMATCH",
      );
    }
  });
});
