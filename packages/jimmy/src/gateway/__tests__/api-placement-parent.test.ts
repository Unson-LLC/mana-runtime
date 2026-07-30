import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import {
  authorizeDerivedSessionRequest,
  CONFIG_KNOWN_KEYS,
  resolveDerivedPlacement,
  resolveRequestedParentSession,
} from "../api.js";
import { getSessionDelegationToken } from "../../sessions/delegation-auth.js";
import { logger } from "../../shared/logger.js";

function makeSession(id: string): Session {
  return {
    id,
    engine: "claude",
    source: "slack",
    sourceRef: `slack:${id}`,
    connector: "slack",
    sessionKey: `slack:${id}`,
    replyContext: { channel: "C1" },
    status: "idle",
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    transportMeta: { placementId: "pilot" },
  } as unknown as Session;
}

describe("placement child parent resolution", () => {
  it("resolves an existing URL-bound parent for inherited placement", () => {
    const parent = makeSession("parent-1");
    const result = resolveRequestedParentSession(
      "parent-1",
      undefined,
      (id) => id === parent.id ? parent : undefined,
    );

    expect(result).toEqual({
      parentSession: parent,
      parentSessionId: "parent-1",
      missing: false,
      urlBound: true,
    });
    expect(result.parentSession?.transportMeta).toEqual({ placementId: "pilot" });
  });

  it("marks a nonexistent generic parent as invalid instead of creating an orphan", () => {
    expect(resolveRequestedParentSession(
      undefined,
      "missing-parent",
      () => undefined,
    )).toEqual({
      parentSession: undefined,
      parentSessionId: "missing-parent",
      missing: true,
      urlBound: false,
    });
  });

  it("allows legacy top-level creation only when no parent was requested", () => {
    expect(resolveRequestedParentSession(undefined, undefined, () => undefined)).toEqual({
      missing: false,
      urlBound: false,
    });
  });
});

describe("placement inheritance for derived sessions", () => {
  const placement = {
    id: "pilot",
    connector: "slack",
    workspaceId: "T1",
    channelId: "C1",
    audience: { type: "operator" as const, allowedUsers: ["U1"] },
    agent: {
      employee: "ryoko",
      escalationEmployee: "reviewer",
    },
  };

  it("inherits the parent placement for an allowed child or cross-request provider", () => {
    expect(resolveDerivedPlacement(
      { placements: [placement] },
      makeSession("parent-1"),
      "reviewer",
    )).toEqual({ placement });
  });

  it("rejects a provider outside the parent placement", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveDerivedPlacement(
      { placements: [placement] },
      makeSession("parent-1"),
      "unscoped-employee",
    )).toEqual({
      error: 'employee "unscoped-employee" is not allowed by placement "pilot"',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"employee_denied"'));
    warn.mockRestore();
  });

  it("fails closed when the parent placement kill switch is off", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveDerivedPlacement(
      { placements: [{ ...placement, enabled: false }] },
      makeSession("parent-1"),
      "reviewer",
    )).toEqual({ error: 'parent placement "pilot" is disabled' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"placement_disabled"'));
    warn.mockRestore();
  });

  it("fails closed when the parent placement is no longer configured", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(resolveDerivedPlacement(
      { placements: [] },
      makeSession("parent-1"),
      "reviewer",
    )).toEqual({ error: 'parent placement "pilot" is not configured' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"placement_missing_after_config_change"'));
    warn.mockRestore();
  });
});

describe("placement parent authorization", () => {
  it("accepts only the token bound to the selected placement parent", () => {
    const parent = makeSession("parent-1");
    expect(authorizeDerivedSessionRequest(parent, getSessionDelegationToken(parent.id))).toBe(true);
    expect(authorizeDerivedSessionRequest(parent, getSessionDelegationToken("parent-2"))).toBe(false);
    expect(authorizeDerivedSessionRequest(parent, undefined)).toBe(false);
  });

  it("keeps legacy non-placement parent behavior compatible", () => {
    const parent = makeSession("legacy-parent");
    parent.transportMeta = {};
    expect(authorizeDerivedSessionRequest(parent, undefined)).toBe(true);
  });
});

it("accepts placements as a persisted config surface", () => {
  expect(CONFIG_KNOWN_KEYS).toContain("placements");
});
