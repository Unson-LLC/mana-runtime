import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";

describe("delegation context", () => {
  it("embeds the exact current session ID in child creation commands", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      thread: "1700000000.000001",
      user: "U123",
      sessionId: "parent-session-123",
      connectors: ["slack"],
    });

    expect(context).toContain(
      "POST http://127.0.0.1:7777/api/sessions/parent-session-123/children",
    );
    expect(context).toContain(
      "it enforces the parent link even if the request body omits `parentSessionId`",
    );
  });

  it("keeps the assigned employee persona but omits unsupported cross-service instructions in a placement", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-session",
      employee: {
        name: "ryoko",
        displayName: "Ryoko Pilot",
        department: "operations",
        rank: "executive",
        engine: "claude",
        model: "sonnet",
        persona: "Run the pilot within its approved channel boundary.",
      },
      placement: {
        id: "pilot",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C123",
        audience: { type: "operator", allowedUsers: ["U123"] },
        agent: { employee: "ryoko" },
      },
    });

    expect(context).toContain("# You are Ryoko Pilot");
    expect(context).toContain("Run the pilot within its approved channel boundary.");
    expect(context).toContain("## Placement policy");
    expect(context).not.toContain("/api/org/cross-request");
    expect(context).not.toContain("Gateway API");
    expect(context).not.toContain("/api/config");
    expect(context).not.toContain("/api/sessions");
    expect(context).not.toContain("/api/connectors/slack/send");
  });

  it("never renders secret-like placement data in the system context", () => {
    const canary = "sk-canary-never-render";
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-secret-test",
      placement: {
        id: "pilot",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C123",
        audience: { type: "operator", allowedUsers: ["U123"] },
        dataScopes: { apiKey: canary, graph: { mode: "read-only" } },
      },
    });

    expect(context).not.toContain(canary);
    expect(context).toContain("[REDACTED]");
    expect(context).toContain("read-only");
  });
});
