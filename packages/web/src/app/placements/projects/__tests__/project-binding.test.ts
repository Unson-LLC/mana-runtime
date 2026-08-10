import { describe, expect, it } from "vitest"
import { resolveChannelPlacementUpdate } from "../project-binding"

describe("resolveChannelPlacementUpdate", () => {
  const placements = [
    { id: "p1", connector: "slack", workspaceId: "T1", channelId: "C1", projects: ["old"], taskCanvas: { enabled: true } },
    { id: "p2", connector: "slack", workspaceId: "T1", channelId: "C2", projects: ["keep"] },
  ]

  it("updates only the exact channel placement and normalizes project codes", () => {
    expect(resolveChannelPlacementUpdate(placements, {
      connectorId: "slack",
      workspaceId: "T1",
      channelId: "C1",
      projectCodes: [" mana ", "brainbase", "mana", ""],
      taskCanvasEnabled: false,
    })).toEqual([
      expect.objectContaining({ id: "p1", projects: ["mana", "brainbase"], taskCanvas: { enabled: false } }),
      placements[1],
    ])
  })

  it("fails closed when the target is missing or ambiguous", () => {
    expect(() => resolveChannelPlacementUpdate(placements, {
      connectorId: "slack", workspaceId: "T1", channelId: "missing", projectCodes: ["mana"],
    })).toThrow("placementが見つかりません")
    expect(() => resolveChannelPlacementUpdate([...placements, { ...placements[0], id: "p3" }], {
      connectorId: "slack", workspaceId: "T1", channelId: "C1", projectCodes: ["mana"],
    })).toThrow("複数のplacement")
  })

  it("fails closed when workspace is omitted", () => {
    expect(() => resolveChannelPlacementUpdate(placements, {
      connectorId: "slack", channelId: "C1", projectCodes: ["mana"],
    })).toThrow("placementが見つかりません")
  })
})
