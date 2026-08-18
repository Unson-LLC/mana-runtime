import type { WorkspaceConnectionSnapshot } from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";
import {
  type SlackInstallationBinding,
  type SlackInstallationIntentPort,
} from "./slack-oauth-installation-state.js";

const STATE_PART_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export interface SlackInstallationAuthorizationPort {
  /** Resolve a trusted tenant/admin or pre-provisioned connection intent. Never trust request claims directly. */
  authorize(request: Request): Promise<SlackInstallationBinding>;
}

export interface SlackInstallationControlPlanePort {
  /**
   * Exchange and register inside the credential-owning control plane. The implementation must compare the
   * returned Slack app/workspace/enterprise with `intent` before persisting tokens or registering a connection.
   */
  exchange_and_register(input: {
    authorization_code: string;
    redirect_uri: string;
    intent: SlackInstallationBinding;
  }): Promise<WorkspaceConnectionSnapshot>;
}

type StartOptions = {
  authorizer: SlackInstallationAuthorizationPort;
  intents: SlackInstallationIntentPort;
  app_id: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  ttl_seconds?: number;
  now?: () => number;
  random_bytes?: (length: number) => Uint8Array;
};

type CallbackOptions = {
  intents: SlackInstallationIntentPort;
  control_plane: SlackInstallationControlPlanePort;
  redirect_uri?: string;
  now?: () => number;
};

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function validConfiguration(options: Pick<StartOptions, "app_id" | "client_id" | "redirect_uri" | "scopes">): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.app_id)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(options.client_id)) return false;
  if (options.scopes.length === 0 || options.scopes.some((scope) => !/^[a-z][a-z0-9_.:-]{0,127}$/.test(scope))) return false;
  try {
    return new URL(options.redirect_uri).protocol === "https:";
  } catch {
    return false;
  }
}

function oauthError(error: unknown, fallback: string): Response {
  const code = error instanceof TenantBoundaryError ? error.code : fallback;
  const status = code === "INSTALLATION_STATE_EXPIRED" ? 410
    : code === "INSTALLATION_STATE_REPLAYED" || code === "INSTALLATION_BINDING_MISMATCH"
      || code === "WORKSPACE_CONNECTION_CONFLICT" ? 409
      : code === "INSTALLATION_STATE_INVALID" ? 400
        : code === "INSTALLATION_AUTHORIZATION_REQUIRED" ? 403 : 503;
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

export async function handleSlackOAuthStartRequest(request: Request, options: StartOptions): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (!validConfiguration(options)) return Response.json({ error: "oauth_configuration_invalid" }, { status: 503 });
  const ttlSeconds = options.ttl_seconds ?? 600;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) {
    return Response.json({ error: "oauth_configuration_invalid" }, { status: 503 });
  }
  try {
    const binding = await options.authorizer.authorize(request);
    if (binding.app_id !== options.app_id) {
      throw new TenantBoundaryError("slack_oauth", "INSTALLATION_BINDING_MISMATCH");
    }
    const randomBytes = options.random_bytes ?? secureRandom;
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));
    if (!STATE_PART_PATTERN.test(state) || !STATE_PART_PATTERN.test(nonce)) {
      throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
    }
    const now = (options.now ?? Date.now)();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlSeconds * 1_000).toISOString();
    await options.intents.create({
      ...binding,
      state_hash: await hash(state),
      nonce_hash: await hash(nonce),
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: null,
    });
    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", options.client_id);
    authorizeUrl.searchParams.set("redirect_uri", options.redirect_uri);
    authorizeUrl.searchParams.set("scope", options.scopes.join(","));
    authorizeUrl.searchParams.set("state", `${state}.${nonce}`);
    return Response.json({ authorize_url: authorizeUrl.toString(), expires_at: expiresAt }, {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    return oauthError(error, "INSTALLATION_AUTHORIZATION_REQUIRED");
  }
}

function callbackState(url: URL): { state: string; nonce: string } | undefined {
  const parts = url.searchParams.get("state")?.split(".");
  if (parts?.length !== 2 || !STATE_PART_PATTERN.test(parts[0]) || !STATE_PART_PATTERN.test(parts[1])) return undefined;
  return { state: parts[0], nonce: parts[1] };
}

function assertSnapshotBinding(snapshot: WorkspaceConnectionSnapshot, intent: SlackInstallationBinding): void {
  if (snapshot.tenant_id !== intent.tenant_id || snapshot.app_id !== intent.app_id
    || (intent.expected_workspace_id !== undefined && snapshot.workspace_id !== intent.expected_workspace_id)
    || (intent.expected_enterprise_id !== undefined && snapshot.enterprise_id !== intent.expected_enterprise_id)) {
    throw new TenantBoundaryError("slack_oauth", "WORKSPACE_CONNECTION_CONFLICT");
  }
}

export async function handleSlackOAuthCallbackRequest(request: Request, options: CallbackOptions): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const url = new URL(request.url);
  const state = callbackState(url);
  const code = url.searchParams.get("code");
  if (!state) {
    return oauthError(new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID"), "UPSTREAM_UNAVAILABLE");
  }
  try {
    const intent = await options.intents.claim({
      state_hash: await hash(state.state),
      nonce_hash: await hash(state.nonce),
      now: new Date((options.now ?? Date.now)()).toISOString(),
    });
    if (!code || code.length > 4_096 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
    }
    const snapshot = await options.control_plane.exchange_and_register({
      authorization_code: code,
      redirect_uri: options.redirect_uri ?? `${url.origin}${url.pathname}`,
      intent: {
        installation_intent_id: intent.installation_intent_id,
        tenant_id: intent.tenant_id,
        app_id: intent.app_id,
        ...(intent.expected_workspace_id ? { expected_workspace_id: intent.expected_workspace_id } : {}),
        ...(intent.expected_enterprise_id ? { expected_enterprise_id: intent.expected_enterprise_id } : {}),
        initiated_by_person_id: intent.initiated_by_person_id,
        ...(intent.expected_connection_revision
          ? { expected_connection_revision: intent.expected_connection_revision } : {}),
      },
    });
    assertSnapshotBinding(snapshot, intent);
    return Response.json({ ok: true, connection_id: snapshot.connection_id }, {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    return oauthError(error, "UPSTREAM_UNAVAILABLE");
  }
}
