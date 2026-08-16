import { deny } from "./errors.js";

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function assertCanonicalSharedId(
  value: string,
  prefix: string,
  boundary = "identifier",
): string {
  if (!/^[a-z][a-z0-9]*_$/.test(prefix)
    || !value.startsWith(prefix)
    || !CROCKFORD_ULID.test(value.slice(prefix.length))) {
    deny(boundary, "IDENTIFIER_FORMAT_INVALID", { prefix });
  }
  return value;
}
