import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";

describe("per-turn context state", () => {
  it("renders shared context, explicit Graph failure and effective tool status", () => {
    const prompt = buildContext({
      source: "slack",
      channel: "C1",
      user: "U1",
      runtimeInstructions: "workspace-common-persona",
      sharedConversationContext: {
        status: "available",
        observedAt: "2026-08-04T00:00:00.000Z",
        messages: [{
          sessionId: "other-thread",
          role: "user",
          content: "梅田さんとの前スレッドの業務文脈",
          timestamp: 1,
        }],
      },
      graphContext: {
        status: "unavailable",
        reasonCode: "http_503",
        observedAt: "2026-08-04T00:00:00.000Z",
      },
      effectiveCapabilities: [
        { kind: "mcp", name: "gateway", status: "available" },
        { kind: "mcp", name: "search", status: "unavailable", reasonCode: "credential_missing" },
      ],
    });

    expect(prompt).toContain("workspace-common-persona");
    expect(prompt).toContain("梅田さんとの前スレッドの業務文脈");
    expect(prompt).toContain("Status: 未確認 (http_503)");
    expect(prompt).toContain("mcp:gateway: available");
    expect(prompt).toContain("mcp:search: unavailable (credential_missing)");
  });
});
