export interface TenantCredentialBootstrapEnv {
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID?: string;
  BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
  SLACK_OAUTH_APP_ID?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_URL?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN?: string;
  BRAINBASE_SLACK_CREDENTIAL_STORE_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID?: string;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/u;
const TENANT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const CONNECTION_ID = /^wsc_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SLACK_ID = /^[A-Z][A-Z0-9]{8,20}$/u;
const CREDENTIAL_REF = /^credref:\/\/[A-Za-z0-9._~:/-]{1,500}$/u;

function configured(env: TenantCredentialBootstrapEnv): env is Required<TenantCredentialBootstrapEnv> {
  return TENANT_ID.test(env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID ?? "")
    && TENANT_KEY.test(env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY ?? "")
    && CONNECTION_ID.test(env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID ?? "")
    && SLACK_ID.test(env.SLACK_EXPECTED_TEAM_ID ?? "")
    && SLACK_ID.test(env.SLACK_OAUTH_APP_ID ?? "")
    && Boolean(env.SLACK_BOT_TOKEN_UNSON)
    && Boolean(env.BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN)
    && Boolean(env.BRAINBASE_SLACK_CREDENTIAL_STORE_URL);
}

/**
 * One-time migration boundary for moving the existing production Slack bot
 * token into Brainbase custody. The request accepts no credential input and
 * the response exposes only the opaque credential reference.
 */
export async function bootstrapUnsonSlackCredential(
  request: Request,
  env: TenantCredentialBootstrapEnv,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (request.method !== "POST" || (await request.arrayBuffer()).byteLength !== 0) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!configured(env)) {
    return Response.json({ error: "bootstrap_configuration_invalid" }, { status: 503 });
  }

  let slackIdentity: Response;
  try {
    slackIdentity = await fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN_UNSON}` },
    });
  } catch {
    return Response.json({ error: "slack_identity_unavailable" }, { status: 503 });
  }
  const slackPayload = await slackIdentity.json().catch(() => null) as {
    ok?: unknown;
    team_id?: unknown;
  } | null;
  if (!slackIdentity.ok || slackPayload?.ok !== true || typeof slackPayload.team_id !== "string") {
    return Response.json({ error: "slack_identity_unavailable" }, { status: 503 });
  }
  if (slackPayload.team_id !== env.SLACK_EXPECTED_TEAM_ID) {
    return Response.json({ error: "slack_workspace_mismatch" }, { status: 409 });
  }
  const scopes = (slackIdentity.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();

  let upstream: Response;
  try {
    const credentialStoreFetch = env.BRAINBASE_SLACK_CREDENTIAL_STORE_SERVICE?.fetch
      .bind(env.BRAINBASE_SLACK_CREDENTIAL_STORE_SERVICE) ?? fetchImpl;
    upstream = await credentialStoreFetch(env.BRAINBASE_SLACK_CREDENTIAL_STORE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BRAINBASE_SLACK_CREDENTIAL_STORE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "store",
        tenant_id: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID,
        tenant_key: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_KEY,
        connection_id: env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID,
        connection_revision: "1",
        provider: "slack",
        workspace_id: env.SLACK_EXPECTED_TEAM_ID,
        app_id: env.SLACK_OAUTH_APP_ID,
        idempotency_key: `bootstrap-v2:${env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID}:${env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID}:1`,
        credential_material: env.SLACK_BOT_TOKEN_UNSON,
        credential_mode: "customer_oauth",
      }),
    });
  } catch {
    return Response.json({ error: "credential_store_unavailable" }, { status: 503 });
  }

  const payload = await upstream.json().catch(() => null) as {
    result?: { credential_ref?: unknown; credential_mode?: unknown };
  } | null;
  const credentialRef = payload?.result?.credential_ref;
  if (!upstream.ok || typeof credentialRef !== "string" || !CREDENTIAL_REF.test(credentialRef)) {
    return Response.json({ error: "credential_store_unavailable" }, { status: 503 });
  }

  return Response.json({
    ok: true,
    tenant_id: env.BRAINBASE_SLACK_BOOTSTRAP_TENANT_ID,
    connection_id: env.BRAINBASE_SLACK_BOOTSTRAP_CONNECTION_ID,
    connection_revision: "1",
    provider: "slack",
    workspace_id: env.SLACK_EXPECTED_TEAM_ID,
    app_id: env.SLACK_OAUTH_APP_ID,
    credential_ref: credentialRef,
    credential_mode: "customer_oauth",
    scopes,
  });
}
