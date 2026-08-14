import { describe, expect, it } from "vitest";

import { applyAnthropicCredential, hasAnthropicCredential } from "../anthropic-auth.js";

describe("Anthropic credential injection", () => {
  it("prefers a dedicated API key and removes an untrusted Authorization header", () => {
    const headers = applyAnthropicCredential(
      new Headers({ Authorization: "Bearer container-value", "x-api-key": "container-key" }),
      { ANTHROPIC_API_KEY: "worker-api-key", CLAUDE_CODE_OAUTH_TOKEN: "worker-oauth" },
    );

    expect(headers?.get("x-api-key")).toBe("worker-api-key");
    expect(headers?.has("Authorization")).toBe(false);
  });

  it("falls back to the existing OAuth secret and removes an untrusted API key", () => {
    const headers = applyAnthropicCredential(
      new Headers({ Authorization: "Bearer container-value", "x-api-key": "container-key" }),
      { CLAUDE_CODE_OAUTH_TOKEN: "worker-oauth" },
    );

    expect(headers?.get("Authorization")).toBe("Bearer worker-oauth");
    expect(headers?.has("x-api-key")).toBe(false);
  });

  it("fails closed when neither Worker secret is configured", () => {
    expect(applyAnthropicCredential(new Headers(), {})).toBeNull();
    expect(hasAnthropicCredential({})).toBe(false);
  });

  it("reports either supported Worker secret as configured", () => {
    expect(hasAnthropicCredential({ ANTHROPIC_API_KEY: "worker-api-key" })).toBe(true);
    expect(hasAnthropicCredential({ CLAUDE_CODE_OAUTH_TOKEN: "worker-oauth" })).toBe(true);
  });
});
