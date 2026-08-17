import type { CredentialLease, CredentialLeaseBinding } from "./contracts.js";
import { deny } from "./errors.js";

/**
 * Consumer-side port for the Brainbase-owned provider forwarder.
 *
 * The canonical cross-repository wire is intentionally not described here:
 * contract PR #237 must define that wire before an HTTP/RPC adapter can be
 * enabled in production. In particular, the lease token is an opaque
 * capability and is never a provider credential.
 */
export interface TrustedProviderForwardInput {
  lease: CredentialLease;
  expected_binding: CredentialLeaseBinding;
  request: Request;
  now: string;
}

export interface TrustedProviderForwarder {
  forward(input: TrustedProviderForwardInput): Promise<Response>;
}

const PROVIDER_AUTH_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "xc-token",
  "cookie",
] as const;

export function sanitizeTrustedProviderRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of PROVIDER_AUTH_HEADERS) headers.delete(header);
  const credentialHeaders: string[] = [];
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("x-mana-credential-")) credentialHeaders.push(name);
  });
  for (const name of credentialHeaders) headers.delete(name);
  headers.delete("content-length");
  return new Request(request, { headers, redirect: "manual" });
}

export const unavailableTrustedProviderForwarder: TrustedProviderForwarder = Object.freeze({
  async forward(): Promise<never> {
    deny("credential_lease", "CREDENTIAL_FORWARDING_UNAVAILABLE");
  },
});
