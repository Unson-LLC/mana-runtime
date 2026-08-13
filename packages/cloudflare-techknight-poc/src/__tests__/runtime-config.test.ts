import { resolveRuntimeBinding } from "../runtime-config.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvBinding123",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1.0",
    messageTs: "2.0",
    userId: "U_USER",
    eventType: "app_mention",
    text: "議事録をタスク化して",
    receivedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("Cloudflare runtime binding", () => {
  it.each([
    ["techknight", "T_TECHKNIGHT", "C_MANA_TEST", "techknight, shared,techknight"],
    ["unson", "T_UNSON", "C_BACK_OFFICE", "back-office, brainbase"],
  ])("resolves independent company deployments with one implementation", (
    tenantId,
    workspaceId,
    channelId,
    projectCodes,
  ) => {
    expect(resolveRuntimeBinding(event({ tenantId, workspaceId, channelId }), {
      tenantId,
      workspaceId,
      channelId,
      projectCodes,
    })).toEqual({
      tenantId,
      workspaceId,
      channelId,
      projectCodes: projectCodes.split(",").map((value) => value.trim()).filter((value, index, all) => all.indexOf(value) === index),
    });
  });

  it.each([
    ["workspace_not_allowed", { workspaceId: "T_OTHER" }, { projectCodes: "back-office" }],
    ["channel_not_allowed", { channelId: "C_OTHER" }, { projectCodes: "back-office" }],
    ["project_binding_missing", {}, { projectCodes: "  , " }],
  ])("fails closed with %s", (code, eventChange, configChange) => {
    expect(() => resolveRuntimeBinding(event(eventChange), {
      tenantId: "techknight",
      workspaceId: "T_TECHKNIGHT",
      channelId: "C_MANA_TEST",
      ...configChange,
      projectCodes: configChange.projectCodes ?? "back-office",
    })).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    "back-office/outside",
    "back-office?project_code=outside",
    "back-office\nbrainbase",
  ])("rejects an unsafe deployment project code: %s", (projectCodes) => {
    expect(() => resolveRuntimeBinding(event(), {
      tenantId: "techknight",
      workspaceId: "T_TECHKNIGHT",
      channelId: "C_MANA_TEST",
      projectCodes,
    })).toThrow(expect.objectContaining({ code: "project_binding_invalid" }));
  });
});
