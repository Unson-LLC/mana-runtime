import { describe, expect, it } from "vitest";
import {
  MEETING_MINUTES_TRACE_MAX_EVENTS,
  MEETING_MINUTES_TRACE_PREFIX,
  MEETING_MINUTES_TRACE_RUNNER_PATH,
  MEETING_MINUTES_TRACE_RUNNER_SOURCE,
  parseMeetingMinutesExecutionTrace,
  sanitizeMeetingMinutesExecutionTrace,
} from "../meeting-minutes-execution-trace.js";

function traceLine(value: Record<string, unknown>): string {
  return MEETING_MINUTES_TRACE_PREFIX + JSON.stringify(value);
}

describe("meeting-minutes execution trace", () => {
  it("keeps the tenant runner contract and forwards stdout while observing through TransformStream", () => {
    expect(MEETING_MINUTES_TRACE_RUNNER_PATH).toBe("/tmp/meeting-minutes-trace-runner.mjs");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("startTenantAnthropicProxy");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("pipeThrough(new TransformStream");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("upstream_response_progress");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("PROGRESS_INTERVAL_MS = 10000");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("requestCount, ...fields");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain('stdio: ["inherit", "pipe", "inherit"]');
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("delete env.CLAUDE_CODE_OAUTH_TOKEN");
    expect(MEETING_MINUTES_TRACE_RUNNER_SOURCE).toContain("delete env.ANTHROPIC_API_KEY");
  });

  it("parses request, header, chunk timing, end, and usage without retaining body data", () => {
    const trace = parseMeetingMinutesExecutionTrace([
      "claude wrote an unrelated stderr line",
      traceLine({ event: "upstream_request_start", elapsedMs: 3, requestIndex: 1, requestCount: 1,
        requestBytes: 4096, method: "POST", path: "/v1/messages", model: "claude-sonnet-4-5",
        thinkingType: "adaptive", thinkingBudgetTokens: 4096, maxTokens: 8192, effort: "high" }),
      traceLine({ event: "upstream_response_headers", elapsedMs: 120, requestIndex: 1, requestCount: 1,
        statusCode: 200, headersObserved: true, contentType: "text/event-stream" }),
      traceLine({ event: "upstream_response_first_body_chunk", elapsedMs: 121, requestIndex: 1, bodyBytes: 64 }),
      traceLine({ event: "upstream_sse_event", elapsedMs: 122, requestIndex: 1, sseType: "message_start",
        usage: { inputTokens: 50 } }),
      traceLine({ event: "upstream_sse_event", elapsedMs: 723, requestIndex: 1, sseType: "message_delta",
        usage: { outputTokens: 75 } }),
      traceLine({ event: "upstream_sse_event", elapsedMs: 724, requestIndex: 1, sseType: "message_stop" }),
      traceLine({ event: "upstream_response_last_body_chunk", elapsedMs: 724, requestIndex: 1, bodyBytes: 2048 }),
      traceLine({ event: "upstream_response_end", elapsedMs: 725, requestIndex: 1, bodyBytes: 2048,
        usage: { inputTokens: 50, outputTokens: 75, ignored: "body-secret" } }),
    ].join("\n"));

    expect(trace).not.toBeNull();
    expect(trace?.requestCount).toBe(1);
    expect(trace?.events.map((event) => event.event)).toEqual([
      "upstream_request_start", "upstream_response_headers", "upstream_response_first_body_chunk",
      "upstream_sse_event", "upstream_sse_event", "upstream_sse_event",
      "upstream_response_last_body_chunk", "upstream_response_end",
    ]);
    expect(trace?.events.map((event) => event.elapsedMs)).toEqual([3, 120, 121, 122, 723, 724, 724, 725]);
    expect(trace?.events[0]).toMatchObject({ model: "claude-sonnet-4-5", thinkingType: "adaptive",
      thinkingBudgetTokens: 4096, maxTokens: 8192, effort: "high" });
    expect(trace?.events[3]).toMatchObject({ sseType: "message_start", usage: { inputTokens: 50 } });
    expect(trace?.events[5]).toMatchObject({ sseType: "message_stop" });
    expect(trace?.events.at(-1)?.usage).toEqual({ inputTokens: 50, outputTokens: 75 });
    expect(JSON.stringify(trace)).not.toContain("body-secret");
  });

  it("keeps child exit and close ordering and proxy close events", () => {
    const trace = parseMeetingMinutesExecutionTrace([
      traceLine({ event: "child_exit", elapsedMs: 11, exitCode: 0 }),
      traceLine({ event: "child_close", elapsedMs: 12, exitCode: 0 }),
      traceLine({ event: "proxy_close_start", elapsedMs: 12 }),
      traceLine({ event: "proxy_close_end", elapsedMs: 13 }),
    ].join("\n"));
    expect(trace?.events.map((event) => event.event)).toEqual([
      "child_exit", "child_close", "proxy_close_start", "proxy_close_end",
    ]);
    expect(trace?.events[0]).toMatchObject({ exitCode: 0 });
  });

  it("keeps only safe stream progress counters and fixed delta types", () => {
    const trace = parseMeetingMinutesExecutionTrace([
      traceLine({ event: "upstream_sse_event", elapsedMs: 10, requestCount: 1,
        deltaType: "text_delta", textChars: 12, text: "secret" }),
      traceLine({ event: "upstream_response_progress", elapsedMs: 10_000, requestCount: 1,
        bodyBytes: 2048, textChars: 120, thinkingChars: 80, partialJsonChars: 16,
        deltaType: "evil", prompt: "secret" }),
      traceLine({ event: "upstream_response_end", elapsedMs: 10_100, requestCount: 1,
        bodyBytes: 2048, textChars: 120, thinkingChars: 80, partialJsonChars: 16 }),
    ].join("\n"));
    expect(trace?.events[0]).toEqual({ event: "upstream_sse_event", elapsedMs: 10,
      requestCount: 1, deltaType: "text_delta", textChars: 12 });
    expect(trace?.events[1]).toEqual({ event: "upstream_response_progress", elapsedMs: 10_000,
      requestCount: 1, bodyBytes: 2048, textChars: 120, thinkingChars: 80, partialJsonChars: 16 });
    expect(trace?.events[2]).toMatchObject({ event: "upstream_response_end", textChars: 120,
      thinkingChars: 80, partialJsonChars: 16 });
    expect(JSON.stringify(trace)).not.toMatch(/secret|evil/u);
  });

  it("drops secrets, arbitrary text, invalid values, and unknown event fields", () => {
    const trace = sanitizeMeetingMinutesExecutionTrace({
      events: [
        { event: "upstream_response_error", elapsedMs: 5, errorCode: "provider_fetch_failed",
          errorMessage: "provider-secret", body: "prompt-secret", model: "Bearer prompt-secret" },
        { event: "stdout_event", elapsedMs: 6, type: "assistant", subtype: "unknown-secret",
          toolName: "mcp__evil__secret", usage: { inputTokens: 2, arbitrary: "text-secret" }, text: "secret" },
        { event: "stdout_event", elapsedMs: 7, type: "evil", usage: { inputTokens: 3 } },
        { event: "child_close", elapsedMs: -1, exitCode: 0 },
      ],
    });
    expect(trace).not.toBeNull();
    expect(JSON.stringify(trace)).not.toMatch(/secret|Bearer|prompt/u);
    expect(trace?.events[0]).toEqual({ event: "upstream_response_error", elapsedMs: 5, errorCode: "provider_fetch_failed" });
    expect(trace?.events[1]).toEqual({ event: "stdout_event", elapsedMs: 6, type: "assistant", usage: { inputTokens: 2 } });
  });

  it("retains the last bounded events", () => {
    const stderr = Array.from({ length: MEETING_MINUTES_TRACE_MAX_EVENTS + 2 }, (_, index) => traceLine({
      event: "runner_started", elapsedMs: index,
    })).join("\n");
    const trace = parseMeetingMinutesExecutionTrace(stderr);
    expect(trace?.events).toHaveLength(MEETING_MINUTES_TRACE_MAX_EVENTS);
    expect(trace?.events[0]?.elapsedMs).toBe(2);
    expect(trace?.events.at(-1)?.elapsedMs).toBe(MEETING_MINUTES_TRACE_MAX_EVENTS + 1);
  });
});
