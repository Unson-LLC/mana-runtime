import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills, parseSkillFrontmatter } from "../skills.js";

const tmpDirs: string[] = [];

function makeSkillsDir(skills: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  tmpDirs.push(dir);
  for (const [name, skillMd] of Object.entries(skills)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), skillMd);
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseSkillFrontmatter", () => {
  it("parses requiredMcp/requiredTools/scope capability declarations", () => {
    const meta = parseSkillFrontmatter([
      "---",
      "name: salestailor-weekly-sync",
      "description: SalesTailor専用の週次同期",
      "requiredMcp: [nocodb, brainbase]",
      "requiredTools:",
      "  - create_task",
      "  - update_task",
      "scope: salestailor",
      "---",
      "",
      "# Body",
    ].join("\n"));
    expect(meta.description).toBe("SalesTailor専用の週次同期");
    expect(meta.requiredMcp).toEqual(["nocodb", "brainbase"]);
    expect(meta.requiredTools).toEqual(["create_task", "update_task"]);
    expect(meta.scope).toBe("salestailor");
  });

  it("accepts bare single strings and quoted values", () => {
    const meta = parseSkillFrontmatter([
      "---",
      "requiredMcp: nocodb",
      'scope: "salestailor"',
      "---",
    ].join("\n"));
    expect(meta.requiredMcp).toEqual(["nocodb"]);
    expect(meta.requiredTools).toEqual([]);
    expect(meta.scope).toBe("salestailor");
  });

  it("treats undeclared skills as global with no capability requirements (backward compat)", () => {
    const meta = parseSkillFrontmatter([
      "---",
      "description: 旧来のスキル",
      "---",
      "手順",
    ].join("\n"));
    expect(meta.requiredMcp).toEqual([]);
    expect(meta.requiredTools).toEqual([]);
    expect(meta.scope).toBeUndefined();
    expect(meta.description).toBe("旧来のスキル");
  });

  it("handles content with no frontmatter at all", () => {
    const meta = parseSkillFrontmatter("# Just a heading\nBody text");
    expect(meta.description).toBe("");
    expect(meta.requiredMcp).toEqual([]);
    expect(meta.scope).toBeUndefined();
  });
});

describe("listSkills", () => {
  it("lists skills with capability declarations and falls back for descriptions", () => {
    const dir = makeSkillsDir({
      "scoped-skill": [
        "---",
        "description: scoped",
        "requiredMcp: [nocodb]",
        "scope: salestailor",
        "---",
      ].join("\n"),
      "legacy-skill": "# Legacy\nFirst body line as description",
    });
    const skills = listSkills(dir).sort((a, b) => a.name.localeCompare(b.name));
    expect(skills).toEqual([
      {
        name: "legacy-skill",
        description: "First body line as description",
        requiredMcp: [],
        requiredTools: [],
        scope: undefined,
      },
      {
        name: "scoped-skill",
        description: "scoped",
        requiredMcp: ["nocodb"],
        requiredTools: [],
        scope: "salestailor",
      },
    ]);
  });

  it("returns an empty list when the skills dir does not exist", () => {
    expect(listSkills(path.join(os.tmpdir(), "no-such-skills-dir"))).toEqual([]);
  });
});
