import { parseRuntimePlacements, resolveRuntimeBinding, resolveRuntimePlacement } from "../runtime-config.js";
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
  it("resolves the router channel as an independent runtime placement", () => {
    const placements = parseRuntimePlacements(JSON.stringify([
      { placementId: "mana-accounting", channelId: "C_BACK_OFFICE", projectCodes: ["back-office"], taskWriteEnabled: true },
      { placementId: "biz-meeting-router", channelId: "C_ROUTER", projectCodes: ["unson"] },
    ]));

    expect(resolveRuntimePlacement(event({ tenantId: "unson", workspaceId: "T_UNSON", channelId: "C_ROUTER" }), {
      tenantId: "unson",
      workspaceId: "T_UNSON",
      placements,
    })).toMatchObject({
      placementId: "biz-meeting-router",
      channelId: "C_ROUTER",
      projectCodes: ["unson"],
      taskWriteEnabled: false,
    });
  });

  it("fails closed for duplicate and unknown placement channels", () => {
    expect(() => parseRuntimePlacements(JSON.stringify([
      { placementId: "one", channelId: "C_DUP", projectCodes: ["one"] },
      { placementId: "two", channelId: "C_DUP", projectCodes: ["two"] },
    ]))).toThrow(expect.objectContaining({ code: "runtime_placements_invalid" }));
    expect(() => resolveRuntimePlacement(event({ channelId: "C_OTHER" }), {
      tenantId: "techknight",
      workspaceId: "T_TECHKNIGHT",
      placements: [{ placementId: "mana", channelId: "C_MANA_TEST", projectCodes: ["back-office"], taskWriteEnabled: false }],
    })).toThrow(expect.objectContaining({ code: "channel_not_allowed" }));
  });

  it("keeps a valid trimmed persona prompt on the resolved placement", () => {
    const placements = parseRuntimePlacements(JSON.stringify([{
      placementId: "mana-dev-biz",
      channelId: "C_PERSONA",
      projectCodes: ["unson"],
      personaPrompt: "  まなとして、簡潔に回答する。  ",
    }]));

    expect(placements[0].personaPrompt).toBe("まなとして、簡潔に回答する。");
    expect(resolveRuntimePlacement(event({ tenantId: "unson", workspaceId: "T_UNSON", channelId: "C_PERSONA" }), {
      tenantId: "unson",
      workspaceId: "T_UNSON",
      placements,
    }).personaPrompt).toBe("まなとして、簡潔に回答する。");
  });

  it.each([
    ["non-string", 123],
    ["empty", "   "],
    ["too long", "a".repeat(1001)],
    ["control character", "safe\u0000text"],
  ])("rejects an invalid persona prompt: %s", (_name, personaPrompt) => {
    expect(() => parseRuntimePlacements(JSON.stringify([{
      placementId: "mana-dev-biz",
      channelId: "C_PERSONA",
      projectCodes: ["unson"],
      personaPrompt,
    }]))).toThrow(expect.objectContaining({ code: "runtime_placements_invalid" }));
  });

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
