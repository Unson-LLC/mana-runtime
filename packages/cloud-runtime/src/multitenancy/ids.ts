import { deny } from "./errors.js";

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

export async function createDeterministicSharedId(prefix: string, seed: string): Promise<string> {
  if (!seed) deny("identifier", "IDENTIFIER_FORMAT_INVALID", { prefix });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  let bits = "00";
  for (const byte of digest.slice(0, 16)) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let offset = 0; offset < 130; offset += 5) {
    encoded += CROCKFORD_ALPHABET[Number.parseInt(bits.slice(offset, offset + 5), 2)];
  }
  return assertCanonicalSharedId(`${prefix}${encoded}`, prefix);
}
