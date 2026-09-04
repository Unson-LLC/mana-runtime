import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reply-only requester configuration", () => {
  it("initializes the legacy identity resolver only inside the reply callback", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const ordinaryReply = source.slice(source.indexOf("const ordinaryEvent = tenantBody.payload;"));
    const replyCallback = ordinaryReply.indexOf("processReply:");
    const resolverInitialization = ordinaryReply.indexOf(
      "const actorIdentityResolver = resolveActorIdentityResolverFromEnv(env);",
    );
    expect(replyCallback).toBeGreaterThanOrEqual(0);
    expect(resolverInitialization).toBeGreaterThan(replyCallback);
  });
});
