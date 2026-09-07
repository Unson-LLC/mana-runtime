import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reply requester configuration", () => {
  it("uses the legacy resolver only for T0 and keeps A0 on its canonical actor", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const a0Start = source.indexOf("export async function executeCompanyAuthorityReplyOperation(");
    const sharedStart = source.indexOf("function executeSharedReplyRuntime(input: SharedReplyRuntimeInput)");
    const t0Start = source.indexOf("const ordinaryEvent = tenantBody.payload;");
    const t0End = source.indexOf("async scheduled(", t0Start);
    expect(a0Start).toBeGreaterThanOrEqual(0);
    expect(sharedStart).toBeGreaterThan(a0Start);
    expect(t0Start).toBeGreaterThan(sharedStart);
    expect(t0End).toBeGreaterThan(t0Start);

    const a0 = source.slice(a0Start, sharedStart);
    const shared = source.slice(sharedStart, t0Start);
    const t0 = source.slice(t0Start, t0End);

    expect(shared).toMatch(
      /const actorIdentityResolver = canonicalPersonId === undefined\s*\n\s*\? resolveActorIdentityResolverFromEnv\(env\)\s*\n\s*: undefined;/,
    );
    expect(shared).toContain("resolveActorIdentity: actorIdentityResolver");
    expect(a0).toContain("canonicalPersonId: operation.canonical_person_id as string");
    expect(a0).not.toContain("resolveActorIdentityResolverFromEnv(");
    expect(t0).toContain("processReply: () => executeSharedReplyRuntime({");
    expect(t0).not.toContain("canonicalPersonId:");
  });

  it("logs the three requester preparation boundaries before the reply pipeline", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const sharedStart = source.indexOf("function executeSharedReplyRuntime(input: SharedReplyRuntimeInput)");
    const sharedEnd = source.indexOf("export async function executeCompanyAuthorityReplyOperation(", sharedStart);
    const shared = source.slice(sharedStart, sharedEnd);

    expect(shared).toContain('event: "mana_reply_requester_stage"');
    expect(shared).toContain('runRequesterStage("slack_profile"');
    expect(shared).toContain('runRequesterStage("task_write_capability"');
    expect(shared).toContain('runRequesterStage("graph_context"');
    expect(shared).toContain('state: "started" | "succeeded" | "failed"');
  });
});
