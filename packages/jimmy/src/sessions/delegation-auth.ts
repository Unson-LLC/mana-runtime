import crypto from "node:crypto";

const delegationSecret = crypto.randomBytes(32);

export const SESSION_DELEGATION_HEADER = "x-jinn-session-token";
export const CURRENT_SESSION_HEADER = "x-jinn-session-id";
export const SYSTEM_NOTIFICATION_SESSION_ID = "system:notifications";

export function getSessionDelegationToken(sessionId: string): string {
  return crypto.createHmac("sha256", delegationSecret).update(sessionId).digest("base64url");
}

export function verifySessionDelegationToken(sessionId: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(getSessionDelegationToken(sessionId));
  const received = Buffer.from(token);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
