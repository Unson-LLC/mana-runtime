import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";
import {
  applyTemplateReplacements,
  buildTemplateReplacements,
} from "../shared/templateReplacements.js";

export interface RuntimeClaudeProjectionOptions {
  portalName: string;
  templateDir?: string;
  runtimeHome?: string;
}

export interface RuntimeClaudeProjection {
  changed: boolean;
  content: string;
  sha256: string;
  sourcePath: string;
  runtimePath: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Render the repository-owned CLAUDE.md template into the runtime home.
 *
 * The repository template is the only authoring source. The runtime file is a
 * deterministic projection and is never treated as input. Writes are atomic,
 * private to the runtime user, and verified by reading the final file back.
 */
export function syncRuntimeClaudeProjection(
  options: RuntimeClaudeProjectionOptions,
): RuntimeClaudeProjection {
  const templateDir = options.templateDir ?? TEMPLATE_DIR;
  const runtimeHome = options.runtimeHome ?? JINN_HOME;
  const sourcePath = path.join(templateDir, "CLAUDE.md");
  const runtimePath = path.join(runtimeHome, "CLAUDE.md");

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Canonical CLAUDE.md template is missing: ${sourcePath}`);
  }

  const template = fs.readFileSync(sourcePath, "utf8");
  const content = applyTemplateReplacements(
    template,
    buildTemplateReplacements(options.portalName),
  );
  const expectedHash = sha256(content);
  const current = fs.existsSync(runtimePath)
    ? fs.readFileSync(runtimePath, "utf8")
    : undefined;
  const changed = current !== content;

  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  if (changed) {
    const nonce = randomBytes(6).toString("hex");
    const tempPath = path.join(runtimeHome, `.CLAUDE.md.${process.pid}.${nonce}.tmp`);
    try {
      fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, runtimePath);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup; preserve the original error.
      }
      throw error;
    }
  }

  // Correct permissions even when the bytes were already current.
  fs.chmodSync(runtimePath, 0o600);
  const projected = fs.readFileSync(runtimePath, "utf8");
  const actualHash = sha256(projected);
  if (projected !== content || actualHash !== expectedHash) {
    throw new Error(`Runtime CLAUDE.md projection verification failed: ${runtimePath}`);
  }

  return {
    changed,
    content: projected,
    sha256: actualHash,
    sourcePath,
    runtimePath,
  };
}
