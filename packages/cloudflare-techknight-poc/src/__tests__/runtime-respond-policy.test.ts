import { describe, expect, it } from "vitest";
import { evaluateRuntimeRespondPolicy } from "../runtime-respond-policy.js";
import { isReplyEligible } from "../reply-pipeline.js";
import type { SlackQueueEvent } from "../types.js";

const config = { im: "never", mpim: "never", channel: "mention", engagedThreads: true } as const;

describe("runtime Slack respond policy", () => {
  it("allows an explicit channel mention", () => {
    expect(evaluateRuntimeRespondPolicy({ config, channelType: "channel", wasMentioned: true,
      isEngagedThread: false })).toEqual({ allow: true });
  });
  it("allows an unmentioned follow-up only in an engaged channel thread", () => {
    expect(evaluateRuntimeRespondPolicy({ config, channelType: "channel", wasMentioned: false,
      isEngagedThread: true })).toEqual({ allow: true });
    expect(evaluateRuntimeRespondPolicy({ config, channelType: "channel", wasMentioned: false,
      isEngagedThread: false })).toEqual({ allow: false, reason: "respondTo.channel=mention" });
  });
  it("keeps Lightsail production DM and group-DM denial", () => {
    expect(evaluateRuntimeRespondPolicy({ config, channelType: "im", wasMentioned: false,
      isEngagedThread: true })).toEqual({ allow: false, reason: "respondTo.im=never" });
    expect(evaluateRuntimeRespondPolicy({ config, channelType: "mpim", wasMentioned: true,
      isEngagedThread: true })).toEqual({ allow: false, reason: "respondTo.mpim=never" });
  });
  it("routes a normal message only when its durable thread is engaged", () => {
    const event: SlackQueueEvent = { tenantId: "unson-business", eventId: "Ev2", workspaceId: "T1",
      channelId: "C1", channelType: "channel", threadTs: "1", messageTs: "2", userId: "U1",
      eventType: "message", text: "続けて", receivedAt: "2026-08-14T00:00:00Z" };
    const boundary = { expectedTenantId: "unson-business", expectedWorkspaceId: "T1",
      allowedChannelId: "C1", respondPolicy: config };
    expect(isReplyEligible(event, { ...boundary, isEngagedThread: false })).toBe(false);
    expect(isReplyEligible(event, { ...boundary, isEngagedThread: true })).toBe(true);
  });
});
