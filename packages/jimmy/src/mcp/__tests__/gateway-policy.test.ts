import { describe, expect, it } from "vitest";
import {
  allowedGatewayTools,
  buildCreateChildSessionRequest,
  isDeliveryTargetAllowed,
  isGatewayToolAllowed,
} from "../gateway-policy.js";

describe("gateway placement policy", () => {
  it("preserves legacy behavior when policy is absent", () => {
    expect(isGatewayToolAllowed("send_message", undefined)).toBe(true);
    expect(isDeliveryTargetAllowed("slack", "C1", undefined)).toBe(true);
  });

  it("filters and rejects tools not explicitly allowed", () => {
    const raw = JSON.stringify(["list_sessions"]);
    expect(isGatewayToolAllowed("send_message", raw)).toBe(false);
    expect(allowedGatewayTools([{ name: "send_message" }, { name: "list_sessions" }], raw))
      .toEqual([{ name: "list_sessions" }]);
  });

  it("allows only exact proactive delivery targets", () => {
    const raw = JSON.stringify([{ connector: "slack", channel: "C1" }]);
    expect(isDeliveryTargetAllowed("slack", "C1", raw)).toBe(true);
    expect(isDeliveryTargetAllowed("slack", "C2", raw)).toBe(false);
  });

  it("fails closed for malformed policy", () => {
    expect(isGatewayToolAllowed("send_message", "not-json")).toBe(false);
    expect(isDeliveryTargetAllowed("slack", "C1", "not-json")).toBe(false);
  });

  it("binds child creation to the current session and nested endpoint", () => {
    expect(buildCreateChildSessionRequest(
      { prompt: "delegate", employee: "reviewer" },
      "parent/session",
    )).toEqual({
      path: "/api/sessions/parent%2Fsession/children",
      body: { prompt: "delegate", employee: "reviewer" },
    });
  });

  it("allows employee omission so the server can inherit the parent employee", () => {
    expect(buildCreateChildSessionRequest({ prompt: "continue" }, "parent")).toEqual({
      path: "/api/sessions/parent/children",
      body: { prompt: "continue", employee: undefined },
    });
  });

  it.each(["engine", "model", "effortLevel"])("rejects a %s override", (field) => {
    expect(() => buildCreateChildSessionRequest(
      { prompt: "delegate", [field]: "override" },
      "parent",
    )).toThrow("create_child_session cannot override engine, model, or effort");
  });

  it("rejects child creation without a current parent", () => {
    expect(() => buildCreateChildSessionRequest({ prompt: "delegate" })).toThrow(
      "create_child_session requires a current parent session",
    );
  });

  it("rejects an attempt to substitute another parent session", () => {
    expect(() => buildCreateChildSessionRequest(
      { prompt: "delegate", parentSessionId: "other-parent" },
      "current-parent",
    )).toThrow("create_child_session cannot override the current parent session");
  });
});
