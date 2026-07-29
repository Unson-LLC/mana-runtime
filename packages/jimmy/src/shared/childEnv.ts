import { logger } from "./logger.js";

let warnedRoot = false;

export interface BuildChildEnvOptions {
  /** Strip env keys whose name starts with any of these prefixes. */
  stripPrefixes?: string[];
  /** Strip env keys with these exact names. */
  stripExact?: string[];
}

/**
 * Build an env dict for spawning a child CLI.
 *
 * Always strips Claude Code's own runtime markers (CLAUDECODE, CLAUDE_CODE_*)
 * so a nested invocation doesn't think it's running inside another session.
 * Caller can pass extra prefixes/names (e.g. CODEX_*).
 *
 * If the current process is running as root, sets IS_SANDBOX=1 (when not
 * already set). Claude Code refuses to launch as root unless this is set,
 * which is a common foot-gun on Linux servers (e.g. systemd unit without
 * `User=…`, Docker containers running as root).
 */
export function buildChildEnv(opts: BuildChildEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const stripPrefixes = opts.stripPrefixes ?? [];
  const stripExact = new Set(opts.stripExact ?? []);

  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (k.startsWith("OPENRYOKO_SLACK_")) continue;
    if (k === "OPENRYOKO_OPERATOR_TOKEN_SHA256") continue;
    if (stripExact.has(k)) continue;
    if (stripPrefixes.some((p) => k.startsWith(p))) continue;
    if (v !== undefined) env[k] = v;
  }

  if (isRunningAsRoot()) {
    if (!env.IS_SANDBOX) env.IS_SANDBOX = "1";
    if (!warnedRoot) {
      warnedRoot = true;
      logger.warn(
        "Running OpenRyoko as root — injected IS_SANDBOX=1 so the Claude CLI won't refuse. " +
          "Strongly recommended: run under a dedicated unprivileged user (set User=… in your systemd unit).",
      );
    }
  }

  return env;
}

function isRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Test-only: reset the one-shot root warning. */
export function _resetRootWarn(): void {
  warnedRoot = false;
}
