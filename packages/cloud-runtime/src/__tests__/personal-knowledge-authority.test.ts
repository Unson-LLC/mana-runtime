import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  resolvePersonalKnowledgeAuthority,
  type PersonalKnowledgeAuthorityInput,
} from "../multitenancy/personal-knowledge-authority.js";
import type { AuthorizedTenantBoundaryContext } from "../multitenancy/durable-tenant-boundary.js";
import type { TenantContextEnvelope, UnsignedTenantContextEnvelope } from "../multitenancy/contracts.js";
import { signTenantContextEnvelope } from "../multitenancy/envelope.js";
import type { CompanyAuthorityRuntimeConfigEnv } from "../multitenancy/company-authority-runtime-config.js";
import type { TenantProviderOutboundEnv } from "../multitenancy/tenant-provider-outbound.js";

// @ts-expect-error The exact A0 producer reference is intentionally vendored as an .mjs contract artifact.
const { createDetachedJws } = await import("../../../../contracts/mana-brainbase-company-authority/v1/reference/wire.mjs");

type JsonRecord = Record<string, any>;
type ResponseMutation = (context: JsonRecord) => void;

const CONTRACT_ID = "mana-brainbase-company-authority/v1";
const COMPANY_KEY_ID = "synthetic-a0-20260821";
const TENANT_KEY_ID = "tenant-key-1";
const DEPLOYMENT_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const TENANT_B_ID = "ten_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CONNECTION_B_ID = "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const DEPLOYMENT_B_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const DM_CHANNEL_ID = "DPERSONAL123";
const DM_THREAD_TS = "thread-personal-dm";
const DM_EVENT_ID = "evt-personal-dm";

let positiveFixture: JsonRecord;
let privateJwk: JsonWebKey;
let publicJwk: JsonWebKey;
let privateKey: CryptoKey;

function freshWindow(): { issuedAt: string; expiresAt: string } {
  const now = Date.now();
  return {
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 240_000).toISOString(),
  };
}

