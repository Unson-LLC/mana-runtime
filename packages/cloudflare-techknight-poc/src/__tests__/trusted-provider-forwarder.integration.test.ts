import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialLease, CredentialLeaseBinding, TenantContextEnvelope } from "../multitenancy/contracts.js";
import { createBrainbaseTrustedProviderForwarderFromEnv } from "../multitenancy/trusted-provider-forwarder.js";

const SERVICE_TOKEN = "brainbase-internal-service-token-placeholder";
const BINDING: CredentialLeaseBinding = {
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  contract_revision: "11",
  operation_id: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  audience: "api.anthropic.com",
  credential_mode: "customer_oauth",
  credential_ref: "opaque-credential-ref-a",
};
const LEASE: CredentialLease = {
  message_type: "credential_lease_response",
  protocol_version: "1.0",
  lease_id: "lease_01ARZ3NDEKTSV4RRFFQ69G5FB0",
  contract_revision: BINDING.contract_revision,
  binding: BINDING,
  issued_at: "2026-08-17T01:00:00.000Z",
  expires_at: "2026-08-17T01:00:59.000Z",
  max_uses: 1,
  lease_token: "opaque-lease-token-not-provider-material",
};
const TENANT_CONTEXT = {
  schema_version: "1.0",
  protocol_id: "mana-brainbase-tenant-context",
  protocol_version: "1.0",
  issuer: "brainbase",
  audience: ["mana-runtime"],
  tenant: { tenant_id: BINDING.tenant_id, tenant_revision: "3" },
  workspace_connection: {
    connection_id: BINDING.connection_id, connection_revision: BINDING.connection_revision,
    provider: "slack", installation_id: "installation-a", workspace_id: "T-A", app_id: "A-MANA", status: "active",
  },
  actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "U-A" },
  authorization: { organization_ids: ["organization-a"], project_ids: ["project-a"], data_scopes: ["tasks:tenant"], capability_ids: ["task.write"] },
  placement: { deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX", profile: "shared_cloud" },
  slack: { event_id: "Ev-A-001", channel_id: "C-A", thread_ts: "1723800000.000001" },
  correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  operation_id: BINDING.operation_id,
  idempotency_key: "idem:v1:test",
  contract_revision: BINDING.contract_revision,
  credential: { mode: BINDING.credential_mode, credential_ref: BINDING.credential_ref, billing_principal_id: "billing-a" },
  issued_at: "2026-08-17T00:59:00.000Z",
  expires_at: "2026-08-17T01:04:00.000Z",
  integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "key-a", value: "protected..signature" },
} satisfies TenantContextEnvelope;

const BASE_ENV = {
  BRAINBASE_TENANT_RUNTIME_ENABLED: "1",
  BRAINBASE_TENANT_RUNTIME_SERVICE: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  },
  BRAINBASE_TASK_API_BASE_URL: "https://tasks.example.test",
  BRAINBASE_GRAPH_API_BASE_URL: "https://graph.example.test",
  BRAINBASE_MCP_BASE_URL: "https://mcp.example.test",
  GOOGLE_DRIVE_MCP_BASE_URL: "https://drive.example.test",
  NOCODB_URL: "https://nocodb.example.test",
};
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return address.port;
}

type ForwardCase = { label: string; operation: string; request: () => Request; wireRequest: Record<string, unknown> };

