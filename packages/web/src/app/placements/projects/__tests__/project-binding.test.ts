import { describe, expect, it } from "vitest"
import { resolveChannelPlacementUpdate } from "../project-binding"

describe("resolveChannelPlacementUpdate", () => {
  const placements = [
    { id: "p1", connector: "slack-biz", workspaceId: "T1", channelId: "C1", projects: ["old"] },
    { id: "p2", connector: "slack-biz", workspaceId: "T1", channelId: "C2", projects: ["keep"] },
  ]

  it("updates only the exact channel placement and normalizes project codes", () => {
    expect(resolveChannelPlacementUpdate(placements, {
      connectorId: "slack-biz",
      workspaceId: "T1",
      channelId: "C1",
      projectCodes: [" mana ", "brainbase", "mana", ""],
    })).toEqual([
      expect.objectContaining({ id: "p1", projects: ["mana", "brainbase"] }),
      placements[1],
    ])
  })

  it("fails closed when the target is missing or ambiguous", () => {
    expect(() => resolveChannelPlacementUpdate(placements, {
      connectorId: "slack-biz", workspaceId: "T1", channelId: "missing", projectCodes: ["mana"],
    })).toThrow("placementが見つかりません")
    expect(() => resolveChannelPlacementUpdate([...placements, { ...placements[0], id: "p3" }], {
      connectorId: "slack-biz", workspaceId: "T1", channelId: "C1", projectCodes: ["mana"],
    })).toThrow("複数のplacement")
  })
})
