function assertNoLoneSurrogate(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("JCS rejects lone UTF-16 surrogates");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("JCS rejects lone UTF-16 surrogates");
    }
  }
}

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") assertNoLoneSurrogate(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("JCS rejects cyclic values");
    seen.add(value);
    const result = `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("JCS rejects cyclic values");
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const result = `{${entries.map(([key, entry]) => {
      assertNoLoneSurrogate(key);
      return `${JSON.stringify(key)}:${canonicalValue(entry, seen)}`;
    }).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new TypeError(`JCS rejects ${typeof value}`);
}

export function jcsCanonicalize(value: unknown): string {
  return canonicalValue(value, new Set());
}
