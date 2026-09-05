import { describe, expect, it } from "vitest";

import type { MeetingMinutesDestination, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import {
  meetingMinutesSelectionDestination,
  resolveMeetingMinutesDestinationAuthorization,
  resolveMeetingMinutesDestinationProjectScope,
} from "../meeting-minutes-selection-scope.js";
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
  it("fails closed when a selected destination has no canonical authority mapping", () => {
    expect(() => resolveMeetingMinutesDestinationAuthorization(
      council,
      JSON.stringify({ ncom: "prj_ncom" }),
      "mana-runtime",
      "meeting-minutes",
      "worker_ingress",
    )).toThrowError(
      expect.objectContaining({ code: "PROJECT_SCOPE_MISMATCH" }),
    );
  });

  it("returns the configured canonical authority for a selected destination", () => {
    expect(resolveMeetingMinutesDestinationAuthorization(
      council,
      JSON.stringify({ techknight: "prj_techknight" }),
      "mana-runtime",
      "meeting-minutes",
      "worker_ingress",
    )).toEqual({
      required_authorization: {
        audience: "mana-runtime",
        project_id: "prj_techknight",
        capability_id: "meeting-minutes",
      },
      trusted_project_ids: ["prj_techknight"],
    });
  });

  it.each(["techknight", "ncom"])("requires the %s destination scope for redo task deletion", (projectCode) => {
    const destination = { ...council, contextProjectCode: projectCode };
    expect(resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_destination"],
      data_scopes: [`company_authority:resource:project:${projectCode}@7`],
    }, destination, `prj_${projectCode}`, "brainbase_proxy")).toEqual({
      project_id: "prj_destination", project_ids: ["prj_destination"],
    });
    expect(() => resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_unson"],
      data_scopes: ["company_authority:resource:project:unson@7"],
    }, destination, `prj_${projectCode}`, "brainbase_proxy")).toThrowError(TenantBoundaryError);
  });

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
      expect((error as TenantBoundaryError).code).toBe("PROJECT_SCOPE_MISMATCH");
    }
  });

  it("accepts the configured authority project id", () => {
    expect(resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_techknight"], data_scopes: [],
    }, council, "prj_techknight", "queue_consumer")).toEqual({
      project_id: "prj_techknight", project_ids: ["prj_techknight"],
    });
  });

  it("preserves a signed multi-project set containing the destination authority", () => {
    expect(resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_source", "prj_techknight"], data_scopes: [],
    }, council, "prj_techknight", "queue_consumer")).toEqual({
      project_id: "prj_techknight", project_ids: ["prj_source", "prj_techknight"],
    });
  });

  it("rejects a signed multi-project set without the destination authority", () => {
    try {
      resolveMeetingMinutesDestinationProjectScope({
        project_ids: ["prj_source", "prj_other"], data_scopes: [],
      }, council, "prj_techknight", "queue_consumer");
      throw new Error("expected project scope validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TenantBoundaryError);
      expect((error as TenantBoundaryError).details).toEqual({
        scope_reason: "destination_authority_not_signed",
      });
    }
  });

  it("accepts a canonical signed id attested to the destination project code", () => {
    expect(resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_canonical"],
      data_scopes: ["company_authority:resource:project:techknight@7"],
    }, council, "prj_techknight", "queue_consumer")).toEqual({
      project_id: "prj_canonical", project_ids: ["prj_canonical"],
    });
  });

  it("rejects a source project attestation for a different destination", () => {
    expect(() => resolveMeetingMinutesDestinationProjectScope({
      project_ids: ["prj_unson"],
      data_scopes: ["company_authority:resource:project:unson@7"],
    }, council, "prj_techknight", "queue_consumer")).toThrowError(TenantBoundaryError);
  });
});
