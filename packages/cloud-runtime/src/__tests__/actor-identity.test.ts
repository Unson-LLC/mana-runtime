import { resolveTurnActorIdentity, sanitizeActorIdentity } from "../actor-identity.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvIdentity1",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1.0",
    messageTs: "2.0",
    userId: "U_USER",
    eventType: "app_mention",
    text: "test request",
    receivedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("sanitizeActorIdentity", () => {
  it("passes through a well-formed identity", () => {
    expect(sanitizeActorIdentity({ personId: "per_abc123", displayName: "Test User" })).toEqual({
      personId: "per_abc123",
      displayName: "Test User",
    });
  });

  it("rejects a missing identity", () => {
    expect(sanitizeActorIdentity(undefined)).toBeUndefined();
  });

  it("rejects an empty personId", () => {
    expect(sanitizeActorIdentity({ personId: "", displayName: "Test User" })).toBeUndefined();
  });

  it("keeps a resolved personId when displayName is empty, dropping displayName", () => {
    expect(sanitizeActorIdentity({ personId: "per_abc123", displayName: "" })).toEqual({ personId: "per_abc123" });
  });

  it("rejects an oversized personId", () => {
    expect(sanitizeActorIdentity({ personId: "p".repeat(129), displayName: "Test User" })).toBeUndefined();
  });

  it("keeps a resolved personId when displayName is oversized, dropping displayName", () => {
    expect(sanitizeActorIdentity({ personId: "per_abc123", displayName: "n".repeat(81) }))
      .toEqual({ personId: "per_abc123" });
  });

  it("rejects a personId containing a control character", () => {
    const personId = "per_abc" + String.fromCharCode(0) + "123";
    expect(sanitizeActorIdentity({ personId, displayName: "Test User" })).toBeUndefined();
  });

  it("keeps a resolved personId when displayName has a control character, dropping displayName", () => {
    const displayName = "Test" + String.fromCharCode(10) + "User";
    expect(sanitizeActorIdentity({ personId: "per_abc123", displayName })).toEqual({ personId: "per_abc123" });
  });

  it("keeps a resolved personId when displayName is absent entirely", () => {
    expect(sanitizeActorIdentity({ personId: "per_abc123" })).toEqual({ personId: "per_abc123" });
  });
});

describe("resolveTurnActorIdentity", () => {
  it("resolves when task search is enabled and the resolver returns an identity", async () => {
    const resolver = vi.fn().mockResolvedValue({ personId: "per_abc123", displayName: "Test User" });

    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: true,
      resolveActorIdentity: resolver,
    })).resolves.toEqual({
      outcome: "resolved",
      identity: { personId: "per_abc123", displayName: "Test User" },
    });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("is unavailable when task search is disabled, without calling the resolver", async () => {
    const resolver = vi.fn().mockResolvedValue({ personId: "per_abc123", displayName: "Test User" });

    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: false,
      resolveActorIdentity: resolver,
    })).resolves.toEqual({ outcome: "unavailable", reasonCode: "task_search_disabled" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("is unavailable when no resolver is configured", async () => {
    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: true,
    })).resolves.toEqual({ outcome: "unavailable", reasonCode: "identity_resolver_not_configured" });
  });

  it("is unavailable when the resolver finds no match for the actor", async () => {
    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: true,
      resolveActorIdentity: vi.fn().mockResolvedValue(undefined),
    })).resolves.toEqual({ outcome: "unavailable", reasonCode: "identity_unresolved" });
  });

  it("is unavailable when the resolver returns an invalid identity", async () => {
    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: true,
      resolveActorIdentity: vi.fn().mockResolvedValue({ personId: "", displayName: "Test User" }),
    })).resolves.toEqual({ outcome: "unavailable", reasonCode: "identity_invalid" });
  });

  it("is unavailable when the resolver throws", async () => {
    await expect(resolveTurnActorIdentity(event(), {
      taskSearchEnabled: true,
      resolveActorIdentity: vi.fn().mockRejectedValue(new Error("upstream_unavailable")),
    })).resolves.toEqual({ outcome: "unavailable", reasonCode: "identity_resolution_failed" });
  });
});
