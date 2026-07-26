import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseDevelopmentResult, runDevelopmentRequest } from "../development-runner.js";
// The production runner is intentionally plain ESM so it can be installed as a standalone script.
// @ts-expect-error no TypeScript declaration is shipped for the standalone runner.
import { runCommand } from "../../../../../scripts/development-runner/run.mjs";

function childReturning(stdout: string, code = 0) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

describe("development runner", () => {
  it("passes the request over stdin and strips the gateway environment", async () => {
    process.env.SLACK_BOT_TOKEN = "must-not-leak";
    let options: any;
    let stdin = "";
    const spawnFn = vi.fn((_bin, _args, receivedOptions) => {
      options = receivedOptions;
      const child = childReturning('{"status":"pr_ready","storyId":"story-safe-change","prUrl":"https://github.com/Unson-LLC/brainbase-mana/pull/3","summary":"ready"}');
      child.stdin.on("data", (chunk: Buffer) => { stdin += chunk.toString(); });
      return child;
    }) as any;

    const result = await runDevelopmentRequest(
      { enabled: true, bin: "/usr/bin/sudo", args: ["-n", "-u", "ryoko-dev", "/opt/bin/run"] },
      "READMEを改善する",
      spawnFn,
    );

    expect(result.status).toBe("pr_ready");
    expect(JSON.parse(stdin)).toEqual({ request: "READMEを改善する" });
    expect(options.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(options.env).toEqual(expect.objectContaining({ PATH: expect.any(String), LANG: expect.any(String) }));
  });

  it("rejects arbitrary URLs and extra output fields", () => {
    expect(() => parseDevelopmentResult('{"status":"pr_ready","prUrl":"https://evil.example/pr/1","summary":"x"}')).toThrow("invalid PR URL");
    expect(() => parseDevelopmentResult('{"status":"failed","summary":"x","secret":"value"}')).toThrow("unsupported field");
  });

  it("enforces status-dependent result fields", () => {
    expect(() => parseDevelopmentResult('{"status":"pr_ready","summary":"x"}')).toThrow("without a story id");
    expect(() => parseDevelopmentResult('{"status":"queued","storyId":"story-x","prUrl":"https://github.com/Unson-LLC/brainbase-mana/pull/3","summary":"x"}')).toThrow("PR URL for queued");
    expect(parseDevelopmentResult('{"status":"failed","summary":"stopped"}')).toEqual({
      status: "failed",
      summary: "stopped",
    });
  });

  it("waits for process close after timing out", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const promise = runDevelopmentRequest(
        { enabled: true, bin: "/usr/bin/sudo", timeoutMs: 10 },
        "x",
        vi.fn(() => child) as any,
      );
      let settled = false;
      void promise.catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(settled).toBe(false);

      child.emit("close", null);
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await expect(promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires an absolute executable path", async () => {
    await expect(runDevelopmentRequest({ enabled: true, bin: "sudo" }, "x")).rejects.toThrow("must be absolute");
  });

  it("rejects oversized requests before spawning", async () => {
    const spawnFn = vi.fn() as any;
    await expect(runDevelopmentRequest({ enabled: true, bin: "/usr/bin/sudo" }, "x".repeat(8001), spawnFn))
      .rejects.toThrow("too large");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("waits for an oversized runner subprocess to close", async () => {
    const promise = runCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(1024)); setInterval(()=>{},1000)",
    ], { maxOutputBytes: 16, terminationGraceMs: 10 });

    await expect(promise).rejects.toThrow("command output exceeded limit");
  });

  it("escalates the process group after its leader exits", async () => {
    const promise = runCommand(process.execPath, [
      "-e",
      [
        "const {spawn}=require('node:child_process')",
        "spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:'ignore'})",
        "process.stdout.write('x'.repeat(1024))",
        "process.on('SIGTERM',()=>process.exit(0))",
        "setInterval(()=>{},1000)",
      ].join(";"),
    ], { maxOutputBytes: 16, terminationGraceMs: 25 });

    await expect(promise).rejects.toThrow("command output exceeded limit");
  });
});
