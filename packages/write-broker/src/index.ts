export type TaskWriteOperation = "task.create" | "task.update" | "task.transition";

export interface TaskWriteCapabilityClaims {
  version: 1;
  audience: "mana-task-write";
  requestId: string;
  actor: { provider: "slack"; id: string; workspace: string };
  placementId: string;
  projects: string[];
  operations: TaskWriteOperation[];
  expiresAt: number;
  nonce: string;
  budget: number;
}

export interface TaskWriteIntent {
  requestId: string;
  actor: TaskWriteCapabilityClaims["actor"];
  placementId: string;
  project: string;
  operation: TaskWriteOperation;
  targetId?: string;
  idempotencyKey: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function canonicalClaims(claims: TaskWriteCapabilityClaims): string {
  return JSON.stringify({ ...claims, projects: [...claims.projects].sort(), operations: [...claims.operations].sort() });
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function signTaskWriteCapability(claims: TaskWriteCapabilityClaims, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("write_capability_secret_too_short");
  const payload = canonicalClaims(claims);
  return `${base64url(encoder.encode(payload))}.${base64url(await hmac(secret, payload))}`;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function verifyTaskWriteCapability(
  token: string,
  secret: string,
  expected: { requestId: string; workspace: string; placementId: string; now?: number },
): Promise<TaskWriteCapabilityClaims> {
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra) throw new Error("invalid_write_capability");
  const payload = decoder.decode(fromBase64url(payloadPart));
  if (!timingSafeEqual(fromBase64url(signaturePart), await hmac(secret, payload))) throw new Error("invalid_write_capability");
  const claims = JSON.parse(payload) as TaskWriteCapabilityClaims;
  if (canonicalClaims(claims) !== payload) throw new Error("invalid_write_capability");
  const now = expected.now ?? Date.now();
  if (claims.version !== 1 || claims.audience !== "mana-task-write" || claims.expiresAt <= now) throw new Error("expired_write_capability");
  if (claims.requestId !== expected.requestId || claims.actor.workspace !== expected.workspace || claims.placementId !== expected.placementId) throw new Error("write_capability_scope_mismatch");
  if (!claims.actor.id || claims.actor.provider !== "slack" || claims.projects.length === 0 || claims.budget < 1) throw new Error("invalid_write_capability");
  return claims;
}

export function authorizeTaskWriteIntent(claims: TaskWriteCapabilityClaims, intent: TaskWriteIntent): void {
  if (intent.requestId !== claims.requestId || intent.actor.id !== claims.actor.id || intent.actor.workspace !== claims.actor.workspace || intent.placementId !== claims.placementId) throw new Error("write_intent_actor_mismatch");
  if (!claims.projects.includes(intent.project) || !claims.operations.includes(intent.operation)) throw new Error("write_intent_denied");
  if ((intent.operation === "task.update" || intent.operation === "task.transition") && !intent.targetId) throw new Error("write_target_required");
}
