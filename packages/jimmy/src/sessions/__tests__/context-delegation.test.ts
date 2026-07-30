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

  it("renders placement identity, audience, projects, and data scope in the system context", () => {
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
        projects: ["brainbase-mana"],
        dataScopes: { graph: { mode: "read-only" } },
      },
    });

    expect(context).toContain("# You are Ryoko Pilot");
    expect(context).toContain("Run the pilot within its approved channel boundary.");
    expect(context).toContain("## Placement policy");
    expect(context).toContain("- Placement: pilot");
    expect(context).toContain("- Audience: operator");
    expect(context).toContain("- Projects: brainbase-mana");
    expect(context).toContain('- Data scopes: {"graph":{"mode":"read-only"}}');
    expect(context).not.toContain("/api/org/cross-request");
    expect(context).not.toContain("Gateway API");
    expect(context).not.toContain("/api/config");
    expect(context).not.toContain("/api/sessions");
    expect(context).not.toContain("/api/connectors/slack/send");
  });

  it("marks shared persona/skills/memory files read-only and drops self-modification grants in placement sessions", () => {
    const placement = {
      id: "pilot",
      connector: "slack" as const,
      workspaceId: "T1",
      channelId: "C123",
      audience: { type: "operator" as const, allowedUsers: ["U123"] },
    };
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-write-boundary",
      placement,
    });

    for (const name of ["CLAUDE.md", "SOUL.md", "IDENTITY.md", "MEMORY.md", "TOOLS.md", "skills/", "memory/", "knowledge/"]) {
      expect(context).toContain(name);
    }
    expect(context).toContain("read-only in this placement session");
    expect(context).not.toContain("You can read, write, and modify any of these files");
    expect(context).not.toContain("## Self-evolution");
    expect(context).not.toContain("You can create new employees by writing YAML files");

    const legacyContext = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "legacy-session",
    });
    expect(legacyContext).toContain("You can read, write, and modify any of these files");
    expect(legacyContext).toContain("## Self-evolution");
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
