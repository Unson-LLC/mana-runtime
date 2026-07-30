import crypto from "node:crypto";
import { emitSecurityEvent } from "../shared/security-events.js";

export const OPERATOR_TOKEN_HEADER = "x-openryoko-operator-token";
export const OPERATOR_WS_PROTOCOL = "openryoko-operator";
const OPERATOR_WS_TOKEN_PREFIX = "openryoko-token.";

export function constantTimeEqual(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * @param target Where the unauthenticated access hit (HTTP "METHOD /path" or
 * "ws-upgrade"). Included in the security_event so a recurring
 * operator_auth_missing can be traced to its caller from the journal alone
 * (gap-analysis 2026-07-30 D: without this, the event was unattributable).
 */
export function verifyOperatorToken(received: string | undefined, target?: string): boolean {
  if (!process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256) {
    emitSecurityEvent({ event: "control_plane", reason: "operator_hash_missing", target });
    return false;
  }
  if (!received) {
    emitSecurityEvent({ event: "control_plane", reason: "operator_auth_missing", target });
    return false;
  }
  const receivedHash = crypto.createHash("sha256").update(received).digest("hex");
  const allowed = constantTimeEqual(process.env.OPENRYOKO_OPERATOR_TOKEN_SHA256, receivedHash);
  if (!allowed) emitSecurityEvent({ event: "control_plane", reason: "operator_auth_invalid", target });
  return allowed;
}

export function encodeOperatorWebSocketProtocols(token: string): string[] {
  return [OPERATOR_WS_PROTOCOL, `${OPERATOR_WS_TOKEN_PREFIX}${Buffer.from(token).toString("base64url")}`];
}

export function operatorTokenFromWebSocketProtocol(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header.split(",").map((value) => value.trim());
  if (!protocols.includes(OPERATOR_WS_PROTOCOL)) return undefined;
  const encoded = protocols.find((value) => value.startsWith(OPERATOR_WS_TOKEN_PREFIX));
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded.slice(OPERATOR_WS_TOKEN_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

export function webSocketOperatorAuthorized(header: string | undefined): boolean {
  return verifyOperatorToken(operatorTokenFromWebSocketProtocol(header), "ws-upgrade");
}

export function webSocketUpgradeAuthorized(placementsEnabled: boolean, header: string | undefined): boolean {
  return !placementsEnabled || webSocketOperatorAuthorized(header);
}
