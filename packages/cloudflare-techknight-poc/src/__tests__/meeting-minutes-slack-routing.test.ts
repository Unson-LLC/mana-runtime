import { describe, expect, it } from "vitest";
import { resolveMeetingMinutesDestinationSlackToken } from "../meeting-minutes-slack-routing.js";

const tokens = {
  SLACK_BOT_TOKEN: "unson-ops-token",
  SLACK_BOT_TOKEN_UNSON: "unson-token",
  SLACK_BOT_TOKEN_TECHKNIGHT: "tech-knight-token",
};

describe("resolveMeetingMinutesDestinationSlackToken", () => {
  it("uses the Unson workspace token for Unson destinations", () => {
    expect(resolveMeetingMinutesDestinationSlackToken(tokens, "unson")).toBe("unson-token");
  });

  it("uses the Tech Knight workspace token for Tech Knight destinations", () => {
    expect(resolveMeetingMinutesDestinationSlackToken(tokens, "tech-knight")).toBe("tech-knight-token");
  });

  it("uses the primary unson-ops token for unson-business destinations", () => {
    expect(resolveMeetingMinutesDestinationSlackToken(tokens, "unson-business")).toBe("unson-ops-token");
  });

  it("fails closed when a workspace-specific token is missing", () => {
    expect(resolveMeetingMinutesDestinationSlackToken({ SLACK_BOT_TOKEN: "unson-ops-token" }, "unson")).toBe("");
    expect(resolveMeetingMinutesDestinationSlackToken({ SLACK_BOT_TOKEN: "unson-ops-token" }, "tech-knight")).toBe("");
  });
});
