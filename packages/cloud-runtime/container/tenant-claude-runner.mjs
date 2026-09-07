#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("request_aborted");
}

async function requestBody(request, signal) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) {
    if (signal.aborted) throw abortError(signal);
    chunks.push(Buffer.from(chunk));
  }
  if (signal.aborted) throw abortError(signal);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function awaitWithAbort(value, signal, onLateValue) {
  if (signal.aborted) {
    void Promise.resolve(value).then(onLateValue, () => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
    };
    const settle = (callback) => {
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        if (signal.aborted) void onLateValue?.(result);
        settle(() => resolve(result));
      },
      (error) => settle(() => reject(error)),
    );
  });
}

function cancelResponseBody(body, reason) {
  if (!body || typeof body.cancel !== "function") return;
  try {
    const cancellation = body.cancel(reason);
    if (cancellation && typeof cancellation.catch === "function") void cancellation.catch(() => {});
  } catch {
    // The body may already be locked by Readable.fromWeb or have been closed.
  }
}

/**
 * Starts a loopback-only adapter for Claude Code. The local sentinel satisfies
 * Claude's client-side auth requirement but is removed before the request
 * leaves the Container. Only the non-secret tenant operation handle crosses
 * the Sandbox interception boundary in its dedicated control header.
 */
export async function startTenantAnthropicProxy({ tenantBoundaryHandle, fetchImpl = fetch }) {
  const handle = validatedHandle(tenantBoundaryHandle);
  const activeRequests = new Set();
  let closing = false;
  let closePromise;
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    let responseBody;
    let responseFinished = false;
    const abortRequest = (reason = new Error("provider_request_aborted")) => {
      if (!controller.signal.aborted) controller.abort(reason);
      cancelResponseBody(responseBody, controller.signal.reason);
    };
    const activeRequest = {
      cancel: () => {
        abortRequest(new Error("provider_proxy_closed"));
        if (!incoming.destroyed) incoming.destroy();
        if (!outgoing.destroyed) outgoing.destroy();
      },
    };
    activeRequests.add(activeRequest);
    const onIncomingAborted = () => abortRequest(new Error("provider_request_aborted"));
    const onIncomingClose = () => {
      if (!incoming.complete) onIncomingAborted();
    };
    const onOutgoingClose = () => {
      if (!responseFinished && !outgoing.writableFinished && !closing) onIncomingAborted();
    };
    incoming.once("aborted", onIncomingAborted);
    incoming.once("close", onIncomingClose);
    outgoing.once("close", onOutgoingClose);
    try {
      if (closing) throw new Error("provider_proxy_closed");
      const path = incoming.url ?? "/";
      const target = new URL(path, "https://api.anthropic.com");
      if (target.origin !== "https://api.anthropic.com") throw new Error("provider_target_invalid");
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || ["authorization", "x-api-key", "host", "content-length", BOUNDARY_HEADER].includes(name.toLowerCase())) continue;
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      headers.set(BOUNDARY_HEADER, handle);
      const body = await requestBody(incoming, controller.signal);
      const response = await awaitWithAbort(fetchImpl(target, {
        method: incoming.method ?? "GET",
        headers,
        ...(body ? { body } : {}),
        redirect: "manual",
        signal: controller.signal,
      }), controller.signal, (lateResponse) => cancelResponseBody(lateResponse?.body, controller.signal.reason));
      responseBody = response.body;
      if (controller.signal.aborted) throw abortError(controller.signal);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (!["content-length", "transfer-encoding"].includes(name.toLowerCase())) outgoing.setHeader(name, value);
      });
      outgoing.flushHeaders();
      if (!responseBody) {
        outgoing.end();
      } else {
        await pipeline(Readable.fromWeb(responseBody), outgoing, { signal: controller.signal });
      }
      responseFinished = true;
    } catch {
      if (!controller.signal.aborted && !closing && !outgoing.destroyed) {
        if (outgoing.headersSent) {
          if (!outgoing.writableEnded) outgoing.destroy();
        } else {
          outgoing.statusCode = 502;
          outgoing.end("trusted_provider_forward_failed");
        }
      } else if (!outgoing.destroyed && !outgoing.writableEnded) {
        outgoing.destroy();
      }
    } finally {
      responseFinished = true;
      incoming.removeListener("aborted", onIncomingAborted);
      incoming.removeListener("close", onIncomingClose);
      outgoing.removeListener("close", onOutgoingClose);
      activeRequests.delete(activeRequest);
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
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      for (const activeRequest of activeRequests) activeRequest.cancel();
      closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
      return closePromise;
    },
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
