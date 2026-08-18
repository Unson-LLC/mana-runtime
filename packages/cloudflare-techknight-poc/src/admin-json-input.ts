export const MAX_ADMIN_JSON_BODY_BYTES = 64 * 1024;
export const MAX_MEETING_MINUTES_ADMIN_TASK_IDS = 100;
export const MAX_MEETING_MINUTES_ADMIN_TASK_ID_LENGTH = 512;

export type AdminJsonInputErrorCode =
  | "admin_json_body_too_large"
  | "admin_json_content_length_invalid"
  | "admin_json_body_invalid"
  | "invalid_json";

export class AdminJsonInputError extends Error {
  readonly code: AdminJsonInputErrorCode;

  constructor(code: AdminJsonInputErrorCode) {
    super(code);
    this.name = "AdminJsonInputError";
    this.code = code;
  }
}

function declaredContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new AdminJsonInputError("admin_json_content_length_invalid");
  }
  const length = BigInt(raw);
  if (length > BigInt(MAX_ADMIN_JSON_BODY_BYTES)) {
    throw new AdminJsonInputError("admin_json_body_too_large");
  }
  return Number(length);
}

async function readAdminRequestBody(request: Request): Promise<string> {
  let declaredLength: number | undefined;
  try {
    declaredLength = declaredContentLength(request);
  } catch (error) {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
    throw error;
  }
  if (request.body === null) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw new AdminJsonInputError("admin_json_content_length_invalid");
    }
    return "";
  }

  const reader = request.body.getReader();
  let body = new Uint8Array(Math.min(declaredLength ?? 1_024, MAX_ADMIN_JSON_BODY_BYTES));
  let totalLength = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new AdminJsonInputError("admin_json_body_invalid");
      }
      if (result.done) break;
      const nextLength = totalLength + result.value.byteLength;
      if (nextLength > MAX_ADMIN_JSON_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new AdminJsonInputError("admin_json_body_too_large");
      }
      if (nextLength > body.byteLength) {
        const nextCapacity = Math.min(MAX_ADMIN_JSON_BODY_BYTES,
          Math.max(nextLength, Math.max(1, body.byteLength * 2)));
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(body.subarray(0, totalLength));
        body = expanded;
      }
      body.set(result.value, totalLength);
      totalLength = nextLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== totalLength) {
    throw new AdminJsonInputError("admin_json_content_length_invalid");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, totalLength));
  } catch {
    throw new AdminJsonInputError("admin_json_body_invalid");
  }
}

export async function readAdminJsonRequest(request: Request): Promise<unknown> {
  const body = await readAdminRequestBody(request);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AdminJsonInputError("invalid_json");
  }
}

export function adminJsonInputErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof AdminJsonInputError)) return undefined;
  return Response.json({ error: error.code }, {
    status: error.code === "admin_json_body_too_large" ? 413 : 400,
  });
}

export function validateMeetingMinutesAdminTaskIds(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const taskIds = (payload as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(taskIds) || taskIds.length > MAX_MEETING_MINUTES_ADMIN_TASK_IDS ||
    !taskIds.every((taskId) => typeof taskId === "string" && taskId.length >= 3 &&
      taskId.length <= MAX_MEETING_MINUTES_ADMIN_TASK_ID_LENGTH && !/[\u0000-\u001f\u007f]/u.test(taskId))) {
    return undefined;
  }
  return [...new Set(taskIds)];
}
