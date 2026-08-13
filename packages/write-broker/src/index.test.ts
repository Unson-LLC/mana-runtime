import { describe, expect, it } from "vitest";
import { authorizeTaskWriteIntent, evaluateTaskWritePolicy, signTaskWriteCapability, verifyTaskWriteCapability, type TaskWriteCapabilityClaims, type TaskWritePolicy } from "./index.js";

const secret = "0123456789abcdef0123456789abcdef";
const claims: TaskWriteCapabilityClaims = {
  version: 1, audience: "mana-task-write", requestId: "Ev1",
  actor: { provider: "slack", id: "U1", workspace: "T1" },
  placementId: "C1", projects: ["back-office"],
  operations: ["task.create", "task.update", "task.transition"],
  expiresAt: Date.now() + 60_000, nonce: "n1", budget: 3,
};

describe("task write capability", () => {
  it("signs verifies and authorizes only the trusted actor project and operation", async () => {
    const token = await signTaskWriteCapability(claims, secret);
    const verified = await verifyTaskWriteCapability(token, secret, { requestId: "Ev1", workspace: "T1", placementId: "C1" });
    expect(() => authorizeTaskWriteIntent(verified, {
      requestId: "Ev1", actor: claims.actor, placementId: "C1", project: "back-office",
      operation: "task.transition", targetId: "ct1", idempotencyKey: "slack:Ev1:1",
    })).not.toThrow();
    expect(() => authorizeTaskWriteIntent(verified, {
      requestId: "Ev1", actor: claims.actor, placementId: "C1", project: "other",
      operation: "task.create", idempotencyKey: "slack:Ev1:2",
    })).toThrow("write_intent_denied");
  });

  it("rejects tampering expiry and runtime scope mismatch", async () => {
    const token = await signTaskWriteCapability(claims, secret);
    await expect(verifyTaskWriteCapability(`${token}x`, secret, { requestId: "Ev1", workspace: "T1", placementId: "C1" })).rejects.toThrow();
    await expect(verifyTaskWriteCapability(token, secret, { requestId: "other", workspace: "T1", placementId: "C1" })).rejects.toThrow("write_capability_scope_mismatch");
    await expect(verifyTaskWriteCapability(token, secret, { requestId: "Ev1", workspace: "T1", placementId: "C1", now: claims.expiresAt })).rejects.toThrow("expired_write_capability");
  });
});

describe("task write policy", () => {
  const intent = {
    requestId: "Ev1", actor: claims.actor, placementId: "C1", project: "back-office",
    operation: "task.create" as const, idempotencyKey: "slack:Ev1:1",
  };
  const policy: TaskWritePolicy = {
    version: "2026-08-13",
    rules: [
      { effect: "auto", actors: ["U1"], placements: ["C1"], projects: ["back-office"], operations: ["task.create"] },
      { effect: "approval", actors: ["U2"], placements: ["C1"], projects: ["back-office"], operations: ["task.create"], approvers: ["U_APPROVER"], ttlSeconds: 120 },
      { effect: "deny", actors: ["U1"], placements: ["C1"], projects: ["back-office"], operations: ["task.transition"] },
    ],
  };

  it("returns auto only for an exact actor placement project and operation match", () => {
    expect(evaluateTaskWritePolicy(policy, intent)).toEqual({ effect: "auto", policyVersion: "2026-08-13" });
    expect(evaluateTaskWritePolicy(policy, { ...intent, project: "outside" })).toEqual({ effect: "deny", policyVersion: "2026-08-13", reason: "no_matching_rule" });
  });

  it("returns a bounded approval decision and keeps deny fail closed", () => {
    expect(evaluateTaskWritePolicy(policy, { ...intent, actor: { ...intent.actor, id: "U2" } })).toEqual({
      effect: "approval", policyVersion: "2026-08-13", approvers: ["U_APPROVER"], ttlSeconds: 120,
    });
    expect(evaluateTaskWritePolicy(policy, { ...intent, operation: "task.transition", targetId: "ct1" })).toEqual({
      effect: "deny", policyVersion: "2026-08-13", reason: "rule_denied",
    });
  });

  it("rejects invalid or overlong approval configuration", () => {
    expect(() => evaluateTaskWritePolicy({ version: "x", rules: [{ ...policy.rules[1]!, ttlSeconds: 0 }] }, intent)).toThrow("invalid_write_policy");
    expect(() => evaluateTaskWritePolicy({ version: "x", rules: [{ ...policy.rules[1]!, ttlSeconds: 301 }] }, intent)).toThrow("invalid_write_policy");
  });
});
