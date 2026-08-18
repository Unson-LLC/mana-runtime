import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../container/brainbase-judgment-hook.mjs", import.meta.url));
const receiptPrefix = "__MANA_JUDGMENT_RECEIPT_V1__:";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

function runHook(payload: Record<string, unknown>, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Brainbase judgment Hook forwarder", () => {
  it("routes a Slack reply from the trusted user request instead of model scaffolding", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      forwarded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true,
        hook_event_name: forwarded?.hook_event_name, session_id: forwarded?.session_id,
        turn_id: forwarded?.turn_id, receipt_id: "receipt-trusted-request",
        route_resolution_sha256: "b".repeat(64),
        output: {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "Judgment route resolved",
          },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));

    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-trusted-request",
      prompt: "内部指示: 私の判断基準を使う\n依頼: 現在の実行経路を確認して",
    }, {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
      MANA_JUDGMENT_REQUEST: "現在の実行経路を確認して",
    });

    expect(result.code).toBe(0);
    expect(forwarded?.prompt).toBe("現在の実行経路を確認して");
  });

  it("story-meeting-minutes-brainbase-judgment:ac:4 preserves one turn identity across UserPromptSubmit, PostToolUse, and Stop", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      payloads.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true,
        hook_event_name: payload.hook_event_name, session_id: payload.session_id,
        turn_id: payload.turn_id, receipt_id: `receipt-${payload.hook_event_name}`,
        ...(payload.hook_event_name === "UserPromptSubmit"
          ? { route_resolution_sha256: "a".repeat(64) }
          : {}),
        output: payload.hook_event_name === "PostToolUse"
          ? { systemMessage: "Brainbase tool use recorded" }
          : {
              hookSpecificOutput: {
                hookEventName: payload.hook_event_name,
                ...(payload.hook_event_name === "UserPromptSubmit"
                  ? { additionalContext: "Judgment route resolved" }
                  : {}),
              },
            },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const env = {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    };
    for (const hook_event_name of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      const result = await runHook({ hook_event_name, session_id: "session-1" }, env);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      if (hook_event_name === "PostToolUse") {
        expect(output.systemMessage).toContain("recorded");
      } else {
        expect(output).toHaveProperty("hookSpecificOutput");
      }
      expect(output).not.toHaveProperty("manaJudgmentReceipt");
      const receiptLine = output.systemMessage.split("\n")
        .find((line: string) => line.startsWith(receiptPrefix));
      expect(receiptLine).toBeTruthy();
      const embeddedReceipt = JSON.parse(receiptLine.slice(receiptPrefix.length));
      expect(embeddedReceipt).toMatchObject({
        schema_version: "mana_judgment_hook_receipt.v1",
        hook_event_name,
        session_id: "session-1",
        host_receipt_id: `receipt-${hook_event_name}`,
      });
      expect(embeddedReceipt.turn_id).toBeTruthy();
      if (hook_event_name === "UserPromptSubmit") {
        expect(embeddedReceipt.route_resolution_sha256).toBe("a".repeat(64));
      }
    }
    expect(new Set(payloads.map((payload) => payload.turn_id)).size).toBe(1);
  }, 15_000);

  it("story-meeting-minutes-brainbase-judgment:ac:3 fails closed when the Brainbase Hook endpoint is unavailable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const result = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-2" }, {
      BRAINBASE_JUDGMENT_HOOK_URL: "http://127.0.0.1:1/host/judgment/hook",
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBeTruthy();
  });

  it.each([
    {},
    { schema_version: "1", accepted: true, hook_event_name: "Stop", session_id: "session-3", turn_id: "wrong", output: {} },
  ])("fails closed for an unbound 200 response", async (body) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const result = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-3" }, {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("judgment_hook_response_invalid");
  });

  it("rejects oversized stdin before calling Brainbase", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-4", padding: "x".repeat(1024 * 1024),
    }, { BRAINBASE_JUDGMENT_TURN_DIR: stateDir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("judgment_hook_payload_too_large");
  });

  it("fails closed when a bound PostToolUse response lacks an audit receipt", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true,
        hook_event_name: payload.hook_event_name, session_id: payload.session_id,
        turn_id: payload.turn_id,
        ...(payload.hook_event_name === "UserPromptSubmit" ? {
          receipt_id: "receipt-session-5",
          route_resolution_sha256: "d".repeat(64),
        } : {}),
        output: payload.hook_event_name === "UserPromptSubmit"
          ? {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "Judgment route resolved",
              },
            }
          : {},
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const env = {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    };
    const submitted = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-5" }, env);
    expect(submitted.code).toBe(0);
    const result = await runHook({ hook_event_name: "PostToolUse", session_id: "session-5" }, env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("judgment_hook_audit_not_recorded");
  });

  it("fails closed when UserPromptSubmit lacks a Host route receipt", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1",
        accepted: true,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-route-1",
        turn_id: payload.turn_id,
        route_resolution_sha256: "e".repeat(64),
        output: {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "Judgment route resolved",
          },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const missingReceipt = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-route-1" }, {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    });
    expect(missingReceipt.code).toBe(2);
    expect(missingReceipt.stderr).toContain("judgment_hook_route_receipt_missing");
  });

  it("fails closed when UserPromptSubmit has an invalid Host route digest", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1",
        accepted: true,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-route-digest",
        turn_id: payload.turn_id,
        receipt_id: "receipt-route-digest",
        route_resolution_sha256: "not-a-digest",
        output: {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "Judgment route resolved",
          },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-route-digest",
    }, {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("judgment_hook_route_receipt_missing");
  });

  it("reports a bounded upstream error code without echoing arbitrary response content", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: "judgment_hook_unavailable",
        detail: "Bearer secret-must-not-escape",
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server_missing");
    const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));

    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-upstream-error",
    }, {
      BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
      BRAINBASE_JUDGMENT_TURN_DIR: stateDir,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("judgment_hook_http_503_judgment_hook_unavailable");
    expect(result.stderr).not.toContain("secret-must-not-escape");
  });
});
