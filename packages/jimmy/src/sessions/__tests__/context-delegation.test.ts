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
      '"parentSessionId": "parent-session-123"',
    );
    expect(context).toContain(
      "Copy this exact value into `parentSessionId`; never omit that field",
    );
  });
});
