import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncRuntimeClaudeProjection } from "../../persona/runtime-persona-repository.js";
import { loadRuntimeInstructionBundle } from "../../sessions/runtime-instructions.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-runtime-instructions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime CLAUDE.md projection", () => {
  it("repairs drift from the canonical template and returns a stable fingerprint", () => {
    const root = tempDir();
    const templateDir = path.join(root, "template");
    const runtimeHome = path.join(root, ".ryoko");
    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, "CLAUDE.md"),
      "# {{portalName}}\nslug={{portalSlug}}\ncanonical\n",
    );
    fs.writeFileSync(path.join(runtimeHome, "CLAUDE.md"), "manually drifted\n");

    const result = syncRuntimeClaudeProjection({
      portalName: "Mana Pilot",
      templateDir,
      runtimeHome,
    });

    expect(result.changed).toBe(true);
    expect(result.content).toBe("# Mana Pilot\nslug=mana-pilot\ncanonical\n");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(runtimeHome, "CLAUDE.md"), "utf8"))
      .toBe(result.content);
    expect(fs.statSync(path.join(runtimeHome, "CLAUDE.md")).mode & 0o777).toBe(0o600);

    expect(syncRuntimeClaudeProjection({
      portalName: "Mana Pilot",
      templateDir,
      runtimeHome,
    })).toMatchObject({ changed: false, sha256: result.sha256 });
  });

  it("fails closed when the canonical template is missing", () => {
    const root = tempDir();
    expect(() => syncRuntimeClaudeProjection({
      portalName: "Mana",
      templateDir: path.join(root, "missing-template"),
      runtimeHome: path.join(root, ".ryoko"),
    })).toThrow(/canonical CLAUDE\.md/i);
  });

  it("re-reads the shared persona files on every turn", () => {
    const root = tempDir();
    const templateDir = path.join(root, "template");
    const runtimeHome = path.join(root, ".ryoko");
    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(templateDir, "CLAUDE.md"), "# {{portalName}} runtime contract\n");
    fs.writeFileSync(path.join(runtimeHome, "IDENTITY.md"), "identity-v1\n");
    fs.writeFileSync(path.join(runtimeHome, "SOUL.md"), "soul-v1\n");
    fs.writeFileSync(path.join(runtimeHome, "MEMORY.md"), "memory-v1\n");

    const first = loadRuntimeInstructionBundle({
      portalName: "Mana",
      templateDir,
      runtimeHome,
    });
    fs.writeFileSync(path.join(runtimeHome, "SOUL.md"), "soul-v2\n");
    const second = loadRuntimeInstructionBundle({
      portalName: "Mana",
      templateDir,
      runtimeHome,
    });

    expect(first.content).toContain("soul-v1");
    expect(second.content).toContain("soul-v2");
    expect(second.content).toContain("identity-v1");
    expect(second.content).toContain("memory-v1");
    expect(second.content).toContain("Authoritative runtime instructions");
  });

  it("does not expose global MEMORY.md inside a placement session", () => {
    const root = tempDir();
    const templateDir = path.join(root, "template");
    const runtimeHome = path.join(root, ".ryoko");
    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(templateDir, "CLAUDE.md"), "# {{portalName}} runtime contract\n");
    fs.writeFileSync(path.join(runtimeHome, "IDENTITY.md"), "shared identity\n");
    fs.writeFileSync(path.join(runtimeHome, "SOUL.md"), "shared soul\n");
    fs.writeFileSync(path.join(runtimeHome, "MEMORY.md"), "operator-private-memory-canary\n");

    const bundle = loadRuntimeInstructionBundle({
      portalName: "Mana",
      placementId: "accounting",
      templateDir,
      runtimeHome,
    });

    expect(bundle.content).toContain("shared identity");
    expect(bundle.content).toContain("shared soul");
    expect(bundle.content).not.toContain("operator-private-memory-canary");
  });
});