function jsonRequest(url: string, method: string, body?: Record<string, unknown>, headers?: Record<string, string>): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${LEASE.lease_token}`, "x-api-key": LEASE.lease_token,
      ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const FORWARD_CASES: ForwardCase[] = [
  { label: "Anthropic messages", operation: "anthropic.messages.create",
    request: () => jsonRequest("https://api.anthropic.com/v1/messages", "POST", { model: "claude-sonnet-4-5", messages: [] }),
    wireRequest: { body: { model: "claude-sonnet-4-5", messages: [] } } },
  { label: "Slack POST API", operation: "slack.chat.postMessage.post",
    request: () => jsonRequest("https://slack.com/api/chat.postMessage", "POST", { channel: "C-A", text: "hello" }),
    wireRequest: { body: { channel: "C-A", text: "hello" } } },
  { label: "Slack GET API", operation: "slack.files.info.get",
    request: () => jsonRequest("https://slack.com/api/files.info?file=F-A", "GET"), wireRequest: { query: { file: "F-A" } } },
  { label: "Slack file download", operation: "slack.files.download",
    request: () => jsonRequest("https://files.slack.com/files-pri/T-A-F-A/download/audio.m4a", "GET"),
    wireRequest: { target_url: "https://files.slack.com/files-pri/T-A-F-A/download/audio.m4a" } },
  { label: "Slack response URL", operation: "slack.response_url.post",
    request: () => jsonRequest("https://hooks.slack.com/actions/T-A/B-A/opaque", "POST", { response_type: "ephemeral", text: "done" }),
    wireRequest: { target_url: "https://hooks.slack.com/actions/T-A/B-A/opaque", body: { response_type: "ephemeral", text: "done" } } },
  { label: "Git smart HTTP info refs", operation: "github.git.info_refs",
    request: () => jsonRequest("https://github.com/Unson-LLC/mana-runtime.git/info/refs?service=git-upload-pack", "GET"),
    wireRequest: { path_params: { owner: "Unson-LLC", repo: "mana-runtime" }, query: { service: "git-upload-pack" } } },
  { label: "Git smart HTTP upload pack", operation: "github.git.upload_pack",
    request: () => new Request("https://github.com/Unson-LLC/mana-runtime.git/git-upload-pack", {
      method: "POST", headers: { authorization: `Basic ${LEASE.lease_token}`, "content-type": "application/x-git-upload-pack-request" },
      body: new Uint8Array([0, 1, 2, 255]),
    }), wireRequest: { path_params: { owner: "Unson-LLC", repo: "mana-runtime" }, body: "AAEC/w==" } },
  ...(["GET", "PUT", "DELETE"] as const).map((method): ForwardCase => ({
    label: `GitHub contents ${method}`, operation: `github.contents.${method.toLowerCase()}`,
    request: () => jsonRequest(`https://api.github.com/repos/Unson-LLC/mana-runtime/contents/docs/a.md${method === "GET" ? "?ref=main" : ""}`, method,
      method === "GET" ? undefined : method === "PUT" ? { message: "save", content: "YQ==", branch: "main" } : { message: "remove", sha: "abc", branch: "main" }),
    wireRequest: { path_params: { owner: "Unson-LLC", repo: "mana-runtime", path: "docs/a.md" },
      ...(method === "GET" ? { query: { ref: "main" } } : method === "PUT"
        ? { body: { message: "save", content: "YQ==", branch: "main" } }
        : { body: { message: "remove", sha: "abc", branch: "main" } }) },
  })),
  { label: "NocoDB record list", operation: "nocodb.records.list",
    request: () => jsonRequest("https://nocodb.example.test/api/v1/db/data/noco/prj/tasks?limit=20&offset=0&fields=Id%2CTitle", "GET"),
    wireRequest: { path_params: { project: "prj", table: "tasks" }, query: { limit: "20", offset: "0", fields: "Id,Title" } } },
  { label: "NocoDB record get", operation: "nocodb.records.get",
    request: () => jsonRequest("https://nocodb.example.test/api/v1/db/data/noco/prj/tasks/rec-a", "GET"),
    wireRequest: { path_params: { project: "prj", table: "tasks", record: "rec-a" } } },
  { label: "NocoDB record create", operation: "nocodb.records.create",
    request: () => jsonRequest("https://nocodb.example.test/api/v1/db/data/noco/prj/tasks", "POST", { Title: "A" }),
    wireRequest: { path_params: { project: "prj", table: "tasks" }, body: { Title: "A" } } },
  { label: "NocoDB record update", operation: "nocodb.records.update",
    request: () => jsonRequest("https://nocodb.example.test/api/v1/db/data/noco/prj/tasks/rec-a", "PATCH", { Title: "B" }),
    wireRequest: { path_params: { project: "prj", table: "tasks", record: "rec-a" }, body: { Title: "B" } } },
  { label: "NocoDB record delete", operation: "nocodb.records.delete",
    request: () => jsonRequest("https://nocodb.example.test/api/v1/db/data/noco/prj/tasks/rec-a", "DELETE"),
    wireRequest: { path_params: { project: "prj", table: "tasks", record: "rec-a" } } },
  { label: "NocoDB table list", operation: "nocodb.tables.list",
    request: () => jsonRequest("https://nocodb.example.test/api/v2/meta/bases/prj/tables", "GET"), wireRequest: { path_params: { project: "prj" } } },
  { label: "NocoDB table metadata", operation: "nocodb.tables.get",
    request: () => jsonRequest("https://nocodb.example.test/api/v2/meta/tables/tbl-a", "GET"), wireRequest: { path_params: { table: "tbl-a" } } },
  { label: "NocoDB column update", operation: "nocodb.columns.update",
    request: () => jsonRequest("https://nocodb.example.test/api/v2/meta/columns/col-a", "PATCH", { colOptions: {} }),
    wireRequest: { path_params: { column: "col-a" }, body: { colOptions: {} } } },
  { label: "Task list", operation: "brainbase.tasks.list",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks?status=pending&limit=20&project_code=mana&project_code=runtime", "GET"),
    wireRequest: { query: { status: "pending", limit: "20", project_code: ["mana", "runtime"] } } },
  { label: "Task search", operation: "brainbase.tasks.search",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks/search?query=tenant&limit=10", "GET"),
    wireRequest: { query: { query: "tenant", limit: "10" } } },
  { label: "Task get", operation: "brainbase.tasks.get",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks/ct1.task-a", "GET"), wireRequest: { path_params: { task_id: "ct1.task-a" } } },
  { label: "Task create", operation: "brainbase.tasks.create",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks", "POST", { title: "A" }, { "idempotency-key": "idem-task-create" }),
    wireRequest: { body: { title: "A" }, idempotency_key: "idem-task-create" } },
  { label: "Task update", operation: "brainbase.tasks.update",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks/ct1.task-a", "PATCH", { expected_version: 1, title: "B" }, { "idempotency-key": "idem-task-update" }),
    wireRequest: { path_params: { task_id: "ct1.task-a" }, body: { expected_version: 1, title: "B" }, idempotency_key: "idem-task-update" } },
  { label: "Task transition", operation: "brainbase.tasks.transition",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks/ct1.task-a/transitions", "POST", { expected_version: 1, to_status: "completed" }, { "idempotency-key": "idem-task-transition" }),
    wireRequest: { path_params: { task_id: "ct1.task-a" }, body: { expected_version: 1, to_status: "completed" }, idempotency_key: "idem-task-transition" } },
  { label: "Task delete", operation: "brainbase.tasks.delete",
    request: () => jsonRequest("https://tasks.example.test/api/companion/tasks/ct1.task-a", "DELETE", { expected_version: 1 }, { "idempotency-key": "idem-task-delete" }),
    wireRequest: { path_params: { task_id: "ct1.task-a" }, body: { expected_version: 1 }, idempotency_key: "idem-task-delete" } },
  { label: "Graph entity list", operation: "brainbase.graph.entities.list",
    request: () => jsonRequest("https://graph.example.test/api/info/graph/entities?type=person&limit=500&project=mana", "GET"),
    wireRequest: { query: { type: "person", limit: "500", project: "mana" } } },
  { label: "Graph person by Slack", operation: "brainbase.graph.person_by_slack.get",
    request: () => jsonRequest("https://graph.example.test/api/info/person/by-slack?workspaceId=T-A&slackUserId=U-A&project=mana", "GET"),
    wireRequest: { query: { workspaceId: "T-A", slackUserId: "U-A", project: "mana" } } },
  { label: "Graph context", operation: "brainbase.graph.context.get",
    request: () => jsonRequest("https://graph.example.test/api/info/context?project=mana&workspace=T-A&humanReadable=true", "GET"),
    wireRequest: { query: { project: "mana", workspace: "T-A", humanReadable: "true" } } },
  { label: "Meeting context create", operation: "brainbase.meeting_context.create",
    request: () => jsonRequest("https://tasks.example.test/api/meeting-minutes/context-receipts", "POST", { run_id: "run-a" }),
    wireRequest: { body: { run_id: "run-a" } } },
  { label: "Meeting context get", operation: "brainbase.meeting_context.get",
    request: () => jsonRequest("https://tasks.example.test/api/meeting-minutes/context-receipts/receipt-a?run_id=run-a&project_code=mana&transcript_sha256=abc", "GET"),
    wireRequest: { path_params: { receipt_id: "receipt-a" }, query: { run_id: "run-a", project_code: "mana", transcript_sha256: "abc" } } },
  { label: "Brainbase MCP", operation: "brainbase.mcp.post",
    request: () => jsonRequest("https://mcp.example.test/mcp", "POST", { jsonrpc: "2.0", method: "tools/list", id: 1 }),
    wireRequest: { body: { jsonrpc: "2.0", method: "tools/list", id: 1 } } },
  { label: "Brainbase judgment hook", operation: "brainbase.judgment_hook.post",
    request: () => jsonRequest("https://mcp.example.test/host/judgment/hook", "POST", { event: "stop" }), wireRequest: { body: { event: "stop" } } },
  { label: "Google Drive MCP", operation: "google_drive.mcp.post",
    request: () => jsonRequest("https://drive.example.test/mcp", "POST", { jsonrpc: "2.0", method: "tools/call", id: 2 }),
    wireRequest: { body: { jsonrpc: "2.0", method: "tools/call", id: 2 } } },
];

