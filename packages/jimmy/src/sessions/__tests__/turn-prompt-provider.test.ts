import { describe, expect, it, vi } from "vitest";
import { createTurnPromptProvider } from "../turn-prompt-provider.js";

describe("turn prompt provider", () => {
  it("uses one canonical composition path and forwards placement visibility", () => {
    const runtimeProvider = vi.fn(({ portalName, placementId }) => ({
      content: `runtime:${portalName}:${placementId ?? "global"}`,
      sha256: "a".repeat(64),
      projectionChanged: false,
    }));
    const buildTurnPrompt = createTurnPromptProvider(runtimeProvider);

    const prompt = buildTurnPrompt({
      source: "slack",
      channel: "C1",
      user: "U1",
      portalName: "Mana",
      placement: {
        id: "accounting",
        audience: { type: "channel", channelId: "C1" },
        capabilities: {},
      } as any,
    });

    expect(runtimeProvider).toHaveBeenCalledWith({
      portalName: "Mana",
      placementId: "accounting",
    });
    expect(prompt).toContain("runtime:Mana:accounting");
    expect(prompt).toContain("## Placement policy");
  });
});
