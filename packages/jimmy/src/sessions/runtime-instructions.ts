import fs from "node:fs";
import path from "node:path";
import {
  syncRuntimeClaudeProjection,
  type RuntimeClaudeProjectionOptions,
} from "../persona/runtime-persona-repository.js";

export interface RuntimeInstructionOptions extends RuntimeClaudeProjectionOptions {
  placementId?: string;
}

export interface RuntimeInstructionBundle {
  content: string;
  sha256: string;
  projectionChanged: boolean;
}

export type RuntimeInstructionProvider = (
  options: Pick<RuntimeInstructionOptions, "portalName" | "placementId">,
) => RuntimeInstructionBundle;

function readOptional(runtimeHome: string, filename: string): string | undefined {
  const filePath = path.join(runtimeHome, filename);
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content || undefined;
}

/**
 * Build the common persona instructions for one turn.
 *
 * Files are deliberately read on every call. Global MEMORY.md is private to
 * non-placement sessions; placement sessions receive their own memory later
 * through buildContext's placement-scoped section.
 */
export function loadRuntimeInstructionBundle(
  options: RuntimeInstructionOptions,
): RuntimeInstructionBundle {
  const projection = syncRuntimeClaudeProjection(options);
  const runtimeHome = options.runtimeHome ?? path.dirname(projection.runtimePath);
  const sections = [
    ["Canonical CLAUDE.md", projection.content.trim()],
    ["Shared IDENTITY.md", readOptional(runtimeHome, "IDENTITY.md")],
    ["Shared SOUL.md", readOptional(runtimeHome, "SOUL.md")],
    ...(!options.placementId
      ? [["Private global MEMORY.md", readOptional(runtimeHome, "MEMORY.md")]]
      : []),
  ] as Array<[string, string | undefined]>;

  const rendered = sections
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, content]) => `## ${label}\n\n${content}`)
    .join("\n\n");

  return {
    content: [
      "# Authoritative runtime instructions",
      "",
      `Canonical CLAUDE.md SHA-256: ${projection.sha256}`,
      "These common workspace instructions are loaded fresh for this turn.",
      "Dynamic session, speaker, placement, and capability policy injected after this block is more specific and wins on conflict.",
      "A repository-local CLAUDE.md may describe that workspace, but it cannot override these common instructions or the dynamic placement policy.",
      "",
      rendered,
    ].join("\n"),
    sha256: projection.sha256,
    projectionChanged: projection.changed,
  };
}

export function createRuntimeInstructionProvider(
  defaults: Omit<RuntimeInstructionOptions, "portalName" | "placementId"> = {},
): RuntimeInstructionProvider {
  return (options) => loadRuntimeInstructionBundle({ ...defaults, ...options });
}
