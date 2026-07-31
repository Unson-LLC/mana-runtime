#!/usr/bin/env node
// OpenRyoko placement Bash write guard. Registered as a PreToolUse hook (matcher:
// "Bash") in placement-scoped sessions only. Reads the hook JSON on stdin; when
// the Bash command contains a recognized shell write to a placement-protected
// path under JINN_HOME, prints a permissionDecision:"deny" hook response —
// enforced by Claude Code in every permission mode, including bypassPermissions.
// Anything else exits 0 with no output (allow). Kept standalone (no imports from
// the gateway bundle): it runs inside Claude's hook process.
//
// This is a deterministic guard for REPRESENTATIVE write patterns (redirection,
// tee, cp/mv, sed -i, …), not a full shell parser. The residual gaps (variable
// indirection, interpreter one-liners, symlink aliasing) are documented in
// docs/architecture/08_security_design.md §2.1.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// Must stay in sync with PLACEMENT_PROTECTED_FILES / PLACEMENT_PROTECTED_DIRS in
// packages/jimmy/src/shared/placement-profile.ts (asserted by placement-guard.test.ts).
export const GUARD_PROTECTED_FILES = [
  "config.yaml",
  "CLAUDE.md",
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  // Enforcement integrity: the guard/relay scripts, per-session settings, and
  // gateway discovery info must not be rewritable from a guarded session.
  "gateway.json",
  "gateway.pid",
  "hook-relay.mjs",
  "placement-guard.mjs",
];
export const GUARD_PROTECTED_DIRS = [
  "org",
  "cron",
  "skills",
  "memory",
  "knowledge",
  "docs",
  "tmp/settings",
];

/** Mirror shared/paths.ts resolveHome() precedence (same logic as hook-relay.mjs). */
export function resolveHome() {
  if (process.env.RYOKO_HOME) return process.env.RYOKO_HOME;
  if (process.env.JINN_HOME) return process.env.JINN_HOME;
  const instance = process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE;
  if (instance) return path.join(os.homedir(), `.${instance}`);
  const ryokoHome = path.join(os.homedir(), ".ryoko");
  const jinnHome = path.join(os.homedir(), ".jinn");
  if (fs.existsSync(ryokoHome)) return ryokoHome;
  if (fs.existsSync(jinnHome)) return jinnHome;
  return ryokoHome;
}

/** Commands that mutate ANY path argument they receive (target position varies
 *  or every operand is affected). A protected path anywhere among the args is a
 *  write. */
const WRITE_ANY_ARG_CMDS = new Set([
  "mv", "rm", "rmdir", "unlink", "shred", "truncate", "touch", "mkdir", "ln",
  "chmod", "chown", "chgrp", "tee", "patch",
]);
/** Commands whose LAST path operand is the destination; the earlier operands are
 *  reads. Only the destination is checked so `cp ~/.ryoko/CLAUDE.md /tmp/x`
 *  (a read of the protected file) stays allowed. */
const WRITE_DEST_CMDS = new Set(["cp", "install", "rsync"]);
/** In-place editors: a write only when the -i flag is present. */
const INPLACE_EDIT_CMDS = new Set(["sed", "perl", "ruby"]);
/** Transparent wrappers skipped to find the effective command word. */
const WRAPPER_CMDS = new Set([
  "sudo", "env", "command", "exec", "nohup", "nice", "time", "timeout", "xargs", "builtin", "doas",
]);

