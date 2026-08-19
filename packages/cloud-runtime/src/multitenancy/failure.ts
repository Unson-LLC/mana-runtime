import { TenantBoundaryError } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export type UserFailureCode =
  | "installation_required"
  | "reauthentication_required"
  | "administrator_action_required"
  | "usage_limit_reached"
  | "temporary_failure";

export interface UserFailure {
  code: UserFailureCode;
  message_key: `tenant.${UserFailureCode}`;
  next_actions: string[];
  correlation_id: string;
}

const INSTALLATION_CODES = new Set(["INSTALLATION_REQUIRED", "WORKSPACE_CONNECTION_UNINSTALLED"]);
const REAUTHENTICATION_CODES = new Set([
  "WORKSPACE_CONNECTION_REAUTH_REQUIRED",
  "WORKSPACE_CONNECTION_REVOKED",
  "CREDENTIAL_LEASE_EXPIRED",
  "CREDENTIAL_LEASE_INVALID",
]);
const ADMINISTRATOR_CODES = new Set([
  "TENANT_UNKNOWN",
  "TENANT_AMBIGUOUS",
  "WORKSPACE_CONNECTION_STALE_REVISION",
  "WORKSPACE_OR_APP_MISMATCH",
  "WORKSPACE_SCOPE_INSUFFICIENT",
  "ACTOR_SCOPE_MISMATCH",
  "PROJECT_SCOPE_MISMATCH",
  "CAPABILITY_SCOPE_MISMATCH",
  "CROSS_TENANT_CANDIDATE",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "PROTOCOL_CAPABILITY_UNSUPPORTED",
  "QUOTA_APPROVAL_REQUIRED",
  "REPLY_OWNERSHIP_CONFLICT",
]);

function publicCode(error: unknown): UserFailureCode {
  const internalCode = error instanceof TenantBoundaryError ? error.code : "";
  if (internalCode === "QUOTA_EXCEEDED") return "usage_limit_reached";
  if (INSTALLATION_CODES.has(internalCode)) return "installation_required";
  if (REAUTHENTICATION_CODES.has(internalCode)) return "reauthentication_required";
  if (ADMINISTRATOR_CODES.has(internalCode)) return "administrator_action_required";
  return "temporary_failure";
}

const NEXT_ACTIONS: Record<UserFailureCode, string[]> = {
  installation_required: ["install_application"],
  reauthentication_required: ["reauthenticate_connection"],
  administrator_action_required: ["contact_administrator"],
  usage_limit_reached: ["contact_administrator"],
  temporary_failure: ["retry_later"],
};

export function createUserFailure(input: { error: unknown; correlation_id: string }): UserFailure {
  assertCanonicalSharedId(input.correlation_id, "cor_", "user_failure");
  const code = publicCode(input.error);
  return assertSecretArtifactFree({
    code,
    message_key: `tenant.${code}`,
    next_actions: [...NEXT_ACTIONS[code]],
    correlation_id: input.correlation_id,
  });
}
