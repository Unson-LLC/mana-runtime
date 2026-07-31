import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { JINN_HOME, SKILLS_DIR } from "../shared/paths.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const SKILLS_JSON = path.join(JINN_HOME, "skills.json");

/** Well-known directories where `npx skills add -g` may install skills. */
const GLOBAL_SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".codex", "skills"),
];

// ── Manifest helpers ──────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  source: string;
  installedAt: string;
}

export function readManifest(): SkillManifestEntry[] {
  if (!fs.existsSync(SKILLS_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(SKILLS_JSON, "utf-8"));
  } catch {
    return [];
  }
}

export function writeManifest(entries: SkillManifestEntry[]): void {
  fs.writeFileSync(SKILLS_JSON, JSON.stringify(entries, null, 2) + "\n");
}

export function upsertManifest(name: string, source: string): void {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  const entry: SkillManifestEntry = {
    name,
    source,
    installedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    manifest[idx] = entry;
  } else {
    manifest.push(entry);
  }
  writeManifest(manifest);
}

export function removeFromManifest(name: string): boolean {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  if (idx < 0) return false;
  manifest.splice(idx, 1);
  writeManifest(manifest);
  return true;
}

// ── Frontmatter capability declaration (docs/specs/placement-read-filters.md) ──

export interface SkillCapabilityMeta {
  /** MCP server names this skill needs (placement capabilities.mcp vocabulary). */
  requiredMcp: string[];
  /** Gateway tool names this skill needs (placement capabilities.gatewayTools vocabulary). */
  requiredTools: string[];
  /** brainbase project name (same vocabulary as placement projects). Absent = global. */
  scope?: string;
}

export interface SkillListing extends SkillCapabilityMeta {
  name: string;
  description: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

/** Accepts inline arrays (`[a, b]`), YAML block lists, and bare single strings. */
function parseFrontmatterStringArray(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\][ \\t]*$`, "m"));
  if (inline) {
    return inline[1].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  const block = frontmatter.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+-[ \\t]+[^\\n]+\\n?)+)`, "m"));
  if (block) {
    return block[1]
      .split("\n")
      .map((line) => stripQuotes(line.replace(/^[ \t]+-[ \t]+/, "").trim()))
      .filter(Boolean);
  }
  const single = frontmatter.match(new RegExp(`^${key}:[ \\t]*(\\S[^\\n]*)$`, "m"));
  if (single) {
    const value = stripQuotes(single[1].trim());
    return value ? [value] : [];
  }
  return [];
}

export function parseSkillFrontmatter(content: string): { description: string } & SkillCapabilityMeta {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const descMatch = frontmatter.match(/^description:[ \t]*(.+)$/m);
  const scopeValues = parseFrontmatterStringArray(frontmatter, "scope");
  return {
    description: descMatch ? descMatch[1].trim() : "",
    requiredMcp: parseFrontmatterStringArray(frontmatter, "requiredMcp"),
    requiredTools: parseFrontmatterStringArray(frontmatter, "requiredTools"),
    scope: scopeValues.length > 0 ? scopeValues[0] : undefined,
  };
}

/** Fallback when frontmatter has no description: ## Trigger section, then first body line. */
function fallbackDescription(content: string): string {
  const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
  if (triggerMatch) return triggerMatch[1].trim();
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}

/** List installed skills with their capability declarations. */
export function listSkills(dir: string = SKILLS_DIR): SkillListing[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries.map((e) => {
    const skillMd = path.join(dir, e.name, "SKILL.md");
    let meta: { description: string } & SkillCapabilityMeta = {
      description: "",
      requiredMcp: [],
      requiredTools: [],
      scope: undefined,
    };
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      meta = parseSkillFrontmatter(content);
      if (!meta.description) meta.description = fallbackDescription(content);
    }
    return { name: e.name, ...meta };
  });
}

// ── Snapshot helpers for detecting newly installed skills ─────────

export function snapshotDirs(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of GLOBAL_SKILL_DIRS) {
    if (!fs.existsSync(dir)) {
      snap.set(dir, new Set());
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    snap.set(dir, new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name)));
  }
  return snap;
}

export function diffSnapshots(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): Array<{ dir: string; name: string }> {
  const newEntries: Array<{ dir: string; name: string }> = [];
  for (const [dir, afterSet] of after) {
    const beforeSet = before.get(dir) || new Set();
    for (const name of afterSet) {
      if (!beforeSet.has(name)) {
        newEntries.push({ dir, name });
      }
    }
  }
  return newEntries;
}

// ── Helpers ───────────────────────────────────────────────────────

