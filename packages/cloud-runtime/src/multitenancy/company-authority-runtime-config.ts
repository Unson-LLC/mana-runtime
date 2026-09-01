import type {
  CompanyAuthorityAcceptanceOptions,
  CompanyAuthorityDesiredEffect,
} from "./company-authority-runtime-adapter.js";
import { deny } from "./errors.js";

export interface CompanyAuthorityRuntimeConfigEnv {
  BRAINBASE_COMPANY_AUTHORITY_BASE_URL?: string;
  BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID?: string;
  BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON?: string;
  MANA_COMPANY_AUTHORITY_OPERATIONS_JSON?: string;
  MANA_REQUIRED_AUDIENCE?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
}

export type CompanyAuthorityRuntimeConfiguration =
  | { readonly state: "disabled" }
  | {
    readonly state: "enabled";
    readonly base_url: string;
    readonly opted_in_capability_ids: readonly string[];
    readonly desired_effect_by_capability: Readonly<Record<string, CompanyAuthorityDesiredEffect>>;
    readonly acceptance: Omit<CompanyAuthorityAcceptanceOptions, "now">;
  };

const COMPANY_AUTHORITY_BINDINGS = [
  "BRAINBASE_COMPANY_AUTHORITY_BASE_URL",
  "BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID",
  "BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON",
  "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON",
] as const;

type PublicEd25519Jwk = JsonWebKey & { readonly kid?: string };

function invalid(details?: Readonly<Record<string, unknown>>): never {
  return deny("runtime_configuration", "CONFIGURATION_INVALID", details);
}

function requiredText(value: unknown, binding: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid({ binding });
  return value.trim();
}

function parseObject(value: string, binding: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid({ binding });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid({ binding });
  return parsed as Record<string, unknown>;
}

function publicEd25519Jwk(
  candidate: unknown,
  binding: string,
  requireKid: boolean,
): PublicEd25519Jwk {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid({ binding });
  const jwk = candidate as Record<string, unknown>;
  const keyOperationsValid = jwk.key_ops === undefined
    || (Array.isArray(jwk.key_ops)
      && jwk.key_ops.length === 1
      && jwk.key_ops[0] === "verify");
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519"
    || typeof jwk.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    || jwk.d !== undefined
    || (jwk.use !== undefined && jwk.use !== "sig")
    || (jwk.alg !== undefined && jwk.alg !== "EdDSA")
    || !keyOperationsValid
    || (requireKid && (typeof jwk.kid !== "string" || jwk.kid.trim().length === 0))) {
    invalid({ binding });
  }
  return structuredClone(jwk) as PublicEd25519Jwk;
}

function isUnsafeIpv4Octets(octets: readonly number[]): boolean {
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || first >= 224;
}

function isUnsafeAuthorityHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized === "::" || normalized === "::1"
    || /^(?:fc|fd|fe[89ab]|ff[0-9a-f]{2})[0-9a-f]*:/i.test(normalized)) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const suffix = normalized.slice("::ffff:".length);
    if (suffix.includes(".")) return isUnsafeIpv4Octets(suffix.split(".").map(Number));
    const mapped = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return isUnsafeIpv4Octets([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
  }
  return isUnsafeIpv4Octets(normalized.split(".").map(Number));
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid({ binding: "BRAINBASE_COMPANY_AUTHORITY_BASE_URL" });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || isUnsafeAuthorityHostname(url.hostname)) {
    invalid({ binding: "BRAINBASE_COMPANY_AUTHORITY_BASE_URL" });
  }
  return url.origin;
}

function parseOperations(value: string): Readonly<Record<string, CompanyAuthorityDesiredEffect>> {
  const parsed = parseObject(value, "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON");
  const entries = Object.entries(parsed);
  const effects = new Set<CompanyAuthorityDesiredEffect>(["read", "write", "external_side_effect"]);
  if (entries.length === 0 || entries.some(([capability, effect]) =>
    capability === "company_authority_v1"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability)
    || typeof effect !== "string"
    || !effects.has(effect as CompanyAuthorityDesiredEffect))) {
    invalid({ binding: "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON" });
  }
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, CompanyAuthorityDesiredEffect>;
}

function parseTenantVerificationKey(value: string): { key: JsonWebKey; key_id: string } {
  const parsed = parseObject(value, "BRAINBASE_TENANT_CONTEXT_JWKS_JSON");
  if (!Array.isArray(parsed.keys) || parsed.keys.length !== 1) {
    invalid({ binding: "BRAINBASE_TENANT_CONTEXT_JWKS_JSON" });
  }
  const key = publicEd25519Jwk(parsed.keys[0], "BRAINBASE_TENANT_CONTEXT_JWKS_JSON", true);
  return { key, key_id: key.kid! };
}

export function parseCompanyAuthorityRuntimeConfiguration(
  env: CompanyAuthorityRuntimeConfigEnv,
): CompanyAuthorityRuntimeConfiguration {
  if (COMPANY_AUTHORITY_BINDINGS.every((binding) => env[binding] === undefined)) {
    return { state: "disabled" };
  }

  const baseUrl = parseBaseUrl(requiredText(
    env.BRAINBASE_COMPANY_AUTHORITY_BASE_URL,
    "BRAINBASE_COMPANY_AUTHORITY_BASE_URL",
  ));
  const expectedDeploymentId = requiredText(
    env.BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID,
    "BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID",
  );
  const expectedAudience = requiredText(env.MANA_REQUIRED_AUDIENCE, "MANA_REQUIRED_AUDIENCE");
  const publicJwk = publicEd25519Jwk(parseObject(requiredText(
    env.BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON,
    "BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON",
  ), "BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON"), "BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON", false);
  const desiredEffects = parseOperations(requiredText(
    env.MANA_COMPANY_AUTHORITY_OPERATIONS_JSON,
    "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON",
  ));
  const tenantKey = parseTenantVerificationKey(requiredText(
    env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON,
    "BRAINBASE_TENANT_CONTEXT_JWKS_JSON",
  ));

  return {
    state: "enabled",
    base_url: baseUrl,
    opted_in_capability_ids: Object.keys(desiredEffects),
    desired_effect_by_capability: desiredEffects,
    acceptance: {
      expected_audience: expectedAudience,
      expected_deployment_id: expectedDeploymentId,
      public_jwk: publicJwk,
      tenant_context_public_jwk: tenantKey.key,
      tenant_context_key_id: tenantKey.key_id,
    },
  };
}
