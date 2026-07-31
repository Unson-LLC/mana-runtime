import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// vi.mock factory is hoisted — cannot reference local variables.
// Use a fixed path that the mock can resolve at hoist time.
vi.mock("../paths.js", () => {
  const home = path.join(import.meta.dirname || __dirname, ".tmp-config-history-test");
  return {
    JINN_HOME: home,
    LOGS_DIR: path.join(home, "logs"),
  };
});

import {
  recordConfigChange,
  listConfigHistory,
  CONFIG_HISTORY_LIMIT,
} from "../config-history.js";

const HOME = path.join(import.meta.dirname || __dirname, ".tmp-config-history-test");
const HISTORY_DIR = path.join(HOME, "config-history");
const CONFIG = path.join(HOME, "config.yaml");

beforeEach(() => {
  fs.mkdirSync(HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("recordConfigChange", () => {
  it("snapshots the pre-write file content and indexes the change", () => {
    fs.writeFileSync(CONFIG, "portal:\n  portalName: before\n");
    recordConfigChange(CONFIG, "api/config", { operatorAuthenticated: true });

    const entries = listConfigHistory();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.source).toBe("api/config");
    expect(entry.file).toBe("config.yaml");
    expect(entry.operatorAuthenticated).toBe(true);
    expect(entry.snapshot).toMatch(/api-config\.yaml$/);

    // Snapshot holds the PRE-write content verbatim
    const snapshotPath = path.join(HISTORY_DIR, entry.snapshot!);
    expect(fs.readFileSync(snapshotPath, "utf-8")).toBe("portal:\n  portalName: before\n");
  });

  it("records snapshot=null when the target file does not exist yet", () => {
    recordConfigChange(CONFIG, "api/onboarding", { operatorAuthenticated: false });
    const [entry] = listConfigHistory();
    expect(entry.snapshot).toBeNull();
    expect(entry.operatorAuthenticated).toBe(false);
  });

  it("omits operatorAuthenticated for non-API sources", () => {
    fs.writeFileSync(CONFIG, "a: 1\n");
    recordConfigChange(CONFIG, "cron/scheduler");
    const [entry] = listConfigHistory();
    expect("operatorAuthenticated" in entry).toBe(false);
  });

  it("restricts permissions: directory 0700, snapshots 0600", () => {
    fs.writeFileSync(CONFIG, "a: 1\n");
    recordConfigChange(CONFIG, "api/config", { operatorAuthenticated: true });
    const [entry] = listConfigHistory();
    expect(fs.statSync(HISTORY_DIR).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(HISTORY_DIR, entry.snapshot!)).mode & 0o777).toBe(0o600);
  });

  it("re-tightens a loosened history directory on the next write", () => {
    fs.writeFileSync(CONFIG, "a: 1\n");
    recordConfigChange(CONFIG, "api/config");
    fs.chmodSync(HISTORY_DIR, 0o755);
    recordConfigChange(CONFIG, "api/config");
    expect(fs.statSync(HISTORY_DIR).mode & 0o777).toBe(0o700);
  });

  it(`rotates: keeps only the latest ${CONFIG_HISTORY_LIMIT} entries and deletes dropped snapshot files`, () => {
    for (let i = 0; i < CONFIG_HISTORY_LIMIT + 5; i++) {
      fs.writeFileSync(CONFIG, `revision: ${i}\n`);
      recordConfigChange(CONFIG, "api/config");
    }
    const entries = listConfigHistory(CONFIG_HISTORY_LIMIT + 50);
    expect(entries).toHaveLength(CONFIG_HISTORY_LIMIT);

    // Oldest snapshot (revision 0..4 pre-images) removed from disk; only
    // referenced snapshots remain alongside index.jsonl.
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f !== "index.jsonl");
    expect(files).toHaveLength(CONFIG_HISTORY_LIMIT);
    const referenced = new Set(entries.map((e) => e.snapshot));
    for (const f of files) expect(referenced.has(f)).toBe(true);
  });

  it("disambiguates same-timestamp snapshots instead of overwriting", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
      fs.writeFileSync(CONFIG, "first\n");
      recordConfigChange(CONFIG, "api/config");
      fs.writeFileSync(CONFIG, "second\n");
      recordConfigChange(CONFIG, "api/config");
    } finally {
      vi.useRealTimers();
    }
    const [newer, older] = listConfigHistory();
    expect(newer.snapshot).not.toBe(older.snapshot);
    expect(fs.readFileSync(path.join(HISTORY_DIR, older.snapshot!), "utf-8")).toBe("first\n");
    expect(fs.readFileSync(path.join(HISTORY_DIR, newer.snapshot!), "utf-8")).toBe("second\n");
  });

  it("never throws when the history directory is not writable", () => {
    fs.writeFileSync(CONFIG, "a: 1\n");
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.chmodSync(HISTORY_DIR, 0o500);
    try {
      expect(() => recordConfigChange(CONFIG, "api/config")).not.toThrow();
    } finally {
      fs.chmodSync(HISTORY_DIR, 0o700);
    }
  });
});

describe("listConfigHistory", () => {
  it("returns entries newest-first and honors the limit", () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(CONFIG, `revision: ${i}\n`);
      recordConfigChange(CONFIG, `api/source-${i}`);
    }
    const entries = listConfigHistory(3);
    expect(entries).toHaveLength(3);
    expect(entries[0].source).toBe("api/source-4");
    expect(entries[2].source).toBe("api/source-2");
  });

  it("returns metadata only — no config contents in the payload", () => {
    fs.writeFileSync(CONFIG, "connectors:\n  slack:\n    botToken: xoxb-super-secret\n");
    recordConfigChange(CONFIG, "api/config", { operatorAuthenticated: true });
    const serialized = JSON.stringify(listConfigHistory());
    expect(serialized).not.toContain("xoxb-super-secret");
  });

  it("returns [] when no history exists", () => {
    expect(listConfigHistory()).toEqual([]);
  });
});
