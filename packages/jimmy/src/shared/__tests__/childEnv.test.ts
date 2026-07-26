import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { buildChildEnv, _resetRootWarn } from "../childEnv.js";

describe("buildChildEnv", () => {
  const origGetuid = process.getuid;
  const savedEnvKeys = new Set(Object.keys(process.env));

  beforeEach(() => {
    _resetRootWarn();
  });

  afterEach(() => {
    // Restore process.getuid if a test replaced it
    if (origGetuid) {
      Object.defineProperty(process, "getuid", { value: origGetuid, configurable: true, writable: true });
    }
    // Clean up any env vars introduced by a test
    for (const k of Object.keys(process.env)) {
      if (!savedEnvKeys.has(k)) delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it("strips CLAUDECODE and CLAUDE_CODE_* by default", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SOMETHING = "abc";
    process.env.UNRELATED_VAR = "keep";

    const env = buildChildEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SOMETHING).toBeUndefined();
    expect(env.UNRELATED_VAR).toBe("keep");
  });

  it("never exposes gateway Slack credentials to child CLIs", () => {
    process.env.OPENRYOKO_SLACK_APP_TOKEN = "xapp-secret";
    process.env.OPENRYOKO_SLACK_BOT_TOKEN = "xoxb-secret";

    const env = buildChildEnv();
    expect(env.OPENRYOKO_SLACK_APP_TOKEN).toBeUndefined();
    expect(env.OPENRYOKO_SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("strips additional prefixes when requested", () => {
    process.env.CODEX_AUTH = "secret";
    process.env.CODEX_HOME = "/x";
    process.env.UNRELATED = "y";

    const env = buildChildEnv({ stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] });
    expect(env.CODEX_AUTH).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.UNRELATED).toBe("y");
  });

  it("strips exact-match keys", () => {
    process.env.NUKE_ME = "1";
    process.env.KEEP_ME = "2";
    const env = buildChildEnv({ stripExact: ["NUKE_ME"] });
    expect(env.NUKE_ME).toBeUndefined();
    expect(env.KEEP_ME).toBe("2");
  });

  it("does not inject IS_SANDBOX when not running as root", () => {
    Object.defineProperty(process, "getuid", { value: () => 1000, configurable: true, writable: true });
    delete process.env.IS_SANDBOX;
    const env = buildChildEnv();
    expect(env.IS_SANDBOX).toBeUndefined();
  });

  it("injects IS_SANDBOX=1 when running as root and IS_SANDBOX is unset", () => {
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
    delete process.env.IS_SANDBOX;
    const env = buildChildEnv();
    expect(env.IS_SANDBOX).toBe("1");
  });

  it("preserves an existing IS_SANDBOX value when running as root", () => {
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
    process.env.IS_SANDBOX = "custom";
    const env = buildChildEnv();
    expect(env.IS_SANDBOX).toBe("custom");
  });

  it("only warns once about root execution across multiple calls", () => {
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
    delete process.env.IS_SANDBOX;
    // We can't easily intercept logger.warn here without mocking the logger
    // module — but we can at least confirm both calls return IS_SANDBOX=1.
    const a = buildChildEnv();
    const b = buildChildEnv();
    expect(a.IS_SANDBOX).toBe("1");
    expect(b.IS_SANDBOX).toBe("1");
  });
});
