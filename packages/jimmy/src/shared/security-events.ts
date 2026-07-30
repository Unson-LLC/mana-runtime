import crypto from "node:crypto";
import { logger } from "./logger.js";

export type SecurityEventReason =
  | "unmatched" | "unauthorized_actor" | "ambiguous" | "placement_missing_after_config_change"
  | "placement_disabled"
  | "operator_auth_missing" | "operator_auth_invalid" | "operator_hash_missing"
  | "mcp_denied" | "gateway_tool_denied" | "delivery_denied"
  | "parent_missing" | "parent_token_invalid" | "employee_denied" | "execution_override_denied";

export interface SecurityEventInput {
  event: "placement_resolution" | "control_plane" | "capability" | "derived_session";
  decision?: "allow" | "deny";
  reason: SecurityEventReason;
  placementId?: string;
  connector?: string;
  workspaceId?: string;
  channelId?: string;
  actorId?: string;
  sessionId?: string;
  capability?: string;
  target?: string;
  configRevision?: string;
}

export function hashSecurityIdentifier(value: string | undefined): string | undefined {
  return value ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
}

export function placementConfigRevision(placements: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(placements ?? [])).digest("hex").slice(0, 16);
}

function safeMetadata(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[\r\n\t]/g, " ").slice(0, 256);
}

/** Emit a secret-safe, machine-readable authorization decision. Never accepts bodies, prompts, or tokens. */
export function emitSecurityEvent(input: SecurityEventInput): void {
  const event = {
    event: input.event,
    decision: input.decision ?? "deny",
    reason: input.reason,
    placementId: safeMetadata(input.placementId),
    connector: safeMetadata(input.connector),
    workspaceId: safeMetadata(input.workspaceId),
    channelId: safeMetadata(input.channelId),
    actorId: hashSecurityIdentifier(input.actorId) ?? null,
    sessionId: safeMetadata(input.sessionId),
    capability: safeMetadata(input.capability),
    target: safeMetadata(input.target),
    configRevision: safeMetadata(input.configRevision),
    timestamp: new Date().toISOString(),
  };
  logger.warn(`security_event ${JSON.stringify(event)}`);
}
