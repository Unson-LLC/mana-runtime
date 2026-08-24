import { deny } from "./errors.js";

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeSharedId(bytes: Uint8Array): string {
  let bits = "00";
  for (const byte of bytes.slice(0, 16)) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let offset = 0; offset < 130; offset += 5) {
    encoded += CROCKFORD_ALPHABET[Number.parseInt(bits.slice(offset, offset + 5), 2)];
  }
  return encoded;
}

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
  return assertCanonicalSharedId(`${prefix}${encodeSharedId(digest)}`, prefix);
}

/**
 * Derive a stable inquiry/correlation identifier without an async crypto call.
 * Public Slack failure messages are synchronous, so they cannot depend on the
 * Web Crypto promise used by createDeterministicSharedId. The four independent
 * FNV-style lanes are deliberately only an identifier derivation, never a
 * security boundary or a secret-bearing digest.
 */
export function deriveCorrelationId(runId: string, stage: string, code: string): string {
  const seed = `${runId}\u0000${stage}\u0000${code}`;
  const lanes = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae35];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let hash = lanes[lane]! >>> 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= (seed.charCodeAt(index) + lane * 17) & 0xffff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
      hash = Math.imul(hash, 0x5bd1e995) >>> 0;
    }
    lanes[lane] = hash >>> 0;
  }
  const bytes = new Uint8Array(16);
  lanes.forEach((hash, index) => {
    bytes[index * 4] = (hash >>> 24) & 0xff;
    bytes[index * 4 + 1] = (hash >>> 16) & 0xff;
    bytes[index * 4 + 2] = (hash >>> 8) & 0xff;
    bytes[index * 4 + 3] = hash & 0xff;
  });
  return assertCanonicalSharedId(`cor_${encodeSharedId(bytes)}`, "cor_");
}
