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
      expect(JSON.parse(message.slice("security_event ".length))).toMatchObject({ decision: "deny", configRevision: "rev-1" });
    }
  });
  it("uses deterministic hashes and safe placement revisions", () => {
    expect(hashSecurityIdentifier("U1")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecurityIdentifier("U1")).toBe(hashSecurityIdentifier("U1"));
    expect(placementConfigRevision([{ id: "pilot" }])).toMatch(/^[a-f0-9]{16}$/);
  });
});
