#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const HANDLE_PATTERN = /^tb_[A-Za-z0-9_-]{32,128}$/;
const BOUNDARY_HEADER = "x-mana-tenant-boundary-handle";
const LOCAL_AUTH_SENTINEL = "mana-runtime-trusted-forwarder";

function validatedHandle(value) {
  if (typeof value !== "string" || !HANDLE_PATTERN.test(value)) {
    throw new Error("tenant_boundary_required");
  }
  return value;
}

async function requestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

/**
 * Starts a loopback-only adapter for Claude Code. The local sentinel satisfies
 * Claude's client-side auth requirement but is removed before the request
 * leaves the Container. Only the non-secret tenant operation handle crosses
 * the Sandbox interception boundary in its dedicated control header.
 */
export async function startTenantAnthropicProxy({ tenantBoundaryHandle, fetchImpl = fetch }) {
  const handle = validatedHandle(tenantBoundaryHandle);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = incoming.url ?? "/";
      const target = new URL(path, "https://api.anthropic.com");
      if (target.origin !== "https://api.anthropic.com") throw new Error("provider_target_invalid");
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || ["authorization", "x-api-key", "host", "content-length", BOUNDARY_HEADER].includes(name.toLowerCase())) continue;
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      headers.set(BOUNDARY_HEADER, handle);
      const body = await requestBody(incoming);
      const response = await fetchImpl(target, {
        method: incoming.method ?? "GET",
        headers,
        ...(body ? { body } : {}),
        redirect: "manual",
      });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (!["content-length", "transfer-encoding"].includes(name.toLowerCase())) outgoing.setHeader(name, value);
      });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 502;
      outgoing.end("trusted_provider_forward_failed");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("trusted_provider_proxy_unavailable");
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const args = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
  if (args.length === 0) throw new Error("claude_arguments_required");
  const proxy = await startTenantAnthropicProxy({
    tenantBoundaryHandle: process.env.MANA_TENANT_BOUNDARY_HANDLE,
  });
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = proxy.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = LOCAL_AUTH_SENTINEL;
  const child = spawn("/usr/local/bin/claude", args, { env, stdio: "inherit" });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }).finally(proxy.close);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("trusted_provider_runner_failed\n");
    process.exitCode = 1;
  });
}
