#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import http from "node:http";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const PORT = Number(process.env.DEVELOPMENT_BRIDGE_PORT ?? "31016");
const JOB_DIR = process.env.DEVELOPMENT_BRIDGE_JOB_DIR ?? "/srv/openryoko-development/bridge-jobs";
const RUNNER_COMMAND = JSON.parse(process.env.DEVELOPMENT_BRIDGE_RUNNER_COMMAND ?? "[]");
const SUBMIT_TOKEN = process.env.DEVELOPMENT_BRIDGE_SUBMIT_TOKEN ?? "";
const CALLBACK_TOKEN = process.env.DEVELOPMENT_BRIDGE_CALLBACK_TOKEN ?? "";
const CALLBACK_ORIGIN = process.env.DEVELOPMENT_BRIDGE_CALLBACK_ORIGIN ?? "";

function equalSecret(value, expected) {
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function validString(value, max = 8000) { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function validateRequest(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["request", "placement_id", "requester_id", "event_id", "workspace_id", "channel_id", "thread_ts", "callback_url"]) {
    if (!validString(value[key], key === "request" ? 8000 : 512)) return undefined;
  }
  try {
    const callback = new URL(value.callback_url);
    const allowed = new URL(CALLBACK_ORIGIN);
    if (callback.protocol !== "https:" || callback.origin !== allowed.origin || callback.pathname !== "/development/callback" || callback.search || callback.hash) return undefined;
  } catch { return undefined; }
  return value;
}
function jobIdFor(value) { return `dev_${createHash("sha256").update(`${value.workspace_id}:${value.event_id}`).digest("hex").slice(0, 32)}`; }
async function readJson(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY_BYTES) throw new Error("body_too_large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function runnerResult(stdout) {
  const value = JSON.parse(stdout.trim());
  if (!value || !["completed", "needs_decision", "needs_input", "failed"].includes(value.status) || !validString(value.summary, 12000)) throw new Error("runner_result_invalid");
  return value;
}
async function notify(callbackUrl, payload) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, { method: "POST", headers: { authorization: `Bearer ${CALLBACK_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      if (response.ok) return;
      lastError = new Error(`callback_status_${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
  }
  throw lastError ?? new Error("callback_failed");
}
async function runJob(jobId, request) {
  const base = { job_id: jobId, event_id: request.event_id, placement_id: request.placement_id,
    workspace_id: request.workspace_id, channel_id: request.channel_id, thread_ts: request.thread_ts,
    requester_id: request.requester_id };
  let result;
  try {
    const [command, ...args] = RUNNER_COMMAND;
    if (!command) throw new Error("runner_not_configured");
    result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: "/", env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      const chunks = []; let bytes = 0; let stderr = "";
      child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM"); else chunks.push(chunk); });
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(runnerResult(Buffer.concat(chunks).toString("utf8"))) : reject(new Error(`runner_exit_${code}:${stderr.slice(-300)}`)));
      child.stdin.end(`${JSON.stringify({ request: request.request.trim() })}\n`);
    });
  } catch { result = { status: "failed", summary: "開発runnerの実行に失敗しました。運用ログを確認してください。" }; }
  const payload = { ...base, status: result.status, summary: result.summary,
    ...(result.storyId ? { story_id: result.storyId } : {}), ...(result.prUrl ? { pr_url: result.prUrl } : {}) };
  await writeFile(`${JOB_DIR}/${jobId}.result.json`, JSON.stringify(payload), { mode: 0o600 });
  await notify(request.callback_url, payload);
}

await mkdir(JOB_DIR, { recursive: true, mode: 0o700 });
if (!SUBMIT_TOKEN || !CALLBACK_TOKEN || !CALLBACK_ORIGIN || !Array.isArray(RUNNER_COMMAND) || RUNNER_COMMAND.length === 0) throw new Error("development_bridge_not_configured");
http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/run") { res.writeHead(404).end(); return; }
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!equalSecret(bearer, SUBMIT_TOKEN)) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" })); return; }
  try {
    const request = validateRequest(await readJson(req));
    if (!request) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_request" })); return; }
    const jobId = jobIdFor(request);
    try { const file = await open(`${JOB_DIR}/${jobId}.json`, "wx", 0o600); await file.writeFile(JSON.stringify(request)); await file.close(); }
    catch (error) { if (error?.code !== "EEXIST") throw error; res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ status: "accepted", job_id: jobId })); return; }
    res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ status: "accepted", job_id: jobId }));
    void runJob(jobId, request).catch((error) => console.error(JSON.stringify({ event: "development_bridge_job_failed", jobId, error: error instanceof Error ? error.message : "unexpected_error" })));
  } catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_request" })); }
}).listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ event: "development_bridge_started", port: PORT })));
