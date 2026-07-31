import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";
import { logger } from "./logger.js";

/**
 * Pre-write snapshots for runtime-managed config files (config.yaml,
 * cron/jobs.json). Every runtime write path calls recordConfigChange()
 * BEFORE overwriting the target, so the previous state is always
 * recoverable and every change is attributable to a route.
 *
 * Snapshots are verbatim copies of config.yaml, which may reference (but
 * per policy must not contain) secrets — the directory is therefore kept
 * 0o700 / files 0o600, and the history API exposes metadata only, never
 * snapshot contents.
 */

export const CONFIG_HISTORY_LIMIT = 100;

export interface ConfigHistoryEntry {
  /** ISO timestamp of the write. */
  ts: string;
  /** Which code path wrote (e.g. "api/config", "api/cron", "cron/scheduler"). */
  source: string;
  /** Target file, relative to the runtime home (e.g. "config.yaml"). */
  file: string;
  /** Snapshot filename inside config-history/, or null if the target did not exist yet. */
  snapshot: string | null;
  /** Whether the triggering request carried a valid operator token. Absent for non-API paths. */
  operatorAuthenticated?: boolean;
}

function historyDir(): string {
  return path.join(JINN_HOME, "config-history");
}

function indexPath(): string {
  return path.join(historyDir(), "index.jsonl");
}

function readIndex(): ConfigHistoryEntry[] {
  try {
    return fs.readFileSync(indexPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConfigHistoryEntry);
  } catch {
    return [];
  }
}

function writeIndex(entries: ConfigHistoryEntry[]): void {
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(indexPath(), body ? body + "\n" : "", { mode: 0o600 });
}

/**
 * Snapshot the current on-disk content of `targetPath` into
 * ~/.ryoko/config-history/ and record the change in index.jsonl and the
 * structured log. Call this immediately BEFORE overwriting `targetPath`.
 *
 * Never throws: a history failure must not block the config write itself
 * (availability over audit); failures are logged loudly instead.
 */
export function recordConfigChange(
  targetPath: string,
  source: string,
  opts?: { operatorAuthenticated?: boolean },
): void {
  try {
    const dir = historyDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is ignored when the directory already exists —
    // re-assert so a loosened directory does not silently stay open.
    fs.chmodSync(dir, 0o700);

    const ts = new Date().toISOString();
    let snapshot: string | null = null;
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(targetPath) || "";
      const base = `${ts.replace(/:/g, "-")}-${source.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      snapshot = `${base}${ext}`;
      for (let n = 1; fs.existsSync(path.join(dir, snapshot)); n++) {
        snapshot = `${base}-${n}${ext}`;
      }
      fs.writeFileSync(path.join(dir, snapshot), fs.readFileSync(targetPath), { mode: 0o600 });
    }

    const entry: ConfigHistoryEntry = {
      ts,
      source,
      file: path.relative(JINN_HOME, targetPath),
      snapshot,
      ...(opts?.operatorAuthenticated !== undefined && { operatorAuthenticated: opts.operatorAuthenticated }),
    };

    const entries = [...readIndex(), entry];
    const dropped = entries.length > CONFIG_HISTORY_LIMIT ? entries.splice(0, entries.length - CONFIG_HISTORY_LIMIT) : [];
    for (const old of dropped) {
      if (!old.snapshot) continue;
      try { fs.unlinkSync(path.join(dir, old.snapshot)); } catch { /* already gone */ }
    }
    writeIndex(entries);

    // Structured, secret-free change record (mirrors the security_event style)
    logger.info(`config_change ${JSON.stringify(entry)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`config-history snapshot failed for ${targetPath} (${source}): ${message}`);
  }
}

/** Newest-first history entries (metadata only — never snapshot contents). */
export function listConfigHistory(limit = CONFIG_HISTORY_LIMIT): ConfigHistoryEntry[] {
  return readIndex().slice(-Math.max(1, limit)).reverse();
}