/** Strip one layer of surrounding quotes and any unbalanced leading/trailing quote chars. */
function stripQuotes(token) {
  return token.replace(/^["']+/, "").replace(/["']+$/, "");
}

/** Resolve a shell path token to an absolute path, or undefined when it cannot
 *  be a filesystem path we can reason about (contains substitution, etc.). */
function resolveToken(token, cwd, homedir) {
  let t = stripQuotes(token);
  if (!t) return undefined;
  // Variable/command substitution other than $HOME is opaque — not resolvable.
  t = t.replace(/^\$\{HOME\}/, homedir).replace(/^\$HOME(?=\/|$)/, homedir);
  if (t.startsWith("~/") || t === "~") t = path.join(homedir, t.slice(1));
  if (t.includes("$") || t.includes("`")) return undefined;
  if (!path.isAbsolute(t)) {
    if (!cwd) return undefined;
    t = path.resolve(cwd, t);
  }
  return path.normalize(t);
}

/** True when `resolved` is JINN_HOME itself, a protected file, or inside a protected dir. */
function isProtectedPath(resolved, home) {
  if (!resolved) return false;
  const rel = path.relative(home, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (rel === "") return true; // the home dir itself (e.g. rm -rf ~/.ryoko)
  const relPosix = rel.split(path.sep).join("/");
  if (GUARD_PROTECTED_FILES.includes(relPosix)) return true;
  return GUARD_PROTECTED_DIRS.some((d) => relPosix === d || relPosix.startsWith(`${d}/`));
}

/** Split a compound command into rough segments on unquoted-agnostic separators.
 *  Quote-aware parsing is intentionally not attempted; mis-splitting only changes
 *  which segment a token lands in, and the redirection scan below runs on raw
 *  segment text either way. */
function splitSegments(command) {
  return command
    .split(/(?:\|\||&&|;|(?<!>)\||\n|(?<![><])&(?!>))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const REDIRECT_RE = /(?:^|[^><])(?:\d?>{1,2}|&>{1,2}|>\|)\s*([^\s;|&<>]+)/g;

/** Tokenize a segment and skip leading VAR=val assignments and wrapper commands. */
function effectiveTokens(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const bare = stripQuotes(tokens[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) { i++; continue; }
    const cmd = path.basename(bare);
    if (WRAPPER_CMDS.has(cmd)) {
      i++;
      // skip the wrapper's own option flags (e.g. `timeout 5`, `nice -n 10`)
      while (i < tokens.length && (/^-/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]))) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Evaluate one Bash command. Returns a deny reason string when the command
 * contains a recognized shell write to a placement-protected path, else undefined.
 * Exported for unit tests.
 */
export function evaluateBashCommand(command, { home, cwd, homedir = os.homedir() } = {}) {
  if (typeof command !== "string" || !command.trim() || !home) return undefined;

  // Track `cd` across segments so `cd ~/.ryoko && echo x >> CLAUDE.md` resolves
  // the relative target against the changed directory, not the session cwd.
  let curCwd = cwd;
  for (const segment of splitSegments(command)) {
    // 1. Redirection targets — scanned on raw segment text so writes hidden in
    //    `bash -c '… >> ~/.ryoko/CLAUDE.md'` strings are still caught.
    for (const m of segment.matchAll(REDIRECT_RE)) {
      const resolved = resolveToken(m[1], curCwd, homedir);
      if (isProtectedPath(resolved, home)) {
        return `shell redirection into placement-protected path: ${m[1]}`;
      }
    }

    // 2. Write commands with a protected path operand.
    const tokens = effectiveTokens(segment);
    if (tokens.length === 0) continue;
    const cmd = path.basename(stripQuotes(tokens[0]));
    const args = tokens.slice(1);
    const pathArgs = args.filter((t) => !/^-/.test(stripQuotes(t)));

    if (cmd === "cd") {
      curCwd = (pathArgs[0] ? resolveToken(pathArgs[0], curCwd, homedir) : homedir) ?? curCwd;
      continue;
    }

    // dd of=<target> writes regardless of command classification below.
    if (cmd === "dd") {
      for (const a of args) {
        const m = /^of=(.+)$/.exec(stripQuotes(a));
        if (m && isProtectedPath(resolveToken(m[1], curCwd, homedir), home)) {
          return `dd write into placement-protected path: ${m[1]}`;
        }
      }
      continue;
    }

    const hasInPlaceFlag = args.some((a) => /^-i/.test(stripQuotes(a)) || stripQuotes(a) === "--in-place");
    const checkAll = WRITE_ANY_ARG_CMDS.has(cmd) || (INPLACE_EDIT_CMDS.has(cmd) && hasInPlaceFlag);
    const checkDest = WRITE_DEST_CMDS.has(cmd);
    if (!checkAll && !checkDest) continue;

    const candidates = checkAll ? pathArgs : pathArgs.slice(-1);
    for (const a of candidates) {
      if (isProtectedPath(resolveToken(a, curCwd, homedir), home)) {
        return `${cmd} write targeting placement-protected path: ${stripQuotes(a)}`;
      }
    }
  }
  return undefined;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; } // unparsable hook input — allow
  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command;
  const home = resolveHome();
  const reason = evaluateBashCommand(command, { home, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined });
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Placement write boundary: ${reason}. Persona/skills/memory and guard runtime files under ${home} are read-only in placement sessions (docs/architecture/11_persona_skills_memory.md).`,
    },
  }));
}

// Run only when executed directly (the file is also imported by unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { /* a guard crash must not block the session */ }).finally(() => process.exit(0));
}
