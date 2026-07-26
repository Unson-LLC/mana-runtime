import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { emitSecurityEvent, hashSecurityIdentifier, placementConfigRevision, type SecurityEventReason } from "../security-events.js";

describe("security event observability contract", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("emits every required denial reason as structured, secret-safe JSON", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const reasons: SecurityEventReason[] = ["unmatched", "unauthorized_actor", "ambiguous", "placement_missing_after_config_change", "operator_auth_missing", "operator_auth_invalid", "operator_hash_missing", "mcp_denied", "gateway_tool_denied", "delivery_denied", "parent_missing", "parent_token_invalid", "employee_denied", "execution_override_denied"];
    for (const reason of reasons) emitSecurityEvent({ event: "capability", reason, actorId: "U-SECRET-ACTOR", configRevision: "rev-1" });
    expect(warn).toHaveBeenCalledTimes(reasons.length);
    for (const [message] of warn.mock.calls) {
      expect(message).toMatch(/^security_event /);
      expect(message).not.toContain("U-SECRET-ACTOR");
      const event = JSON.parse(message.slice("security_event ".length));
      expect(event).toMatchObject({ decision: "deny", configRevision: "rev-1" });
      expect(Object.keys(event).sort()).toEqual([
        "actorId", "capability", "channelId", "configRevision", "connector", "decision", "event",
        "placementId", "reason", "sessionId", "target", "timestamp", "workspaceId",
      ].sort());
    }
  });
  it("does not accept secret-bearing payload fields and bounds metadata", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // @ts-expect-error security events intentionally reject secret-bearing payloads at compile time
    emitSecurityEvent({ event: "capability", reason: "delivery_denied", token: "TOKEN", prompt: "PROMPT", body: "BODY", secret: "SECRET", query: "QUERY", target: `safe\n${"x".repeat(400)}` });
    const message = warn.mock.calls[0]![0];
    expect(message).not.toContain("TOKEN");
    expect(message).not.toContain("PROMPT");
    expect(message).not.toContain("BODY");
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("QUERY");
    const event = JSON.parse(message.slice("security_event ".length));
    expect(event.target).not.toContain("\n");
    expect(event.target).toHaveLength(256);
  });
  it("uses deterministic hashes and safe placement revisions", () => {
    expect(hashSecurityIdentifier("U1")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecurityIdentifier("U1")).toBe(hashSecurityIdentifier("U1"));
    expect(placementConfigRevision([{ id: "pilot" }])).toMatch(/^[a-f0-9]{16}$/);
  });
});
