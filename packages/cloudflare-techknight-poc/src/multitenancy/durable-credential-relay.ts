import type { CredentialLease, CredentialLeaseBinding } from "./contracts.js";
import {
  TenantCredentialInjector,
  type TenantCredentialRegistry,
} from "./credential-injector.js";
import { TenantBoundaryError } from "./errors.js";

const RELAY_HOST = "tenant-credential-relay.internal";
const TARGET_URL_HEADER = "x-mana-credential-target-url";
const TARGET_METHOD_HEADER = "x-mana-credential-target-method";
const OBSERVED_AT_HEADER = "x-mana-credential-observed-at";
const MARKER_PREFIX = "mana-credential-lease-v1:";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CLOCK_SKEW_MS = 30_000;

interface CredentialRelayStub {
  fetch(request: Request): Promise<Response>;
}

export interface TenantCredentialRelayNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CredentialRelayStub;
}

interface RegistrationInput {
  handle: string;
  lease: CredentialLease;
  expected_binding: CredentialLeaseBinding;
  now: string;
  allowed_hostname?: string;
}

export interface CredentialLeaseOwnership {
  claim(leaseId: string): Promise<boolean>;
}

function inMemoryLeaseOwnership(): CredentialLeaseOwnership {
  const claimed = new Set<string>();
  return {
    async claim(leaseId) {
      if (claimed.has(leaseId)) return false;
      claimed.add(leaseId);
      return true;
    },
  };
}

async function credentialHandleForLease(leaseId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mana-credential-relay-v1:${leaseId}`),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function handleFromAuthorization(value: string | null): string | undefined {
  if (!value?.startsWith(`Bearer ${MARKER_PREFIX}`)) return undefined;
  const handle = value.slice(`Bearer ${MARKER_PREFIX}`.length);
  return HANDLE_PATTERN.test(handle) ? handle : undefined;
}

function relayStub(namespace: TenantCredentialRelayNamespace, handle: string): CredentialRelayStub {
  if (!HANDLE_PATTERN.test(handle)) throw new TenantBoundaryError("credential_lease", "CREDENTIAL_LEASE_INVALID");
  return namespace.get(namespace.idFromName(`credential:${handle}`));
}

async function relayFailure(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  throw new TenantBoundaryError("credential_lease", body?.error ?? "UPSTREAM_UNAVAILABLE");
}

export function createDurableTenantCredentialRegistry(
  namespace: TenantCredentialRelayNamespace,
): TenantCredentialRegistry {
  return {
    async register(input) {
      const handle = await credentialHandleForLease(input.lease.lease_id);
      const response = await relayStub(namespace, handle).fetch(new Request(`https://${RELAY_HOST}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, handle } satisfies RegistrationInput),
      }));
      if (!response.ok) return relayFailure(response);
      return handle;
    },
    async dispose(handle) {
      const response = await relayStub(namespace, handle).fetch(new Request(`https://${RELAY_HOST}/dispose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      }));
      if (!response.ok && response.status !== 404) await relayFailure(response);
    },
  };
}

export async function forwardTenantCredentialRequest(
  namespace: TenantCredentialRelayNamespace,
  request: Request,
  now: string,
): Promise<Response> {
  const handle = handleFromAuthorization(request.headers.get("authorization"));
  if (!handle) return new Response("credential_lease_rejected", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set(TARGET_URL_HEADER, request.url);
  headers.set(TARGET_METHOD_HEADER, request.method);
  headers.set(OBSERVED_AT_HEADER, now);
  headers.delete("content-length");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  try {
    return await relayStub(namespace, handle).fetch(new Request(`https://${RELAY_HOST}/forward`, {
      method: "POST",
      headers,
      body,
    }));
  } catch {
    return new Response("credential_lease_rejected", { status: 503 });
  }
}

export class TenantCredentialRelayHandler {
  readonly #injector = new TenantCredentialInjector();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ownership: CredentialLeaseOwnership = inMemoryLeaseOwnership(),
  ) {}

  activeCredentialCount(): number {
    return this.#injector.activeCredentialCount();
  }

  #clearExpiry(handle: string): void {
    const timer = this.#expiryTimers.get(handle);
    if (timer !== undefined) clearTimeout(timer);
    this.#expiryTimers.delete(handle);
  }

  #scheduleExpiry(handle: string, expiresAt: string, observedAt: string): void {
    this.#clearExpiry(handle);
    const delay = Math.max(0, Date.parse(expiresAt) - Date.parse(observedAt) + CLOCK_SKEW_MS + 1);
    const timer = setTimeout(() => {
      this.#injector.dispose(handle);
      this.#expiryTimers.delete(handle);
    }, delay);
    this.#expiryTimers.set(handle, timer);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== RELAY_HOST || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      if (url.pathname === "/register") {
        const input = await request.json() as RegistrationInput;
        const handle = await this.#injector.register({
          lease: input.lease,
          expected_binding: input.expected_binding,
          now: input.now,
          allowed_hostname: input.allowed_hostname,
          handle: input.handle,
        });
        let claimed = false;
        try {
          claimed = await this.ownership.claim(input.lease.lease_id);
        } catch (error) {
          this.#injector.dispose(handle);
          throw error;
        }
        if (!claimed) {
          this.#injector.dispose(handle);
          throw new TenantBoundaryError("credential_lease", "FALLBACK_FORBIDDEN");
        }
        this.#scheduleExpiry(handle, input.lease.expires_at, input.now);
        return Response.json({ result: { handle } });
      }
      if (url.pathname === "/dispose") {
        const input = await request.json() as { handle?: unknown };
        if (typeof input.handle !== "string") {
          return Response.json({ error: "SCHEMA_INVALID" }, { status: 400 });
        }
        this.#injector.dispose(input.handle);
        this.#clearExpiry(input.handle);
        return Response.json({ result: null });
      }
      if (url.pathname === "/forward") {
        const targetRaw = request.headers.get(TARGET_URL_HEADER);
        const observedAt = request.headers.get(OBSERVED_AT_HEADER) ?? "";
        const method = request.headers.get(TARGET_METHOD_HEADER) ?? "";
        if (!targetRaw || !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) {
          return new Response("credential_lease_rejected", { status: 503 });
        }
        const target = new URL(targetRaw);
        if (target.protocol !== "https:" || target.username || target.password) {
          return new Response("credential_lease_rejected", { status: 503 });
        }
        const headers = this.#injector.inject({ hostname: target.hostname, headers: request.headers, now: observedAt });
        const handle = handleFromAuthorization(request.headers.get("authorization"));
        if (handle) this.#clearExpiry(handle);
        headers.delete(TARGET_URL_HEADER);
        headers.delete(TARGET_METHOD_HEADER);
        headers.delete(OBSERVED_AT_HEADER);
        headers.delete("content-length");
        const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
        return this.fetchImpl(new Request(target, { method, headers, body }));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
      if (url.pathname === "/forward") return new Response("credential_lease_rejected", { status: 503 });
      return Response.json({ error: code }, { status: code === "UPSTREAM_UNAVAILABLE" ? 503 : 409 });
    }
  }
}
