const CONTROL_PREFIX = "[mana_development_control_v1]";
const STORY_ID_RE = /^story-[a-z0-9-]+$/;
const ANSWER_ID_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_CONTROL_LENGTH = 7_500;
const MAX_ANSWERS = 10;
const MAX_ANSWER_LENGTH = 2_000;

export interface ManaDevelopmentAnswer {
  id: string;
  answer: string;
}

export type ManaDevelopmentControlRequest =
  | { mode: "new"; request: string }
  | { mode: "resume"; storyId: string; answers: ManaDevelopmentAnswer[] }
  | { mode: "continueGates"; storyId: string };

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("mana_development_control_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { throw new Error("mana_development_control_invalid"); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("mana_development_control_invalid"); }
}

function validateStoryId(value: unknown): string {
  if (typeof value !== "string" || !STORY_ID_RE.test(value)) {
    throw new Error("mana_development_story_invalid");
  }
  return value;
}

function validateAnswers(value: unknown): ManaDevelopmentAnswer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ANSWERS) {
    throw new Error("mana_development_answers_invalid");
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("mana_development_answers_invalid");
    }
    const answer = raw as Record<string, unknown>;
    if (typeof answer.id !== "string" || !ANSWER_ID_RE.test(answer.id) || ids.has(answer.id)
      || typeof answer.answer !== "string" || answer.answer.length < 1 || answer.answer.length > MAX_ANSWER_LENGTH) {
      throw new Error("mana_development_answers_invalid");
    }
    ids.add(answer.id);
    return { id: answer.id, answer: answer.answer };
  });
}

function serialize(value: Record<string, unknown>): string {
  const encoded = `${CONTROL_PREFIX}${base64UrlEncode(JSON.stringify(value))}`;
  if (encoded.length > MAX_CONTROL_LENGTH) throw new Error("mana_development_control_too_large");
  return encoded;
}

export function serializeManaDevelopmentResume(input: {
  storyId: string;
  answers: ManaDevelopmentAnswer[];
}): string {
  return serialize({ mode: "resume", storyId: validateStoryId(input.storyId), answers: validateAnswers(input.answers) });
}

export function serializeManaDevelopmentContinueGates(storyId: string): string {
  return serialize({ mode: "continueGates", storyId: validateStoryId(storyId) });
}

export function parseManaDevelopmentControlRequest(request: string): ManaDevelopmentControlRequest {
  const trimmed = request.trim();
  if (!trimmed.startsWith(CONTROL_PREFIX)) {
    if (!trimmed) throw new Error("development request is empty");
    return { mode: "new", request: trimmed };
  }
  const encoded = trimmed.slice(CONTROL_PREFIX.length);
  if (!encoded || trimmed.length > MAX_CONTROL_LENGTH) throw new Error("mana_development_control_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(base64UrlDecode(encoded)); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("mana_development_")) throw error;
    throw new Error("mana_development_control_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mana_development_control_invalid");
  }
  const control = parsed as Record<string, unknown>;
  const storyId = validateStoryId(control.storyId);
  if (control.mode === "resume") {
    return { mode: "resume", storyId, answers: validateAnswers(control.answers) };
  }
  if (control.mode === "continueGates") {
    return { mode: "continueGates", storyId };
  }
  throw new Error("mana_development_control_invalid");
}
