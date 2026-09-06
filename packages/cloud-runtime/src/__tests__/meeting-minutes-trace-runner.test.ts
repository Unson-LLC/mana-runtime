import { MEETING_MINUTES_TRACE_RUNNER_SOURCE, parseMeetingMinutesExecutionTrace } from "../meeting-minutes-execution-trace.js";

// Execute the exact source deployed into the container, with only OS entry points replaced.
function harness(upstream: typeof fetch) {
  let time = 0;
  let stderr = "";
  let stdout = "";
  const source = MEETING_MINUTES_TRACE_RUNNER_SOURCE.replace(/^import .*;\n/gm, "");
  const body = source.slice(0, source.lastIndexOf('if (process.argv[1]'));
  const api = new Function("fetch", "process", "performance", `${body}\nreturn {createObservedFetch, createStdoutObserver};`)(
    upstream,
    { stderr: { write: (chunk: string) => { stderr += chunk; } },
      stdout: { write: (chunk: Uint8Array) => { stdout += Buffer.from(chunk).toString(); } } },
    { now: () => time },
  );
  return { api, setTime: (value: number) => { time = value; },
    trace: () => parseMeetingMinutesExecutionTrace(stderr), stdout: () => stdout };
}

describe("deployed diagnostic runner execution", () => {
  it("preserves response bytes and distinguishes last bytes from delayed EOF", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstreamBody = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const h = harness(vi.fn().mockResolvedValue(new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } })));
    h.setTime(10);
    const response = await h.api.createObservedFetch()(new URL("https://api.anthropic.com/v1/messages"), {
      method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 32000,
        thinking: { type: "enabled", budget_tokens: 8192 }, messages: [{ content: "SECRET" }] }),
    });
    const received = response.text();
    h.setTime(20);
    const first = 'data: {"type":"message_start","message":{"usage":{"input_tokens":123}}}\n\n';
    controller.enqueue(new TextEncoder().encode(first));
    await vi.waitFor(() => expect(h.trace()?.events.some(e => e.event === "upstream_response_first_body_chunk")).toBe(true));
    h.setTime(40);
    const last = 'data: {"type":"message_delta","usage":{"output_tokens":456}}\n\ndata: {"type":"message_stop"}\n\n';
    controller.enqueue(new TextEncoder().encode(last));
    await vi.waitFor(() => expect(h.trace()?.events.some(e => e.sseType === "message_stop")).toBe(true));
    h.setTime(100);
    controller.close();
    expect(await received).toBe(first + last);
    const events = h.trace()!.events;
    expect(events.find(e => e.event === "upstream_request_start")).toMatchObject({ maxTokens: 32000, thinkingBudgetTokens: 8192 });
    expect(events.find(e => e.event === "upstream_response_last_body_chunk")?.elapsedMs).toBe(40);
    expect(events.find(e => e.event === "upstream_response_end")).toMatchObject({ elapsedMs: 100,
      usage: { inputTokens: 123, outputTokens: 456 } });
    expect(JSON.stringify(h.trace())).not.toContain("SECRET");
  });

  it("records bounded content counts before EOF without exposing text", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness(vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { controller = c; } }))));
    const response = await h.api.createObservedFetch()(new URL("https://api.anthropic.com/v1/messages"), { method: "POST" });
    const received = response.text();
    h.setTime(1);
    controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n'));
    await vi.waitFor(() => expect(h.trace()?.events.some(e => e.event === "upstream_response_first_body_chunk")).toBe(true));
    h.setTime(11000);
    controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"PRIVATE"}}\n\n'));
    await vi.waitFor(() => expect(h.trace()?.events.some(e => e.event === "upstream_response_progress")).toBe(true));
    expect(h.trace()?.events.find(e => e.event === "upstream_response_progress")).toMatchObject({ thinkingChars: 7 });
    expect(JSON.stringify(h.trace())).not.toContain("PRIVATE");
    controller.close();
    await received;
  });

  it("records an interrupted response and propagates the stream error", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const h = harness(vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { controller = c; } }))));
    const response = await h.api.createObservedFetch()(new URL("https://api.anthropic.com/v1/messages"), { method: "POST" });
    const received = response.text();
    controller.error(new Error("SECRET_NETWORK_DETAIL"));
    await expect(received).rejects.toThrow();
    expect(h.trace()?.events.some(e => e.event === "upstream_response_error")).toBe(true);
    expect(JSON.stringify(h.trace())).not.toContain("SECRET_NETWORK_DETAIL");
  });

  it("forwards exact stdout bytes and emits one safe event per actual newline", () => {
    const h = harness(vi.fn());
    const observer = h.api.createStdoutObserver();
    const data = '{"type":"system","subtype":"init","secret":"PRIVATE"}\n{"type":"result","subtype":"success"}\n';
    observer.chunk(Buffer.from(data.slice(0, 17)));
    observer.chunk(Buffer.from(data.slice(17)));
    observer.finish();
    expect(h.stdout()).toBe(data);
    expect(h.trace()?.events.map(e => e.type)).toEqual(["system", "result"]);
    expect(JSON.stringify(h.trace())).not.toContain("PRIVATE");
  });
});
