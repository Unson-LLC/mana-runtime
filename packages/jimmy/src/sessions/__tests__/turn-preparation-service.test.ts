import { describe, expect, it, vi } from "vitest";
import { TurnPreparationService } from "../turn-preparation-service.js";

describe("TurnPreparationService", () => {
  it("keeps the common persona while isolating shared channel context", async () => {
    const promptProvider = vi.fn((options: any) => [
      "PERSONA:workspace-common",
      `CHANNEL:${options.sharedConversationContext.messages[0].content}`,
      `GRAPH:${options.graphContext.content}`,
      `TOOLS:${options.effectiveCapabilities.map((item: any) => `${item.name}:${item.status}`).join(",")}`,
    ].join("\n"));
    const graphClient = { hydrate: vi.fn().mockResolvedValue({ status: "available", content: "Graph facts", observedAt: "now" }) };
    const sharedConversationProvider = vi.fn(({ channelId }: { channelId: string }) => ({
      status: "available" as const,
      messages: [{ role: "user", content: channelId === "C1" ? "営業文脈" : "採用文脈", timestamp: 1 }],
      observedAt: "now",
    }));
    const service = new TurnPreparationService({
      promptProvider,
      graphClient: graphClient as any,
      sharedConversationProvider,
    });
    const base = {
      promptOptions: { source: "slack", channel: "C1", user: "U1" },
      workspaceId: "T1",
      sessionId: "S1",
      effectiveCapabilities: [{ kind: "mcp" as const, name: "gateway", status: "available" as const }],
    };

    const first = await service.prepare(base);
    const second = await service.prepare({ ...base, promptOptions: { ...base.promptOptions, channel: "C2" } });
    expect(first.systemPrompt).toContain("PERSONA:workspace-common");
    expect(second.systemPrompt).toContain("PERSONA:workspace-common");
    expect(first.systemPrompt).toContain("営業文脈");
    expect(first.systemPrompt).not.toContain("採用文脈");
    expect(second.systemPrompt).toContain("採用文脈");
    expect(second.systemPrompt).not.toContain("営業文脈");
    expect(first.contextStatus).toMatchObject({ graph: "available", sharedConversation: "available" });
  });
});
