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
    expect(context).toContain('- Data scopes (supplementary): {"graph":{"mode":"read-only"}}');
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

  it("derives the capability declaration from capabilities, not hand-written dataScopes", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-capability-derivation",
      placement: {
        id: "back-office",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C123",
        audience: { type: "operator", allowedUsers: ["U123"] },
        capabilities: {
          mcp: ["freee", "gateway"],
          gatewayTools: ["create_task", "list_tasks"],
          allowedDelivery: [{ connector: "slack", channel: "C999" }],
        },
        // dataScopes deliberately omits freee — the declaration must still
        // advertise it (the 2026-07-31 self-refusal incident).
        dataScopes: { graph: { mode: "read-only" } },
      },
    });

    // PR #52 pinned the freee write surface in PLACEMENT_MCP_TOOL_DENY, so the
    // generated declaration now carries the always-denied annotation.
    expect(context).toContain("- MCP servers: freee (available, except always-denied tools:");
    expect(context).toContain("gateway (available)");
    expect(context).toContain("- Gateway tools: create_task, list_tasks");
    expect(context).toContain("- Allowed delivery targets: slack:C999");
    expect(context).toContain("Data scopes only add reference-scope notes");
  });

  it("declares no capabilities for a placement without any, falling back to its own channel for delivery", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-no-capabilities",
      placement: {
        id: "minimal",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C123",
        audience: { type: "operator", allowedUsers: ["U123"] },
      },
    });

    expect(context).toContain("- MCP servers: none");
    expect(context).toContain("- Gateway tools: none");
    expect(context).toContain("- Allowed delivery targets: slack:C123");
    expect(context).not.toContain("(available)");
  });

  it("annotates permanently denied MCP tools next to the server that carries them", () => {
    const context = buildContext({
      source: "slack",
      channel: "C123",
      user: "U123",
      sessionId: "placement-deny-annotation",
      placement: {
        id: "pilot",
        connector: "slack",
        workspaceId: "T1",
        channelId: "C123",
        audience: { type: "operator", allowedUsers: ["U123"] },
        capabilities: { mcp: ["brainbase"] },
      },
    });

    expect(context).toContain(
      "- MCP servers: brainbase (available, except always-denied tools: search_personal_kg)",
    );
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
