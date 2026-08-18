export const MAX_SLACK_REQUEST_BODY_BYTES = 1024 * 1024;

export type SlackRequestBodyErrorCode =
  | "slack_request_body_too_large"
  | "slack_request_content_length_invalid"
  | "slack_request_body_invalid";

export class SlackRequestBodyError extends Error {
  readonly code: SlackRequestBodyErrorCode;

  constructor(code: SlackRequestBodyErrorCode) {
    super(code);
    this.name = "SlackRequestBodyError";
    this.code = code;
  }
}

function declaredContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new SlackRequestBodyError("slack_request_content_length_invalid");
  }
  const length = BigInt(raw);
  if (length > BigInt(MAX_SLACK_REQUEST_BODY_BYTES)) {
    throw new SlackRequestBodyError("slack_request_body_too_large");
  }
  return Number(length);
}

export async function readSlackRequestBody(request: Request): Promise<string> {
  let declaredLength: number | undefined;
  try {
    declaredLength = declaredContentLength(request);
  } catch (error) {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
    throw error;
  }
  if (request.body === null) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw new SlackRequestBodyError("slack_request_content_length_invalid");
    }
    return "";
  }

  const reader = request.body.getReader();
  let body = new Uint8Array(Math.min(declaredLength ?? 4_096, MAX_SLACK_REQUEST_BODY_BYTES));
  let totalLength = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new SlackRequestBodyError("slack_request_body_invalid");
      }
      const { done, value } = result;
      if (done) break;
      const nextLength = totalLength + value.byteLength;
      if (nextLength > MAX_SLACK_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new SlackRequestBodyError("slack_request_body_too_large");
      }
      if (nextLength > body.byteLength) {
        const nextCapacity = Math.min(MAX_SLACK_REQUEST_BODY_BYTES,
          Math.max(nextLength, Math.max(1, body.byteLength * 2)));
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(body.subarray(0, totalLength));
        body = expanded;
      }
      body.set(value, totalLength);
      totalLength = nextLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== totalLength) {
    throw new SlackRequestBodyError("slack_request_content_length_invalid");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, totalLength));
  } catch {
    throw new SlackRequestBodyError("slack_request_body_invalid");
  }
}

export function slackRequestBodyErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof SlackRequestBodyError)) return undefined;
  return Response.json({ error: error.code }, {
    status: error.code === "slack_request_body_too_large" ? 413 : 400,
  });
}
