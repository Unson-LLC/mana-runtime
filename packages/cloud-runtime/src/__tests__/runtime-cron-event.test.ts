import { describe, expect, it } from "vitest";
import { createManualCronEvent } from "../runtime-cron-event.js";

const source = {
  tenantId: "mana",
  eventId: "Ev_command",
  workspaceId: "T_UNSON",
  channelId: "C_MANA",
  threadTs: "123.45",
  messageTs: "123.45",
  userId: "U_OPERATOR",
  eventType: "app_mention",
  text: "/cron run daily",
  receivedAt: "2026-08-14T00:00:00.000Z",
};

const job = {
  id: "daily",
  name: "Daily",
  enabled: true,
  schedule: "0 9 * * *",
  timezone: "Asia/Tokyo",
  prompt: "今日のタスクを確認して報告して",
  delivery: { connector: "slack" as const, channel: "C_MANA" },
};

describe("manual runtime cron event", () => {
  it("re-enters the ordinary queue with the same trusted placement and requester", () => {
    expect(createManualCronEvent(source, job, "2026-08-14T01:00:00.000Z")).toEqual(expect.objectContaining({
      eventId: "cron:Ev_command:daily",
      workspaceId: "T_UNSON",
      channelId: "C_MANA",
      threadTs: "123.45",
      userId: "U_OPERATOR",
      eventType: "message",
      text: "今日のタスクを確認して報告して",
    }));
  });

  it("fails closed for cross-channel delivery", () => {
    expect(() => createManualCronEvent(source, {
      ...job,
      delivery: { connector: "slack", channel: "C_OTHER" },
    }, "2026-08-14T01:00:00.000Z")).toThrow("cron_delivery_scope_mismatch");
  });

  it("does not manufacture an actor for requester-less execution", () => {
    expect(() => createManualCronEvent({ ...source, userId: undefined }, job,
      "2026-08-14T01:00:00.000Z")).toThrow("cron_requester_missing");
  });
});
