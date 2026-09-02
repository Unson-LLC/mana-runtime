import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../container/brainbase-judgment-hook.mjs", import.meta.url));
const receiptPrefix = "__MANA_JUDGMENT_RECEIPT_V1__:";
const verifiedAnswerPrefix = "__MANA_VERIFIED_ANSWER_V1__:";
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
  it("does not run the interactive Hook for receipt-bound meeting-minutes batches", async () => {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-meeting-minutes",
      prompt: "schema-constrained meeting-minutes prompt",
    }, {
      MANA_DISABLE_INTERACTIVE_JUDGMENT_HOOK: "1",
      BRAINBASE_JUDGMENT_HOOK_URL: "http://127.0.0.1:1/must-not-be-called",
    });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

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
          : payload.hook_event_name === "Stop"
            ? {
              schema_version: "brainbase-judgment-final-v1",
              completion_status: "complete",
              answer_digest: createHash("sha256")
                .update(String(payload.last_assistant_message ?? ""))
                .digest("hex"),
            }
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
      const result = await runHook({
        hook_event_name,
        session_id: "session-1",
        ...(hook_event_name === "Stop" ? {
          last_assistant_message: "🧠 判断参照: 「依頼」を参照 → 対応 ✓\n📚 Brainbase検索: search「依頼」→ 該当なし",
        } : {}),
      }, env);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      if (hook_event_name === "PostToolUse") {
        expect(output.systemMessage).toContain("recorded");
      } else if (hook_event_name === "UserPromptSubmit") {
        expect(output).toHaveProperty("hookSpecificOutput");
      } else {
        expect(output).not.toHaveProperty("hookSpecificOutput");
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

  it.each(["UserPromptSubmit", "Stop"])(
    "keeps the %s canonical Host output together with the runtime receipt",
    async (hookEventName) => {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          schema_version: "1", accepted: true, hook_event_name: payload.hook_event_name,
          session_id: payload.session_id, turn_id: payload.turn_id, receipt_id: `receipt-${hookEventName}`,
          ...(payload.hook_event_name === "UserPromptSubmit"
            ? { route_resolution_sha256: "c".repeat(64) }
            : {}),
          output: {
            systemMessage: "監査行の後に元の回答本文を続けてください。",
            ...(payload.hook_event_name === "UserPromptSubmit" ? { hookSpecificOutput: {
              hookEventName: "UserPromptSubmit", additionalContext: "Judgment route resolved",
            } } : {}),
          },
        }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanup.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test_server_missing");
      const stateDir = await mkdtemp(join(tmpdir(), "mana-judgment-hook-"));
      cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
      const env = { BRAINBASE_JUDGMENT_HOOK_URL: `http://127.0.0.1:${address.port}/host/judgment/hook`,
        BRAINBASE_JUDGMENT_TURN_DIR: stateDir };
      if (hookEventName === "Stop") {
        await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-stop" }, env);
      }
      const result = await runHook({ hook_event_name: hookEventName, session_id: "session-stop" }, env);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.systemMessage).toContain(receiptPrefix);
      if (hookEventName === "UserPromptSubmit") {
        expect(output.systemMessage).not.toContain("監査行の後に");
        expect(output.hookSpecificOutput.additionalContext).toContain("Judgment route resolved");
        expect(output.hookSpecificOutput.additionalContext).toContain(receiptPrefix);
      } else {
        expect(output.systemMessage).toContain("監査行の後に");
        expect(output).not.toHaveProperty("hookSpecificOutput");
      }
    },
  );

  it("completes one Host Stop repair when non-interactive Claude returns after the block", async () => {
    const judgmentLine = "🧠 判断参照: 「確認して」を参照 → 運用依頼として対応 ✓";
    const brainbaseLine = "📚 Brainbase検索: Graphで「mana」を検索 → 結果を取得 ✓";
    const repairLine = "🛠️ Stop修復: 最終回答を1回差し戻し → 修復完了 ✓";
    const forwarded: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      forwarded.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true, hook_event_name: payload.hook_event_name,
        session_id: payload.session_id, turn_id: payload.turn_id,
        receipt_id: `receipt-${payload.hook_event_name}`,
        ...(payload.hook_event_name === "UserPromptSubmit"
          ? { route_resolution_sha256: "f".repeat(64) } : {}),
        output: payload.hook_event_name === "UserPromptSubmit" ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit", additionalContext: "Judgment route resolved",
          },
        } : forwarded.filter((entry) => entry.hook_event_name === "Stop").length === 1 ? {
          decision: "block",
          reason: [
            "Brainbase judgment episodeを完了する前に最終回答の先頭に次の監査行をそのまま、この順番で各1回だけ表示する:",
            judgmentLine,
            brainbaseLine,
            repairLine,
            "その後、最初に差し戻された回答の監査行以外の本文を、削除・要約・置換せずそのまま残す",
            "監査行の後に、元の回答本文をそのまま続けてください。",
          ].join("\n"),
        } : {
          systemMessage: [judgmentLine, brainbaseLine, repairLine].join("\n"),
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
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-block" }, env);
    const result = await runHook({
      hook_event_name: "Stop",
      session_id: "session-block",
      stop_hook_active: true,
      last_assistant_message: "本文",
    }, env);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).not.toHaveProperty("decision");
    expect(output.systemMessage.split("\n").slice(0, 3))
      .toEqual([judgmentLine, brainbaseLine, repairLine]);
    expect(output.systemMessage).toContain(receiptPrefix);
    expect(forwarded.filter((entry) => entry.hook_event_name === "Stop")).toHaveLength(2);
    expect(forwarded.filter((entry) => entry.hook_event_name === "Stop")[0]?.stop_hook_active)
      .toBe(false);
    expect(forwarded.at(-1)?.stop_hook_active).toBe(true);
    expect(forwarded.at(-1)?.last_assistant_message)
      .toBe(`${judgmentLine}\n${brainbaseLine}\n${repairLine}\n本文`);
  });

  it("emits Host-verified audit lines after a completed Stop repair", async () => {
    const judgmentLine = "🧠 判断参照: 「確認して」を参照 → 運用依頼として対応 ✓";
    const brainbaseLine = "📚 Brainbase未参照: 今回は検索不要 ✓";
    const verifiedAnswer = `${judgmentLine}\n${brainbaseLine}\n本文`;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true, hook_event_name: payload.hook_event_name,
        session_id: payload.session_id, turn_id: payload.turn_id,
        receipt_id: `receipt-${payload.hook_event_name}`,
        ...(payload.hook_event_name === "UserPromptSubmit"
          ? { route_resolution_sha256: "a".repeat(64) } : {}),
        output: payload.hook_event_name === "UserPromptSubmit" ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit", additionalContext: "Judgment route resolved",
          },
        } : {
          schema_version: "brainbase-judgment-final-v1",
          completion_status: "complete",
          answer_digest: createHash("sha256").update(verifiedAnswer).digest("hex"),
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
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-complete" }, env);
    const result = await runHook({
      hook_event_name: "Stop", session_id: "session-complete",
      last_assistant_message: verifiedAnswer,
    }, env);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    const lines = output.systemMessage.split("\n");
    expect(lines.slice(0, 2)).toEqual([judgmentLine, brainbaseLine]);
    expect(lines[2]).toContain(receiptPrefix);
    const receipt = JSON.parse(lines[2].slice(receiptPrefix.length));
    expect(receipt).toMatchObject({
      schema_version: "mana_judgment_hook_receipt.v1",
      hook_event_name: "Stop",
      session_id: "session-complete",
      host_receipt_id: "receipt-Stop",
    });
    expect(receipt.turn_id).toBeTruthy();
    expect(lines[3]).toContain(verifiedAnswerPrefix);
    expect(JSON.parse(lines[3].slice(verifiedAnswerPrefix.length))).toEqual({
      answer: verifiedAnswer,
      answer_digest: createHash("sha256").update(verifiedAnswer).digest("hex"),
    });
  });

  it("binds the canonical remote Host completion surface to the verified answer", async () => {
    const judgmentLine = "🧠 判断参照: 「確認して」を参照 → 質問として回答 ✓";
    const brainbaseLine = "📚 Brainbase検索: Graphで「mana」を検索 → 結果を取得 ✓";
    const verifiedAnswer = `${judgmentLine}\n${brainbaseLine}\n回答本文`;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true, hook_event_name: payload.hook_event_name,
        session_id: payload.session_id, turn_id: payload.turn_id,
        ...(payload.hook_event_name === "UserPromptSubmit" ? {
          receipt_id: "receipt-remote-complete",
          route_resolution_sha256: "9".repeat(64),
        } : {}),
        // The production Brainbase HTTP adapter intentionally projects only
        // the canonical completed audit surface for Stop. The final receipt is
        // persisted by the Host and is not copied into this transport envelope.
        output: payload.hook_event_name === "UserPromptSubmit" ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit", additionalContext: "Judgment route resolved",
          },
        } : {
          systemMessage: `${judgmentLine}\n${brainbaseLine}`,
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
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-remote-complete" }, env);
    const result = await runHook({
      hook_event_name: "Stop", session_id: "session-remote-complete",
      last_assistant_message: verifiedAnswer,
    }, env);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    const marker = output.systemMessage.split("\n")
      .find((line: string) => line.startsWith(verifiedAnswerPrefix));
    expect(marker).toBeTruthy();
    expect(JSON.parse(marker.slice(verifiedAnswerPrefix.length))).toEqual({
      answer: verifiedAnswer,
      answer_digest: createHash("sha256").update(verifiedAnswer).digest("hex"),
    });
  });

  it("binds a non-blocking Host acceptance to audit lines in the exact submitted answer", async () => {
    const judgmentLine = "🧠 判断参照: 「確認して」を参照 → 質問として回答 ✓";
    const brainbaseLine = "📚 Brainbase検索: Graphで「mana」を検索 → 結果を取得 ✓";
    const verifiedAnswer = `${judgmentLine}\n${brainbaseLine}\n回答本文`;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "1", accepted: true, hook_event_name: payload.hook_event_name,
        session_id: payload.session_id, turn_id: payload.turn_id,
        ...(payload.hook_event_name === "UserPromptSubmit" ? {
          receipt_id: "receipt-answer-bound-complete",
          route_resolution_sha256: "8".repeat(64),
        } : {}),
        output: payload.hook_event_name === "UserPromptSubmit" ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit", additionalContext: "Judgment route resolved",
          },
        } : {
          systemMessage: "Host accepted the completed judgment episode",
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
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "session-answer-bound" }, env);
    const result = await runHook({
      hook_event_name: "Stop", session_id: "session-answer-bound",
      last_assistant_message: verifiedAnswer,
    }, env);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    const lines = output.systemMessage.split("\n");
    expect(lines.slice(0, 2)).toEqual([judgmentLine, brainbaseLine]);
    const marker = lines.find((line: string) => line.startsWith(verifiedAnswerPrefix));
    expect(marker).toBeTruthy();
    expect(JSON.parse(marker.slice(verifiedAnswerPrefix.length))).toEqual({
      answer: verifiedAnswer,
      answer_digest: createHash("sha256").update(verifiedAnswer).digest("hex"),
    });
  });

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
  }, 15_000);

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

  it.each([
    "brainbase_judgment_state_record",
    "mcp__brainbase__brainbase_judgment_state_record",
  ])("accepts an empty Host output for the internal state tool %s", async (toolName) => {
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
          receipt_id: "receipt-state-tool",
          route_resolution_sha256: "f".repeat(64),
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

    expect((await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: `session-${toolName}`,
    }, env)).code).toBe(0);
    const result = await runHook({
      hook_event_name: "PostToolUse",
      session_id: `session-${toolName}`,
      tool_name: toolName,
    }, env);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toContain(receiptPrefix);
    expect(output.systemMessage).not.toContain("Brainbase tool use recorded");
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
