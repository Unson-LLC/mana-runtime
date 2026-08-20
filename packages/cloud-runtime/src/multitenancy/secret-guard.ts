import { deny } from "./errors.js";

const FORBIDDEN_SECRET_KEYS = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|lease[_-]?token|oauth[_-]?token|bot[_-]?token|provider[_-]?token|api[_-]?key|xc[_-]?token|cookie|secret|private[_-]?key|credential[_-]?body|signed[_-]?url)(?:$|[_-])/i;

export function assertSecretArtifactFree<T>(artifact: T): T {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_KEYS.test(key)
        || (key.toLowerCase() === "authorization" && typeof entry === "string")
        || (typeof entry === "string" && /^(?:Bearer|Basic)\s+\S+/i.test(entry))) {
        deny("artifact", "SECRET_ARTIFACT_FORBIDDEN", { path: `${path}.${key}` });
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(artifact, "$");
  return artifact;
}