export function extractSkillName(pkg: string): string {
  // "owner/repo@skill-name" → "skill-name"
  const atIdx = pkg.lastIndexOf("@");
  if (atIdx > 0) return pkg.slice(atIdx + 1);
  // "owner/repo" → "repo"
  const slashIdx = pkg.lastIndexOf("/");
  if (slashIdx >= 0) return pkg.slice(slashIdx + 1);
  return pkg;
}

export function findExistingSkill(name: string): { name: string; dir: string } | null {
  for (const dir of GLOBAL_SKILL_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return { name, dir: candidate };
    }
  }
  return null;
}

export function copySkillToInstance(name: string, sourceDir: string): void {
  const destDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  copyDirRecursive(sourceDir, destDir);
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── CLI action functions ──────────────────────────────────────────

export function skillsFind(query?: string): void {
  const args = ["skills", "find"];
  if (query) args.push(query);
  const result = spawnSync("npx", args, {
    stdio: "inherit",
    shell: true,
  });
  process.exitCode = result.status ?? 1;
}

export function skillsAdd(pkg: string): void {
  console.log(`\nスキルをインストール中: ${pkg}\n`);

  // Snapshot before
  const before = snapshotDirs();

  // Run npx skills add
  const result = spawnSync("npx", ["skills", "add", pkg, "-g", "-y"], {
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    console.error(`\n${RED}スキルのインストールに失敗しました。${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Snapshot after to detect new directories
  const after = snapshotDirs();
  const newDirs = diffSnapshots(before, after);

  if (newDirs.length === 0) {
    // Skill may have been already installed globally — try to find it by name
    const skillName = extractSkillName(pkg);
    const existing = findExistingSkill(skillName);
    if (existing) {
      copySkillToInstance(existing.name, existing.dir);
      upsertManifest(existing.name, pkg);
      console.log(`\n${GREEN}スキル "${existing.name}" を ${SKILLS_DIR} に追加しました${RESET}`);
    } else {
      console.log(`\n${YELLOW}グローバルにはインストール済みですが、ディレクトリの特定に失敗しました。${RESET}`);
    }
    return;
  }

  // Copy first new directory to our skills dir
  const installed = newDirs[0];
  copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
  upsertManifest(installed.name, pkg);
  console.log(`\n${GREEN}スキル "${installed.name}" を ${SKILLS_DIR} に追加しました${RESET}`);
}

export function skillsRemove(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) {
    console.error(`${RED}スキル "${name}" は ${SKILLS_DIR} に見つかりません${RESET}`);
    process.exitCode = 1;
    return;
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  removeFromManifest(name);
  console.log(`${GREEN}スキル "${name}" を削除しました。${RESET}`);
}

export function skillsList(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("インストール済みスキルがありません。");
    return;
  }

  const manifest = readManifest();
  const manifestMap = new Map(manifest.map((e) => [e.name, e]));

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  if (skillDirs.length === 0) {
    console.log("インストール済みスキルがありません。");
    return;
  }

  console.log(`\n  ${DIM}${SKILLS_DIR}${RESET} のスキル\n`);
  for (const dir of skillDirs) {
    const meta = manifestMap.get(dir.name);
    const source = meta ? `${DIM}(${meta.source})${RESET}` : `${DIM}(local)${RESET}`;
    const skillMd = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    let description = "";
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) description = `  ${DIM}${descMatch[1].trim()}${RESET}`;
      }
    }
    console.log(`  ${GREEN}${dir.name}${RESET} ${source}${description}`);
  }
  console.log("");
}

export function skillsUpdate(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("更新対象のスキルがマニフェストにありません。");
    return;
  }

  console.log(`\n${manifest.length} 件のスキルを更新中...\n`);
  for (const entry of manifest) {
    console.log(`  ${entry.name} を ${entry.source} から更新中...`);
    const before = snapshotDirs();
    const result = spawnSync("npx", ["skills", "add", entry.source, "-g", "-y"], {
      stdio: "pipe",
      shell: true,
    });

    if (result.status !== 0) {
      console.log(`  ${RED}${entry.name} の更新に失敗${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    upsertManifest(entry.name, entry.source);
    console.log(`  ${GREEN}${entry.name} を更新しました${RESET}`);
  }
  console.log("");
}

export function skillsRestore(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("復元対象のスキルがマニフェストにありません。");
    return;
  }

  console.log(`\n${manifest.length} 件のスキルを復元中...\n`);
  for (const entry of manifest) {
    const destDir = path.join(SKILLS_DIR, entry.name);
    if (fs.existsSync(destDir)) {
      console.log(`  ${DIM}${entry.name} already exists, skipping${RESET}`);
      continue;
    }

    console.log(`  Installing ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = spawnSync("npx", ["skills", "add", entry.source, "-g", "-y"], {
      stdio: "pipe",
      shell: true,
    });

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to install ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    console.log(`  ${GREEN}Restored ${entry.name}${RESET}`);
  }
  console.log("");
}
