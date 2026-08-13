import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("task runtime core package boundary", () => {
  it("story-shared-task-runtime-core:ac:8 keeps platform runtimes outside the shared package", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/node:|process\.env|@cloudflare|@slack|better-sqlite3/);
    expect(source).not.toMatch(/Canvas|Sandbox|SlackQueueEvent|Claude/);
  });
});
