import { describe, expect, it } from "vitest";
import { getSessionDelegationToken, verifySessionDelegationToken } from "../delegation-auth.js";

describe("session delegation authorization", () => {
  it("binds a token to exactly one session id", () => {
    const token = getSessionDelegationToken("session-a");
    expect(verifySessionDelegationToken("session-a", token)).toBe(true);
    expect(verifySessionDelegationToken("session-b", token)).toBe(false);
    expect(verifySessionDelegationToken("session-a", undefined)).toBe(false);
  });
});
