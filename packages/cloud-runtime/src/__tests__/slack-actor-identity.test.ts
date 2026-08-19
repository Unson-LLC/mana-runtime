import {
  createSlackActorIdentityResolver,
  resolveActorIdentityResolverFromEnv,
  resolveCanonicalPersonId,
  SlackActorIdentityError,
} from "../slack-actor-identity.js";
import type { SlackQueueEvent } from "../types.js";

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvIdentity1",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1.0",
    messageTs: "2.0",
    userId: "U_USER_001",
    eventType: "app_mention",
    text: "私のタスク教えて",
    receivedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

const validMapJson = JSON.stringify({ "T_TECHKNIGHT:U_USER_001": "per_canonical_001" });

describe("resolveCanonicalPersonId", () => {
  it("resolves a mapped actor keyed by workspaceId:userId", () => {
    expect(resolveCanonicalPersonId(validMapJson, "T_TECHKNIGHT", "U_USER_001")).toBe("per_canonical_001");
  });

  it("fails closed for an unmapped actor by returning undefined", () => {
    expect(resolveCanonicalPersonId(validMapJson, "T_TECHKNIGHT", "U_UNKNOWN")).toBeUndefined();
  });

  it("does not fall back to a bare userId key across workspaces", () => {
    const map = JSON.stringify({ U_USER_001: "per_wrong_scope" });
    expect(resolveCanonicalPersonId(map, "T_TECHKNIGHT", "U_USER_001")).toBeUndefined();
  });

  it.each([
    ["invalid JSON", "{not json", "person_map_invalid_json"],
    ["a JSON array", "[1,2,3]", "person_map_invalid_shape"],
    ["a JSON string", "\"hello\"", "person_map_invalid_shape"],
    ["a non-string value", JSON.stringify({ "T:U": 12345 }), "person_map_entry_invalid"],
    ["an empty-string value", JSON.stringify({ "T:U": "" }), "person_map_entry_invalid"],
    ["an oversized value", JSON.stringify({ "T:U": "p".repeat(129) }), "person_map_entry_invalid"],
  ])("fails closed for malformed secret content: %s", (_name, raw, code) => {
    expect(() => resolveCanonicalPersonId(raw, "T_TECHKNIGHT", "U_USER_001")).toThrow(
      expect.objectContaining<Partial<SlackActorIdentityError>>({ code }),
    );
  });

  it("fails closed for an oversized raw secret", () => {
    const raw = JSON.stringify({ "T:U": "p" }).padEnd(200_001, " ");
    expect(() => resolveCanonicalPersonId(raw, "T_TECHKNIGHT", "U_USER_001")).toThrow(
      expect.objectContaining<Partial<SlackActorIdentityError>>({ code: "person_map_too_large" }),
    );
  });

  it("fails closed for a map with too many entries", () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 5_001; index++) entries[`T:U${index}`] = "per_x";
    expect(() => resolveCanonicalPersonId(JSON.stringify(entries), "T_TECHKNIGHT", "U_USER_001")).toThrow(
      expect.objectContaining<Partial<SlackActorIdentityError>>({ code: "person_map_too_many_entries" }),
    );
  });
});

describe("createSlackActorIdentityResolver", () => {
  it("resolves only personId from the map, with no other fields", async () => {
    const resolver = createSlackActorIdentityResolver({ personMapJson: validMapJson });
    await expect(resolver(event())).resolves.toEqual({ personId: "per_canonical_001" });
  });

  it("returns undefined for an unmapped actor", async () => {
    const resolver = createSlackActorIdentityResolver({ personMapJson: validMapJson });
    await expect(resolver(event({ userId: "U_UNKNOWN" }))).resolves.toBeUndefined();
  });

  it("returns undefined when the event has no actor", async () => {
    const resolver = createSlackActorIdentityResolver({ personMapJson: validMapJson });
    await expect(resolver(event({ userId: undefined }))).resolves.toBeUndefined();
  });

  it("throws (fails closed) when the person map secret is malformed", async () => {
    const resolver = createSlackActorIdentityResolver({ personMapJson: "{not json" });
    await expect(resolver(event())).rejects.toThrow(
      expect.objectContaining<Partial<SlackActorIdentityError>>({ code: "person_map_invalid_json" }),
    );
  });

  it("never leaks the userId or personId inside a thrown error's message", async () => {
    const resolver = createSlackActorIdentityResolver({ personMapJson: "{not json" });
    try {
      await resolver(event());
      throw new Error("expected rejection");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("U_USER_001");
      expect(message).not.toContain("per_canonical_001");
    }
  });
});

describe("resolveActorIdentityResolverFromEnv", () => {
  it("wires a resolver only when the person map secret is configured", () => {
    expect(resolveActorIdentityResolverFromEnv({})).toBeUndefined();
    expect(resolveActorIdentityResolverFromEnv({ BRAINBASE_SLACK_PERSON_MAP_JSON: "" })).toBeUndefined();
    expect(resolveActorIdentityResolverFromEnv({
      BRAINBASE_SLACK_PERSON_MAP_JSON: validMapJson,
    })).toBeTypeOf("function");
  });

  it("returns a resolver that resolves the configured actor end-to-end from the map alone", async () => {
    const resolver = resolveActorIdentityResolverFromEnv({
      BRAINBASE_SLACK_PERSON_MAP_JSON: validMapJson,
    });
    await expect(resolver?.(event())).resolves.toEqual({ personId: "per_canonical_001" });
  });
});
