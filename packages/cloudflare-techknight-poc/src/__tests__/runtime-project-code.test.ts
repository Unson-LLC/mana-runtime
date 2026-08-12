import { resolveRuntimeBinding } from "../runtime-config.js";
import type { SlackQueueEvent } from "../types.js";

const event: SlackQueueEvent = {
  tenantId: "unson",
  eventId: "EvProjectCodes123",
  workspaceId: "T_UNSON",
  channelId: "C_BACK_OFFICE",
  threadTs: "1.0",
  messageTs: "2.0",
  userId: "U_USER",
  eventType: "app_mention",
  text: "議事録をタスク化して",
  receivedAt: "2026-08-12T00:00:00.000Z",
};

describe("Cloudflare runtime project code binding", () => {
  it("uses the trusted deployment project-code union", () => {
    expect(resolveRuntimeBinding(event, {
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
      projectCodes: " back-office, brainbase,back-office ",
    }).projectCodes).toEqual(["back-office", "brainbase"]);
  });

  it("rejects a deployment without project codes", () => {
    expect(() => resolveRuntimeBinding(event, {
      tenantId: "unson",
      workspaceId: "T_UNSON",
      channelId: "C_BACK_OFFICE",
      projectCodes: " , ",
    })).toThrow(expect.objectContaining({ code: "project_binding_missing" }));
  });
});
