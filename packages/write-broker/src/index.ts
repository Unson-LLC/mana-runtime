export type TaskWriteOperation = "task.create" | "task.update" | "task.transition";

export type TaskWriteActor =
  | { provider: "slack"; id: string; workspace: string; personId?: string }
  | { provider: "service"; id: string; workspace: string };

export interface TaskWriteCapabilityClaims {
  version: 1;
  audience: "mana-task-write";
  requestId: string;
  actor: TaskWriteActor;
  placementId: string;
  projects: string[];
  operations: Array<TaskWriteOperation | "*">;
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

export type TaskWritePolicyEffect = "auto" | "approval" | "deny";

export interface TaskWritePolicyRule {
  effect: TaskWritePolicyEffect;
  actors: string[];
  placements: string[];
  projects: string[];
  operations: TaskWriteOperation[];
  targets?: string[];
  approvers?: string[];
  ttlSeconds?: number;
}

export interface TaskWritePolicy {
  version: string;
  rules: TaskWritePolicyRule[];
}

export type TaskWritePolicyDecision =
  | { effect: "auto"; policyVersion: string }
  | { effect: "approval"; policyVersion: string; approvers: string[]; ttlSeconds: number }
  | { effect: "deny"; policyVersion: string; reason: "no_matching_rule" | "rule_denied" };

function validStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.length <= 100
    && values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 128);
}

function validPolicy(policy: TaskWritePolicy): boolean {
  return typeof policy.version === "string" && policy.version.length > 0 && policy.version.length <= 128
    && Array.isArray(policy.rules) && policy.rules.length <= 100
    && policy.rules.every((rule) => {
      if (!rule || !["auto", "approval", "deny"].includes(rule.effect)
        || !validStrings(rule.actors) || !validStrings(rule.placements) || !validStrings(rule.projects)
        || !validStrings(rule.operations)
        || !rule.operations.every((operation) => ["*", "task.create", "task.update", "task.transition"].includes(operation))) return false;
      if (rule.targets !== undefined && !validStrings(rule.targets)) return false;
      if (rule.effect === "approval") {
        return validStrings(rule.approvers) && Number.isInteger(rule.ttlSeconds)
          && rule.ttlSeconds! >= 1 && rule.ttlSeconds! <= 300;
      }
      return rule.approvers === undefined && rule.ttlSeconds === undefined;
    });
}

export function evaluateTaskWritePolicy(policy: TaskWritePolicy, intent: TaskWriteIntent): TaskWritePolicyDecision {
  if (!validPolicy(policy)) throw new Error("invalid_write_policy");
  const includes = (values: string[], value: string) => values.includes("*") || values.includes(value);
  const matches = policy.rules.filter((rule) => includes(rule.actors, intent.actor.id)
    && includes(rule.placements, intent.placementId) && includes(rule.projects, intent.project)
    && includes(rule.operations, intent.operation)
    && (rule.targets === undefined || (intent.targetId !== undefined && rule.targets.includes(intent.targetId))));
  const denied = matches.find((rule) => rule.effect === "deny");
  if (denied) return { effect: "deny", policyVersion: policy.version, reason: "rule_denied" };
  const specificity = (rule: TaskWritePolicyRule): number => Number(rule.actors.includes(intent.actor.id))
    + Number(rule.placements.includes(intent.placementId))
    + Number(rule.projects.includes(intent.project))
    + Number(rule.operations.includes(intent.operation))
    + (rule.targets !== undefined && intent.targetId !== undefined && rule.targets.includes(intent.targetId) ? 1 : 0);
  const highestSpecificity = Math.max(...matches.map(specificity), -1);
  const mostSpecific = matches.filter((rule) => specificity(rule) === highestSpecificity);
  const approval = mostSpecific.find((rule) => rule.effect === "approval");
  if (approval) return { effect: "approval", policyVersion: policy.version,
    approvers: [...approval.approvers!], ttlSeconds: approval.ttlSeconds! };
  if (mostSpecific.some((rule) => rule.effect === "auto")) return { effect: "auto", policyVersion: policy.version };
  return { effect: "deny", policyVersion: policy.version, reason: "no_matching_rule" };
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
  if (!claims.actor.id || !["slack", "service"].includes(claims.actor.provider)
    || (claims.actor.provider === "slack" && claims.actor.personId !== undefined
      && (typeof claims.actor.personId !== "string" || !claims.actor.personId))
    || claims.projects.length === 0 || claims.budget < 1) throw new Error("invalid_write_capability");
  return claims;
}

export function authorizeTaskWriteIntent(claims: TaskWriteCapabilityClaims, intent: TaskWriteIntent): void {
  if (intent.requestId !== claims.requestId || intent.actor.id !== claims.actor.id ||
    intent.actor.workspace !== claims.actor.workspace ||
    (intent.actor.provider === "slack" ? intent.actor.personId : undefined)
      !== (claims.actor.provider === "slack" ? claims.actor.personId : undefined) ||
    intent.actor.provider !== claims.actor.provider ||
    intent.placementId !== claims.placementId) throw new Error("write_intent_actor_mismatch");
  if (!claims.projects.includes(intent.project) || !claims.operations.includes(intent.operation)) throw new Error("write_intent_denied");
  if ((intent.operation === "task.update" || intent.operation === "task.transition") && !intent.targetId) throw new Error("write_target_required");
}
