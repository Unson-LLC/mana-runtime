import {
  MAX_SLACK_REQUEST_BODY_BYTES,
  SlackRequestBodyError,
  readSlackRequestBody,
  slackRequestBodyErrorResponse,
} from "../slack-request-body.js";

describe("readSlackRequestBody", () => {
  it("preserves an ordinary UTF-8 payload when the declared length is valid", async () => {
    const body = "payload=%7B%22text%22%3A%22%E8%AD%B0%E4%BA%8B%E9%8C%B2%22%7D";
    const byteLength = new TextEncoder().encode(body).byteLength;
    const request = new Request("https://worker.test/slack/interactions", {
      method: "POST",
      headers: { "content-length": String(byteLength) },
      body,
    });

    await expect(readSlackRequestBody(request)).resolves.toBe(body);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() { canceled = true; },
    });
    const request = new Request("https://worker.test/slack/events", {
      method: "POST",
      headers: { "content-length": String(MAX_SLACK_REQUEST_BODY_BYTES + 1) },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readSlackRequestBody(request)).rejects.toMatchObject({
      code: "slack_request_body_too_large",
    });
    expect(canceled).toBe(true);
  });

  it("rejects an oversized streamed body when Content-Length is absent", async () => {
    let canceled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? MAX_SLACK_REQUEST_BODY_BYTES : 1));
      },
      cancel() { canceled = true; },
    });
    const request = new Request("https://worker.test/slack/commands", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readSlackRequestBody(request)).rejects.toMatchObject({
      code: "slack_request_body_too_large",
    });
    expect(canceled).toBe(true);
    expect(pullCount).toBe(2);
  });

  it("rejects malformed and mismatched Content-Length values", async () => {
    const malformed = new Request("https://worker.test/slack/events", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "{}",
    });
    const mismatched = new Request("https://worker.test/slack/events", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "{}",
    });

    await expect(readSlackRequestBody(malformed)).rejects.toMatchObject({
      code: "slack_request_content_length_invalid",
    });
    await expect(readSlackRequestBody(mismatched)).rejects.toMatchObject({
      code: "slack_request_content_length_invalid",
    });
  });

  it("rejects malformed UTF-8 without normalizing bytes before HMAC", async () => {
    const request = new Request("https://worker.test/slack/events", {
      method: "POST",
      body: new Uint8Array([0xc3, 0x28]),
    });

    await expect(readSlackRequestBody(request)).rejects.toMatchObject({
      code: "slack_request_body_invalid",
    });
  });

  it("maps only an oversized body to 413", async () => {
    expect(slackRequestBodyErrorResponse(
      new SlackRequestBodyError("slack_request_body_too_large"),
    )?.status).toBe(413);
    expect(slackRequestBodyErrorResponse(
      new SlackRequestBodyError("slack_request_content_length_invalid"),
    )?.status).toBe(400);
    expect(slackRequestBodyErrorResponse(
      new SlackRequestBodyError("slack_request_body_invalid"),
    )?.status).toBe(400);
  });
});