async function readFixture(): Promise<void> {
  const casesPath = new URL(
    "../../../../contracts/mana-brainbase-company-authority/v1/fixtures/cases.json",
    import.meta.url,
  );
  const keyPath = new URL(
    "../../../../contracts/mana-brainbase-company-authority/v1/fixtures/test-key.json",
    import.meta.url,
  );
  const cases = JSON.parse(await readFile(casesPath, "utf8")) as { positive: JsonRecord[] };
  positiveFixture = cases.positive.find((fixture) => fixture.id === "POS-PERSONAL-AUTO-OWNER")!;
  const key = JSON.parse(await readFile(keyPath, "utf8")) as {
    private_jwk: JsonWebKey;
    public_jwk: JsonWebKey;
  };
  privateJwk = key.private_jwk;
  publicJwk = key.public_jwk;
  privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

function initialTenantContext(channelId = DM_CHANNEL_ID): JsonRecord {
  const context = structuredClone(positiveFixture.context) as JsonRecord;
  const tenant = context.tenant_context as JsonRecord;
  tenant.slack = {
    ...tenant.slack,
    channel_id: channelId,
    thread_ts: DM_THREAD_TS,
    event_id: DM_EVENT_ID,
    requester_id: "person-sato",
  };
  return context;
}

async function initialBoundary(channelId = DM_CHANNEL_ID): Promise<AuthorizedTenantBoundaryContext> {
  const context = initialTenantContext(channelId);
  const tenant = context.tenant_context as JsonRecord;
  const { issuedAt, expiresAt } = freshWindow();
  tenant.issued_at = issuedAt;
  tenant.expires_at = expiresAt;
  delete tenant.integrity;
  context.tenant_context = await signTenantContextEnvelope(
    tenant as UnsignedTenantContextEnvelope,
    privateKey,
    TENANT_KEY_ID,
  );
  const signedTenant = context.tenant_context as TenantContextEnvelope;
  return {
    tenant_context: signedTenant,
    expected_scope: {
      audience: "mana-runtime",
      workspace_id: signedTenant.workspace_connection.workspace_id,
      app_id: signedTenant.workspace_connection.app_id,
      channel_id: signedTenant.slack.channel_id,
      thread_ts: signedTenant.slack.thread_ts ?? "",
      actor_principal_id: signedTenant.actor.principal_id,
      project_id: "project-a",
      capability_id: "company_authority_v1",
      deployment_id: signedTenant.placement.deployment_id,
    },
    company_authority_envelope: { source: "verified_slack_dm" },
  };
}

async function signedCompanyAuthorityResponse(
  request: JsonRecord,
  mutation?: ResponseMutation,
): Promise<JsonRecord> {
  const responseContext = structuredClone(positiveFixture.context) as JsonRecord;
  const tenant = responseContext.tenant_context as JsonRecord;
  const { issuedAt, expiresAt } = freshWindow();

  tenant.correlation_id = request.correlation_id;
  tenant.issued_at = issuedAt;
  tenant.expires_at = expiresAt;
  tenant.workspace_connection = {
    ...tenant.workspace_connection,
    workspace_id: request.provider_identity.workspace_id,
    app_id: request.provider_identity.app_id,
  };
  tenant.actor = {
    ...tenant.actor,
    authenticated_subject_id: request.provider_identity.authenticated_subject_id,
  };
  tenant.slack = {
    ...tenant.slack,
    channel_id: request.delivery.channel_id,
    thread_ts: request.delivery.thread_ts,
    event_id: request.delivery.event_id,
    requester_id: request.provider_identity.authenticated_subject_id,
  };
  tenant.authorization = {
    ...tenant.authorization,
    organization_ids: ["organization-tenant-a"],
    project_ids: ["project-a"],
    capability_ids: [
      "signed_tenant_context",
      "tenant_scoped_authorization",
      "company_authority_v1",
    ],
  };

  responseContext.issued_at = issuedAt;
  responseContext.expires_at = expiresAt;
  responseContext.actor = {
    ...responseContext.actor,
    external_subject_id: request.provider_identity.authenticated_subject_id,
    canonical_person_id: "person-sato",
  };
  responseContext.scope = {
    ...responseContext.scope,
    organization_id: "organization-tenant-a",
    project_id: "project-a",
    resource_ref: request.requested_action.resource_ref,
    owner_person_id: "person-sato",
    placement_id: DEPLOYMENT_ID,
  };
  responseContext.authority = {
    ...responseContext.authority,
    decision: "auto",
    capability_id: request.requested_action.capability_id,
    allowed_effects: [request.requested_action.desired_effect],
    accountable_person_id: "person-sato",
  };

  mutation?.(responseContext);

  const unsignedTenant = structuredClone(responseContext.tenant_context) as JsonRecord;
  delete unsignedTenant.integrity;
  responseContext.tenant_context = await signTenantContextEnvelope(
    unsignedTenant as UnsignedTenantContextEnvelope,
    privateKey,
    TENANT_KEY_ID,
  );
  responseContext.integrity = {
    method: "jws_detached",
    algorithm: "EdDSA",
    key_id: COMPANY_KEY_ID,
    value: "",
  };
  responseContext.integrity.value = createDetachedJws(
    responseContext,
    privateJwk,
    COMPANY_KEY_ID,
  );
  return {
    schema_version: "1.0",
    contract_id: CONTRACT_ID,
    correlation_id: request.correlation_id,
    context: responseContext,
    error: null,
  };
}

function makeEnvironment(mutation?: ResponseMutation): {
  env: TenantProviderOutboundEnv & CompanyAuthorityRuntimeConfigEnv;
  fetch: ReturnType<typeof vi.fn>;
  requests: JsonRecord[];
} {
  const requests: JsonRecord[] = [];
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as JsonRecord;
    requests.push(request);
    return Response.json(await signedCompanyAuthorityResponse(request, mutation));
  });
  const env = {
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://brainbase.example.test",
    BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID: DEPLOYMENT_ID,
    BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
    MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: JSON.stringify({
      personal_read: "read",
      personal_write: "write",
    }),
    MANA_COMPANY_AUTHORITY_SLACK_ROLLOUT_JSON: JSON.stringify([{
      workspace_id: "workspace-tenant-a",
      channel_id: DM_CHANNEL_ID,
      authenticated_subject_id: "person-sato",
    }]),
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({
      keys: [{ ...publicJwk, kid: TENANT_KEY_ID }],
    }),
    BRAINBASE_TENANT_RUNTIME_SERVICE: { fetch },
    TENANT_RUNTIME_STATE: {} as TenantProviderOutboundEnv["TENANT_RUNTIME_STATE"],
  } satisfies TenantProviderOutboundEnv & CompanyAuthorityRuntimeConfigEnv;
  return { env, fetch, requests };
}

async function resolve(
  input: PersonalKnowledgeAuthorityInput,
  mutation?: ResponseMutation,
  channelId = DM_CHANNEL_ID,
): Promise<{ result: unknown; fetch: ReturnType<typeof vi.fn>; requests: JsonRecord[] }> {
  const { env, fetch, requests } = makeEnvironment(mutation);
  const result = await resolvePersonalKnowledgeAuthority(env, await initialBoundary(channelId), input);
  return { result, fetch, requests };
}

beforeAll(readFixture);

