import fs from "node:fs";
import path from "node:path";

export interface SessionSettingsOpts {
  sessionId: string;
  relayScript: string;
  appendSystemPrompt?: string;
  /** When set (placement sessions), register this script as a PreToolUse hook
   *  with matcher "Bash" — the deterministic shell-write guard for
   *  placement-protected paths (see assets/placement-guard.mjs). */
  placementGuardScript?: string;
}

interface HookCommand { type: "command"; command: string; }
interface HookMatcher { matcher?: string; hooks: HookCommand[]; }

/** POSIX single-quote a string so a path with spaces or shell metacharacters in
 *  JINN_HOME (e.g. "/Users/My User/.ryoko") can't break or inject into the hook
 *  command, which Claude Code runs through a shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// StopFailure fires INSTEAD of Stop when an API error ends the turn (rate_limit,
// billing_error, server_error, …) — confirmed by the Phase 0 spike. It is the
// structured rate-limit signal, so it must be registered alongside Stop.
export interface ClaudeSettings {
  hooks: Record<"SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse", HookMatcher[]>;
  appendSystemPrompt?: string;
}

export function buildSessionSettings(opts: SessionSettingsOpts): ClaudeSettings {
  // Relay is invoked as: node <relayScript> <jinnSessionId>
  // It reads the hook JSON on stdin and POSTs to the gateway.
  const command = `node ${shellQuote(opts.relayScript)} ${shellQuote(opts.sessionId)}`;
  const cmd = (): HookMatcher => ({
    hooks: [{ type: "command", command }],
  });
  return {
    hooks: {
      SessionStart: [cmd()],
      Stop: [cmd()],
      StopFailure: [cmd()],
      // Guard first: any deny wins across PreToolUse hooks, and the guard's
      // decision must not depend on relay delivery.
      PreToolUse: [
        ...(opts.placementGuardScript ? [placementGuardMatcher(opts.placementGuardScript)] : []),
        cmd(),
      ],
      PostToolUse: [cmd()],
    },
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  };
}

function placementGuardMatcher(guardScript: string): HookMatcher {
  return { matcher: "Bash", hooks: [{ type: "command", command: `node ${shellQuote(guardScript)}` }] };
}

/** Guard-only settings for headless (`claude -p`) placement runs, which use no
 *  hook relay. Written idempotently: content depends only on the script path. */
export function writePlacementGuardSettings(dir: string, guardScript: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "placement-guard-settings.json");
  const content = JSON.stringify({ hooks: { PreToolUse: [placementGuardMatcher(guardScript)] } }, null, 2);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export function sessionSettingsPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

export function writeSessionSettings(dir: string, sessionId: string, opts: SessionSettingsOpts): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = sessionSettingsPath(dir, sessionId);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buildSessionSettings(opts), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  // Defensive: ensure the final file has 0o600 even if the target pre-existed.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export function cleanupSessionSettings(dir: string, sessionId: string): void {
  try { fs.unlinkSync(sessionSettingsPath(dir, sessionId)); } catch { /* best effort */ }
}

/** Idempotently mark a project directory trusted in the real ~/.claude.json. */
export function seedTrust(claudeJsonPath: string, projectDir: string): void {
  const realDir = fs.realpathSync(projectDir);
  let data: any = {};
  try { data = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8")); } catch { /* new file */ }
  data.projects ??= {};
  const proj = (data.projects[realDir] ??= {});
  if (proj.hasTrustDialogAccepted === true && proj.hasCompletedProjectOnboarding === true) return;
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  proj.allowedTools ??= [];
  const tmp = `${claudeJsonPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, claudeJsonPath);
  // Defensive: ensure the final file has 0o600 even if the target pre-existed
  // with a more permissive mode (rename preserves the destination inode's perms
  // on some platforms / filesystems is not guaranteed — be explicit).
  fs.chmodSync(claudeJsonPath, 0o600);
}
