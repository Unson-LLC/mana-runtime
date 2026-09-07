import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";

import { startTenantAnthropicProxy } from "../../container/tenant-claude-runner.mjs";

const closers: Array<() => Promise<void>> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 750): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("test_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("tenant Claude provider control channel", () => {
  it("keeps the tenant handle out of provider auth while forwarding through the dedicated header", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(request.headers.get("x-mana-tenant-boundary-handle")).toBe("tb_opaque_operation_handle_1234567890");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-api-key")).toBeNull();
      return Response.json({ id: "msg-a" });
    }) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer mana-runtime-trusted-forwarder",
        "x-api-key": "mana-runtime-trusted-forwarder",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "msg-a" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["", "mana-tenant-boundary-v1:tb_opaque_operation_handle_1234567890", "contains space"])(
    "rejects a missing or provider-marker-shaped control handle: %s",
    async (tenantBoundaryHandle) => {
      await expect(startTenantAnthropicProxy({
        tenantBoundaryHandle,
        fetchImpl: vi.fn() as typeof fetch,
      })).rejects.toThrow("tenant_boundary_required");
    },
  );

  it("flushes response headers and forwards the first chunk before the provider finishes", async () => {
    const providerRelease = deferred();
    const encoder = new TextEncoder();
    const upstream = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first-chunk"));
        void providerRelease.promise.then(() => {
          controller.enqueue(encoder.encode("last-chunk"));
          controller.close();
        });
      },
    }), { headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });
    closers.push(proxy.close);

    try {
      const response = await withTimeout(fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        body: "{}",
      }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await expect(withTimeout(reader.read())).resolves.toMatchObject({
        value: new TextEncoder().encode("first-chunk"),
        done: false,
      });

      providerRelease.resolve();
      const remainder = await withTimeout(reader.read());
      expect(new TextDecoder().decode(remainder.value)).toBe("last-chunk");
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      providerRelease.resolve();
    }
  });

  it("terminates a response when the provider body fails after headers were sent", async () => {
    const providerFailure = deferred();
    const clientFirstChunk = deferred();
    const encoder = new TextEncoder();
    const upstream = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("partial-response"));
        void providerFailure.promise.then(() => controller.error(new Error("provider_body_failed")));
      },
    }))) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });
    closers.push(proxy.close);

    const clientBody: Buffer[] = [];
    const clientFinished = new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${proxy.baseUrl}/v1/messages`, { method: "POST" }, (response) => {
        expect(response.statusCode).toBe(200);
        response.on("data", (chunk: Buffer) => {
          clientBody.push(chunk);
          clientFirstChunk.resolve();
        });
        response.on("end", resolve);
        response.on("close", resolve);
        response.on("error", resolve);
      });
      request.once("error", reject);
      request.end("{}");
    });

    await withTimeout(clientFirstChunk.promise);
    providerFailure.resolve();
    await withTimeout(clientFinished);
    expect(Buffer.concat(clientBody).toString()).toBe("partial-response");
  });

  it("aborts the provider fetch and body when the client disconnects", async () => {
    const providerBodyCanceled = deferred();
    let providerSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("chunk-before-disconnect"));
        },
        cancel() {
          providerBodyCanceled.resolve();
        },
      }));
    }) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });
    closers.push(proxy.close);

    const clientDisconnected = new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
        response.resume();
      });
      request.once("error", (error) => {
        if (!request.destroyed) reject(error);
      });
      request.end("{}");
    });

    await withTimeout(clientDisconnected);
    await withTimeout(providerBodyCanceled.promise);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("does not wait for an unresolved provider fetch when the proxy closes", async () => {
    const providerStarted = deferred();
    let providerSignal: AbortSignal | undefined;
    const upstream = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal;
      providerStarted.resolve();
      return new Promise<Response>(() => {}) as Promise<Response>;
    }) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });

    const requestPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      body: "{}",
    }).catch((error: unknown) => error);
    await withTimeout(providerStarted.promise);

    await withTimeout(proxy.close());
    expect(providerSignal?.aborted).toBe(true);
    await withTimeout(requestPromise);
  });
});
