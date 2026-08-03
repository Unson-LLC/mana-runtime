import { describe, expect, it } from "vitest";
import { buildSettingsDeepLink, buildSettingsTopologyUrl } from "../settings-deep-link.js";

describe("buildSettingsDeepLink", () => {
  it("builds the canonical topology entry without credentials or inherited query", () => {
    expect(buildSettingsTopologyUrl("https://mana.example.com/old?token=secret"))
      .toBe("https://mana.example.com/settings/topology");
    expect(buildSettingsTopologyUrl("https://user:pass@mana.example.com")).toBeNull();
  });

  it("builds a meeting-minutes link with only allowlisted identifiers", () => {
    expect(buildSettingsDeepLink("https://mana.example.com/ignored?token=secret", {
      workspaceId: "T0123",
      projectId: "project-a",
      channelId: "C0456",
    })).toBe("https://mana.example.com/settings/meeting-minutes?workspace=T0123&project=project-a&channel=C0456");
  });

  it("allows local development but rejects unsafe public origins", () => {
    expect(buildSettingsDeepLink("http://localhost:3000", { channelId: "C1" }))
      .toBe("http://localhost:3000/settings/meeting-minutes?channel=C1");
    expect(buildSettingsDeepLink("http://mana.example.com", { channelId: "C1" })).toBeNull();
    expect(buildSettingsDeepLink("javascript:alert(1)", { channelId: "C1" })).toBeNull();
    expect(buildSettingsDeepLink("https://user:pass@mana.example.com", { channelId: "C1" })).toBeNull();
  });

  it("omits empty values and never accepts arbitrary query fields", () => {
    expect(buildSettingsDeepLink("https://mana.example.com", {
      workspaceId: "",
      projectId: undefined,
      channelId: "C1",
    })).toBe("https://mana.example.com/settings/meeting-minutes?channel=C1");
  });
});