describe("personal knowledge authority", () => {
  it("accepts a freshly signed personal read response bound to the verified DM", async () => {
    const { result, fetch, requests } = await resolve({
      capability: "personal_read",
      effect: "read",
      requestId: "personal-read-1",
    });

    expect(result).toMatchObject({
      schema_version: "1.0",
      contract_id: CONTRACT_ID,
      context: expect.objectContaining({
        actor: expect.objectContaining({ canonical_person_id: "person-sato" }),
        scope: expect.objectContaining({
          organization_id: "organization-tenant-a",
          project_id: "project-a",
          owner_person_id: "person-sato",
          resource_ref: "personal://person-sato/notes",
        }),
        authority: expect.objectContaining({
          decision: "auto",
          capability_id: "personal_read",
          allowed_effects: ["read"],
        }),
      }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      provider_identity: {
        authenticated_subject_id: "person-sato",
        workspace_id: "workspace-tenant-a",
        app_id: "synthetic-app",
      },
      requested_action: {
        capability_id: "personal_read",
        resource_ref: "personal://person-sato/notes",
        project_hint: "project-a",
        desired_effect: "read",
      },
      delivery: {
        channel_id: DM_CHANNEL_ID,
        thread_ts: DM_THREAD_TS,
        event_id: DM_EVENT_ID,
      },
    });
    expect(requests[0]?.correlation_id).toMatch(/^cor_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("accepts a freshly signed personal write response with only write effect", async () => {
    const { result } = await resolve({
      capability: "personal_write",
      effect: "write",
      requestId: "personal-write-1",
    });

    expect(result).toMatchObject({
      context: expect.objectContaining({
        authority: expect.objectContaining({
          decision: "auto",
          capability_id: "personal_write",
          allowed_effects: ["write"],
        }),
      }),
    });
  });

  it("rejects a signed response whose nested person is different", async () => {
    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-person",
      },
      (context) => {
        context.actor.canonical_person_id = "person-other";
        context.tenant_context.actor.principal_id = "person-other";
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");
  });

  it("rejects a signed response owned by another person", async () => {
    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-owner",
      },
      (context) => {
        context.scope.owner_person_id = "person-other";
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");
  });

  it("rejects a signed response borrowing another tenant or connection", async () => {
    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-tenant",
      },
      (context) => {
        context.tenant_context.tenant.tenant_id = TENANT_B_ID;
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");

    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-connection",
      },
      (context) => {
        context.tenant_context.workspace_connection.connection_id = CONNECTION_B_ID;
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");
  });

  it("rejects organization, project, deployment, and effect mismatches", async () => {
    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-org",
      },
      (context) => {
        context.scope.organization_id = "organization-other";
        context.tenant_context.authorization.organization_ids = ["organization-other"];
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");

    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-project",
      },
      (context) => {
        context.scope.project_id = "project-other";
        context.tenant_context.authorization.project_ids = ["project-other"];
      },
    )).rejects.toThrow("personal_knowledge_authority_denied");

    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-other-deployment",
      },
      (context) => {
        context.scope.placement_id = DEPLOYMENT_B_ID;
        context.tenant_context.placement.deployment_id = DEPLOYMENT_B_ID;
      },
    )).rejects.toThrow();

    await expect(resolve(
      {
        capability: "personal_read",
        effect: "read",
        requestId: "personal-write-effect",
      },
      (context) => {
        context.authority.allowed_effects = ["write"];
      },
    )).rejects.toThrow();
  });

  it("rejects expired responses and non-DM channels before any authority call", async () => {
    const expired = "2020-01-01T00:00:00.000Z";
    const expiredRun = makeEnvironment((context) => {
      context.issued_at = expired;
      context.expires_at = "2020-01-01T00:05:00.000Z";
      context.tenant_context.issued_at = expired;
      context.tenant_context.expires_at = "2020-01-01T00:05:00.000Z";
    });
    await expect(resolvePersonalKnowledgeAuthority(
      expiredRun.env,
      await initialBoundary(),
      { capability: "personal_read", effect: "read", requestId: "personal-expired" },
    )).rejects.toThrow();
    expect(expiredRun.fetch).toHaveBeenCalledTimes(1);

    const sharedRun = makeEnvironment();
    await expect(resolvePersonalKnowledgeAuthority(
      sharedRun.env,
      await initialBoundary("CPUBLIC123"),
      { capability: "personal_read", effect: "read", requestId: "personal-shared-channel" },
    )).rejects.toThrow("personal_knowledge_authority_denied");
    expect(sharedRun.fetch).not.toHaveBeenCalled();
  });

  it("rejects unknown capability and mismatched requested effect without a call", async () => {
    const unknownRun = makeEnvironment();
    await expect(resolvePersonalKnowledgeAuthority(
      unknownRun.env,
      await initialBoundary(),
      {
        capability: "unknown_capability",
        effect: "write",
        requestId: "personal-unknown",
      } as unknown as PersonalKnowledgeAuthorityInput,
    )).rejects.toThrow("personal_knowledge_authority_denied");
    expect(unknownRun.fetch).not.toHaveBeenCalled();

    const effectRun = makeEnvironment();
    await expect(resolvePersonalKnowledgeAuthority(
      effectRun.env,
      await initialBoundary(),
      { capability: "personal_read", effect: "write", requestId: "personal-effect" },
    )).rejects.toThrow("personal_knowledge_authority_denied");
    expect(effectRun.fetch).not.toHaveBeenCalled();
  });
});
