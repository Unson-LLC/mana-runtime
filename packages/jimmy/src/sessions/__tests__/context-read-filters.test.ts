import { describe, expect, it, vi } from "vitest";
import type { PlacementProfile } from "../../shared/types.js";
import { buildContext } from "../context.js";

vi.mock("../../cli/skills.js", () => ({
  listSkills: () => [
    {
      name: "global-skill",
      description: "誰でも使える一般スキル",
      requiredMcp: [],
      requiredTools: [],
      scope: undefined,
    },
    {
      name: "salestailor-sync",
      description: "SalesTailor専用の同期手順",
      requiredMcp: ["nocodb"],
      requiredTools: [],
      scope: "salestailor",
    },
    {
      name: "ops-broadcast",
      description: "全チャンネル送信を行う運用スキル",
      requiredMcp: [],
      requiredTools: ["send_message"],
      scope: undefined,
    },
  ],
}));

const placement = (overrides: Partial<PlacementProfile> = {}): PlacementProfile => ({
  id: "ctx-test-placement",
  connector: "slack",
  workspaceId: "T1",
  channelId: "C123",
  audience: { type: "project-team", allowedUsers: ["U123"] },
  ...overrides,
});

const build = (p?: PlacementProfile) =>
  buildContext({ source: "slack", channel: "C123", user: "U123", sessionId: "s1", placement: p });

describe("skill manifest injection (placement read filter)", () => {
  it("injects only skills executable under the placement capabilities with a matching scope", () => {
    const context = build(placement({
      projects: ["salestailor"],
      capabilities: { mcp: ["nocodb"], gatewayTools: [] },
    }));
    expect(context).toContain("## Skills");
    expect(context).toContain("Only the skills listed below are available in this placement session");
    expect(context).toContain("- global-skill");
    expect(context).toContain("- salestailor-sync (scope: salestailor)");
    expect(context).not.toContain("ops-broadcast");
  });

  it("hides capability-requiring and out-of-scope skills from an unprivileged placement", () => {
    const context = build(placement());
    expect(context).toContain("- global-skill");
    expect(context).not.toContain("salestailor-sync");
    expect(context).not.toContain("ops-broadcast");
  });

  it("keeps the full skill listing for non-placement sessions", () => {
    const context = build(undefined);
    expect(context).toContain("## Skills");
    expect(context).toContain("- global-skill");
    expect(context).toContain("- salestailor-sync (scope: salestailor)");
    expect(context).toContain("- ops-broadcast");
    expect(context).not.toContain("Only the skills listed below are available in this placement session");
  });
});

describe("placement-local memory view", () => {
  it("injects the placement's own memory view and warns other placements' memory is blocked", () => {
    const context = build(placement());
    expect(context).toContain("## Placement memory");
    expect(context).toContain("memory/placements/ctx-test-placement/");
    expect(context).toContain("Other placements' memory directories are blocked for this session");
  });

  it("does not inject a placement memory section for non-placement sessions", () => {
    const context = build(undefined);
    expect(context).not.toContain("## Placement memory");
  });
});
