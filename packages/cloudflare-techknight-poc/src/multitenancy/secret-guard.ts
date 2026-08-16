import { deny } from "./errors.js";

const FORBIDDEN_SECRET_KEYS = /(?:^|_)(?:access_token|refresh_token|api_key|cookie|secret|private_key|credential_body)(?:$|_)/i;

const SECRET_VALUE = Symbol("TenantCredentialSecret");

export interface SecretValue {
  readonly [SECRET_VALUE]: string;
}

export function createSecretValue(value: string): SecretValue {
  if (!value) deny("credential_lease", "CREDENTIAL_SECRET_EMPTY");
  return Object.freeze({ [SECRET_VALUE]: value });
}

export function revealSecretValue(value: SecretValue): string {
  return value[SECRET_VALUE];
}

export function assertSecretArtifactFree<T>(artifact: T): T {
  const visit = (value: unknown, path: string): void => {
    if (value && typeof value === "object" && SECRET_VALUE in value) {
      deny("artifact", "SECRET_ARTIFACT_FORBIDDEN", { path });
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_KEYS.test(key)
        || (key.toLowerCase() === "authorization" && typeof entry === "string")) {
        deny("artifact", "SECRET_ARTIFACT_FORBIDDEN", { path: `${path}.${key}` });
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(artifact, "$");
  return artifact;
}