describe("Brainbase trusted provider forwarder HTTP integration", () => {
  it("materializes provider credentials only inside the trusted service before a successful provider request", async () => {
    const providerCredential = "provider-secret-confined-to-brainbase-test-service";
    let providerHeaders: Record<string, string | string[] | undefined> | undefined;
    const providerPort = await listen((request, response) => {
      providerHeaders = request.headers;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg-a", type: "message" }));
    });
    let trustedWireBody: Record<string, unknown> | undefined;
    const trustedPort = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        void (async () => {
          trustedWireBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const upstream = await fetch(`http://127.0.0.1:${providerPort}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": providerCredential,
              "brainbase-provider-operation": String(trustedWireBody.provider_operation),
            },
            body: JSON.stringify((trustedWireBody.request as { body: unknown }).body),
          });
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(JSON.stringify({
            provider: "anthropic",
            operation_id: BINDING.operation_id,
            provider_operation: trustedWireBody.provider_operation,
            status: upstream.status,
            response_encoding: "json",
            content_type: upstream.headers.get("content-type"),
            body: await upstream.json(),
          }));
        })().catch((error: unknown) => {
          response.writeHead(500, { "content-type": "application/problem+json" });
          response.end(JSON.stringify({ code: "test_trusted_service_failure", detail: String(error) }));
        });
      });
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: {
        ...BASE_ENV,
        BRAINBASE_TENANT_RUNTIME_PORT: String(trustedPort),
        BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      tenant_context: TENANT_CONTEXT,
    });

    const response = await forwarder.forward({
      lease: LEASE,
      expected_binding: BINDING,
      request: jsonRequest("https://api.anthropic.com/v1/messages", "POST", { messages: [] }),
      now: "2026-08-17T01:00:01.000Z",
    });

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({ id: "msg-a", type: "message" });
    expect(JSON.stringify(trustedWireBody)).not.toContain(providerCredential);
    expect(providerHeaders?.["x-api-key"]).toBe(providerCredential);
    expect(providerHeaders?.authorization).toBeUndefined();
    expect(providerHeaders?.["brainbase-provider-operation"]).toBe("anthropic.messages.create");
    expect(responseText).not.toContain(providerCredential);
  });

  it.each(FORWARD_CASES)("maps $label to the exact trusted wire without provider credentials", async (testCase) => {
    let observed: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; url?: string } | undefined;
    const port = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        observed = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, url: request.url };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ provider: testCase.operation.split(".", 1)[0], operation_id: BINDING.operation_id,
          provider_operation: testCase.operation, status: 200, response_encoding: "json", content_type: "application/json", body: { ok: true } }));
      });
    });
    const request = testCase.request();
    const expectedBinding = { ...BINDING, audience: new URL(request.url).hostname };
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: { ...BASE_ENV, BRAINBASE_TENANT_RUNTIME_PORT: String(port), BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN },
      tenant_context: TENANT_CONTEXT,
    });

    const result = await forwarder.forward({ lease: { ...LEASE, binding: expectedBinding }, expected_binding: expectedBinding,
      request, now: "2026-08-17T01:00:01.000Z" });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true });
    expect(observed?.url).toBe("/api/v1/runtime/provider-requests:forward");
    expect(observed?.headers).toMatchObject({ authorization: `Bearer ${SERVICE_TOKEN}`, "brainbase-protocol-version": "1.0",
      "brainbase-deployment-id": TENANT_CONTEXT.placement.deployment_id, "content-type": "application/json" });
    expect(observed?.headers["x-api-key"]).toBeUndefined();
    expect(observed?.headers["xc-token"]).toBeUndefined();
    expect(observed?.headers["idempotency-key"]).toBeUndefined();
    expect(observed?.body).toEqual({ tenant_context: TENANT_CONTEXT, lease_id: LEASE.lease_id, lease_token: LEASE.lease_token,
      audience: expectedBinding.audience, provider_operation: testCase.operation, request: testCase.wireRequest });
  });

  it.each([
    ["disabled service", { BRAINBASE_TENANT_RUNTIME_ENABLED: "0", BRAINBASE_TENANT_RUNTIME_PORT: "31016", BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
    ["missing port", { BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
    ["missing token", { BRAINBASE_TENANT_RUNTIME_PORT: "31016" }],
    ["wildcard host", { BRAINBASE_TENANT_RUNTIME_HOST: "0.0.0.0", BRAINBASE_TENANT_RUNTIME_PORT: "31016", BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
    ["asterisk host", { BRAINBASE_TENANT_RUNTIME_HOST: "*", BRAINBASE_TENANT_RUNTIME_PORT: "31016", BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK: "1", BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
    ["missing Cloudflare service binding", { BRAINBASE_TENANT_RUNTIME_ENABLED: "1", BRAINBASE_TENANT_RUNTIME_PORT: "31016", BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }],
  ])("rejects unsafe internal service configuration: %s", (_label, env) => {
    expect(() => createBrainbaseTrustedProviderForwarderFromEnv({ env, tenant_context: TENANT_CONTEXT })).toThrow("runtime_configuration_invalid");
  });

  it("uses the Brainbase Service Binding instead of the Worker global network", async () => {
    const observed: Array<{ url: string; headers: Headers }> = [];
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        observed.push({ url: request.url, headers: new Headers(request.headers) });
        const body = await request.json() as { provider_operation: string };
        return Response.json({
          provider: "anthropic",
          operation_id: BINDING.operation_id,
          provider_operation: body.provider_operation,
          status: 200,
          response_encoding: "json",
          content_type: "application/json",
          body: { ok: true },
        });
      },
    };
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global network forbidden"));
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: {
        ...BASE_ENV,
        BRAINBASE_TENANT_RUNTIME_SERVICE: service,
        BRAINBASE_TENANT_RUNTIME_PORT: "31016",
        BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      tenant_context: TENANT_CONTEXT,
    });

    await expect(forwarder.forward({
      lease: LEASE,
      expected_binding: BINDING,
      request: jsonRequest("https://api.anthropic.com/v1/messages", "POST", { messages: [] }),
      now: LEASE.issued_at,
    }).then((response) => response.json())).resolves.toEqual({ ok: true });

    expect(globalFetch).not.toHaveBeenCalled();
    expect(observed).toHaveLength(1);
    expect(new URL(observed[0]!.url).pathname).toBe("/api/v1/runtime/provider-requests:forward");
    globalFetch.mockRestore();
  });

  it.each([
    ":leading-punctuation",
    "contains space",
    `a${"x".repeat(200)}`,
  ])("rejects a task idempotency key outside the producer wire grammar: %s", async (idempotencyKey) => {
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: {
        ...BASE_ENV,
        BRAINBASE_TENANT_RUNTIME_PORT: "31016",
        BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      tenant_context: TENANT_CONTEXT,
      fetch_impl: async () => {
        throw new Error("trusted service must not be reached");
      },
    });
    await expect(forwarder.forward({
      lease: LEASE,
      expected_binding: { ...BINDING, audience: "tasks.example.test" },
      request: jsonRequest(
        "https://tasks.example.test/api/companion/tasks",
        "POST",
        { title: "A" },
        { "idempotency-key": idempotencyKey },
      ),
      now: LEASE.issued_at,
    })).rejects.toMatchObject({ boundary: "credential_lease", code: "SCHEMA_INVALID" });
  });

  it("passes through a valid provider non-2xx wrapper and decodes utf8/base64 bodies", async () => {
    const responses = [
      { status: 429, response_encoding: "utf8", content_type: "text/plain", body: "rate limited" },
      { status: 200, response_encoding: "base64", content_type: "application/octet-stream", body: "AAEC/w==" },
    ];
    const port = await listen((_request, response) => {
      const next = responses.shift()!;
      response.writeHead(next.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ provider: "slack", operation_id: BINDING.operation_id, provider_operation: "slack.files.download", ...next }));
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: { ...BASE_ENV, BRAINBASE_TENANT_RUNTIME_PORT: String(port), BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }, tenant_context: TENANT_CONTEXT,
    });
    const request = new Request("https://files.slack.com/files-pri/T/F/download/a.bin");
    const binding = { ...BINDING, audience: "files.slack.com" };
    const limited = await forwarder.forward({ lease: { ...LEASE, binding }, expected_binding: binding, request, now: LEASE.issued_at });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("rate limited");
    const binary = await forwarder.forward({ lease: { ...LEASE, binding }, expected_binding: binding, request, now: LEASE.issued_at });
    expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });

  it("maps Brainbase reflection rejection to a fail-closed tenant boundary error", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(502, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "UPSTREAM_INVALID_RESPONSE", status: 502 }));
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: { ...BASE_ENV, BRAINBASE_TENANT_RUNTIME_PORT: String(port), BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }, tenant_context: TENANT_CONTEXT,
    });
    await expect(forwarder.forward({ lease: LEASE, expected_binding: BINDING,
      request: jsonRequest("https://api.anthropic.com/v1/messages", "POST", { messages: [] }), now: "2026-08-17T01:00:01.000Z" }))
      .rejects.toMatchObject({ boundary: "credential_lease", code: "UPSTREAM_INVALID_RESPONSE" });
  });

  it("rejects malformed or lease-reflecting success wrappers", async () => {
    const bodies = [
      { provider: "anthropic", operation_id: BINDING.operation_id, provider_operation: "anthropic.messages.create", status: 200,
        response_encoding: "json", content_type: "application/json", body: { echoed: LEASE.lease_token } },
      { provider: "anthropic", operation_id: BINDING.operation_id, provider_operation: "anthropic.messages.create", status: 200,
        response_encoding: "json", content_type: "application/json", body: {}, extra: true },
    ];
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(bodies.shift()));
    });
    const forwarder = createBrainbaseTrustedProviderForwarderFromEnv({
      env: { ...BASE_ENV, BRAINBASE_TENANT_RUNTIME_PORT: String(port), BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: SERVICE_TOKEN }, tenant_context: TENANT_CONTEXT,
    });
    for (let index = 0; index < 2; index += 1) {
      await expect(forwarder.forward({ lease: LEASE, expected_binding: BINDING,
        request: jsonRequest("https://api.anthropic.com/v1/messages", "POST", { messages: [] }), now: LEASE.issued_at }))
        .rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE" });
    }
  });
});
