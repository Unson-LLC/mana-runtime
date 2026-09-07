import { describe, expect, it, vi } from "vitest";
import { signTaskWriteCapability } from "@openryoko/write-broker";
import { createRuntimeGatewayProxyHandler } from "../runtime-gateway-proxy.js";
import type { TenantContextEnvelope } from "../multitenancy/contracts.js";

const secret = "g".repeat(32);
const placements = JSON.stringify([{ placementId: "mana-dev-biz", channelId: "C_MANA", channelName: "0240-mana-dev", projectCodes: ["mana"], taskWriteEnabled: true,
  audience: { type: "operator", allowedUserIds: ["UALLOWED"] }, taskInventoryChannelIds: ["C_MANA", "C_ACCOUNTING"], taskInventoryAllowedUserIds: ["UALLOWED"],
  capabilities: { mcp: ["gateway"], gatewayTools: ["list_tasks","search_tasks","list_authorized_task_channels","list_tasks_across_channels","search_tasks_across_channels","send_message"] },
  deliveryScopes: [{ connector: "slack", channelId: "C_MANA" }] },
{ placementId: "mana-accounting", channelId: "C_ACCOUNTING", channelName: "9960-back-office", projectCodes: ["back-office"], taskWriteEnabled: false,
  taskInventoryAllowedUserIds: ["UALLOWED"] }]);
async function capability(actor = "UALLOWED", projects = ["mana"]) { return signTaskWriteCapability({ version: 1, audience: "mana-task-write", requestId: "Ev1", actor: { provider: "slack", id: actor, workspace: "T_TEAM" }, placementId: "mana-dev-biz", projects, operations: ["*"], expiresAt: Date.now() + 60_000, nonce: "n", budget: 3 }, secret); }
const env = { TASK_WRITE_CAPABILITY_SECRET: secret, SLACK_EXPECTED_TEAM_ID: "T_TEAM", RUNTIME_PLACEMENTS_JSON: placements, RUNTIME_TASK_SEARCH_ENABLED: "true", BRAINBASE_TASK_API_BASE_URL: "https://tasks.example.com", BRAINBASE_TASK_API_TOKEN: "task-token", SLACK_BOT_TOKEN: "slack-token", RUNTIME_EMPLOYEES_JSON: JSON.stringify([{ name: "critical-reviewer", persona: "private instructions", model: "opus" }]) };
const request = async (tool: string, args: Record<string, unknown>, token = capability()) => new Request("https://gateway.internal/api/runtime/gateway", { method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": await token }, body: JSON.stringify({ tool, arguments: args, request_id: "Ev1", call_index: 1 }) });
const personalPlacements = JSON.stringify([{ placementId: "mana-personal-dm", channelId: "DPERSONAL", projectCodes: ["mana"], taskWriteEnabled: true,
  audience: { type: "operator", allowedUserIds: ["UALLOWED"] }, capabilities: { mcp: ["gateway"], gatewayTools: ["search_personal_kg", "register_personal_kg"] } }]);
async function personalCapability(actor = "UALLOWED") {
  return signTaskWriteCapability({ version: 1, audience: "mana-task-write", requestId: "Ev1", actor: { provider: "slack", id: actor, workspace: "T_TEAM" }, placementId: "mana-personal-dm", projects: ["mana"], operations: ["*"], expiresAt: Date.now() + 60_000, nonce: "personal-n", budget: 3 }, secret);
}
const personalTenantContext = {
  schema_version: "1.0", protocol_id: "mana-brainbase-tenant-context", protocol_version: "1.0", issuer: "brainbase", audience: ["mana-runtime"],
  tenant: { tenant_id: "tenant-a", tenant_revision: "r1" },
  workspace_connection: { connection_id: "conn-a", connection_revision: "r1", provider: "slack", installation_id: "inst-a", workspace_id: "T_TEAM", app_id: "A_MANA", status: "active" },
  actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "UALLOWED" },
  authorization: { organization_ids: ["org-a"], project_ids: ["mana"], data_scopes: ["personal_knowledge"], capability_ids: ["personal_read", "personal_write"] },
  placement: { deployment_id: "mana-personal-dm", profile: "shared_cloud" },
  slack: { event_id: "Ev1", channel_id: "DPERSONAL", thread_ts: "1.0", requester_id: "UALLOWED" },
  correlation_id: "corr-a", operation_id: "op-a", idempotency_key: "idem-a", contract_revision: "r1", credential: { mode: "cloud_standard", credential_ref: "ref-a", billing_principal_id: "person-a" },
  issued_at: "2026-09-06T00:00:00.000Z", expires_at: "2026-09-06T00:05:00.000Z", integrity: { method: "jws_detached", algorithm: "EdDSA", key_id: "key-a", value: "sig-a" },
} as TenantContextEnvelope;
const personalRequest = async (tool: string, args: Record<string, unknown>, token = personalCapability()) => new Request("https://gateway.internal/api/runtime/gateway", {
  method: "POST", headers: { "content-type": "application/json", "x-mana-task-write-capability": await token },
  body: JSON.stringify({ tool, arguments: args, request_id: "Ev1", call_index: 1 }),
});

describe("runtime gateway proxy", () => {
  it("resolves read authority and searches only the verified personal DM", async () => {
    const authority = { decision: "auto", company_authority_response: "signed-read" };
    const resolveAuthority = vi.fn(async (input: { capability: string; effect: string; requestId: string }) => ({ ...authority, input }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/api/personal-knowledge/search");
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer bb-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "契約", limit: 10, company_authority_response: { ...authority, input: { capability: "personal_read", effect: "read", requestId: "Ev1" } },
      });
      return Response.json([{ event_id: "event-a", body: "本人メモ" }]);
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      personalKnowledge: { tenantContext: personalTenantContext, resolveAuthority },
    })(await personalRequest("search_personal_kg", { query: " 契約 " }), {
      ...env, RUNTIME_PLACEMENTS_JSON: personalPlacements, BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL: "https://brainbase.example.com", BRAINBASE_PERSONAL_KNOWLEDGE_API_TOKEN: "bb-token",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ untrusted_data: true, items: [{ event_id: "event-a", body: "本人メモ" }] });
    expect(resolveAuthority).toHaveBeenCalledWith({ capability: "personal_read", effect: "read", requestId: "Ev1" });
  });

  it("registers only persisted personal event fields with write authority", async () => {
    const resolveAuthority = vi.fn(async (input: { capability: string; effect: string; requestId: string }) => ({ signed: input }));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        body: "本人の判断", body_hash: "sha256:abc", event_id: "event-a", source: { kind: "slack" },
        source_pointer: { channel_id: "DPERSONAL" }, permission_snapshot: { scope: "personal" }, sensitivity: "private",
        occurred_at: "2026-09-06T00:00:00.000Z", captured_at: "2026-09-06T00:00:01.000Z",
        company_authority_response: { signed: { capability: "personal_write", effect: "write", requestId: "Ev1" } },
      });
      return Response.json({ event_id: "event-a", owner_person_id: "person-a", organization_id: "org-a", body_hash: "sha256:abc" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      personalKnowledge: { tenantContext: personalTenantContext, resolveAuthority },
    })(await personalRequest("register_personal_kg", {
      body: "本人の判断", body_hash: "sha256:abc", event_id: "event-a", source: { kind: "slack" },
      source_pointer: { channel_id: "DPERSONAL" }, permission_snapshot: { scope: "personal" }, sensitivity: "private",
      occurred_at: "2026-09-06T00:00:00.000Z", captured_at: "2026-09-06T00:00:01.000Z",
    }), {
      ...env, RUNTIME_PLACEMENTS_JSON: personalPlacements, BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL: "https://brainbase.example.com",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ untrusted_data: true, event: { event_id: "event-a", owner_person_id: "person-a", organization_id: "org-a", body_hash: "sha256:abc" } });
    expect(resolveAuthority).toHaveBeenCalledWith({ capability: "personal_write", effect: "write", requestId: "Ev1" });
  });

  it.each([
    ["owner_person_id", { body: "x", body_hash: "sha256:x", owner_person_id: "person-a" }],
    ["organization_id", { body: "x", body_hash: "sha256:x", organization_id: "org-a" }],
    ["authority", { query: "x", authority: "spoof" }],
  ])("rejects model-supplied personal scope %s before authority or upstream", async (_name, args) => {
    const resolveAuthority = vi.fn();
    const fetchImpl = vi.fn();
    const tool = "query" in args ? "search_personal_kg" : "register_personal_kg";
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      personalKnowledge: { tenantContext: personalTenantContext, resolveAuthority },
    })(await personalRequest(tool, args), {
      ...env, RUNTIME_PLACEMENTS_JSON: personalPlacements, BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL: "https://brainbase.example.com",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_arguments" });
    expect(resolveAuthority).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects shared or non-DM placements before personal authority resolution", async () => {
    const resolveAuthority = vi.fn();
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      personalKnowledge: { tenantContext: personalTenantContext, resolveAuthority },
    })(await request("search_personal_kg", { query: "x" }), {
      ...env,
      RUNTIME_PLACEMENTS_JSON: placements.replace('"send_message"', '"send_message","search_personal_kg"'),
      BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL: "https://brainbase.example.com",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "gateway_denied" });
    expect(resolveAuthority).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not turn an invalid or failed personal upstream response into an empty result", async () => {
    const resolveAuthority = vi.fn(async () => ({ signed: true }));
    const fetchImpl = vi.fn(async () => Response.json({ items: [] }, { status: 500 }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      personalKnowledge: { tenantContext: personalTenantContext, resolveAuthority },
    })(await personalRequest("search_personal_kg", { query: "x" }), {
      ...env, RUNTIME_PLACEMENTS_JSON: personalPlacements, BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL: "https://brainbase.example.com",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_failed" });
  });

  it("lists only task channels authorized for the actor", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_authorized_task_channels", {}), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [
        { channel_id: "C_MANA", channel_name: "0240-mana-dev", project_codes: ["mana"] },
        { channel_id: "C_ACCOUNTING", channel_name: "9960-back-office", project_codes: ["back-office"] },
      ],
      scope: { mode: "authorized_channels" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("omits task channels unauthorized for the actor", async () => {
    const restricted = JSON.parse(placements) as Array<Record<string, unknown>>;
    restricted[1].taskInventoryAllowedUserIds = ["UOTHER"];
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_authorized_task_channels", {}), {
      ...env, RUNTIME_PLACEMENTS_JSON: JSON.stringify(restricted),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [{ channel_id: "C_MANA", channel_name: "0240-mana-dev", project_codes: ["mana"] }],
      scope: { mode: "authorized_channels" },
    });
  });
  it("fails closed without disclosing ambiguous task channels", async () => {
    const ambiguous = JSON.parse(placements) as Array<Record<string, unknown>>;
    ambiguous.push({ placementId: "duplicate-mana", channelId: "C_MANA", channelName: "duplicate", projectCodes: ["outside"], taskInventoryAllowedUserIds: ["UALLOWED"] });
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_authorized_task_channels", {}), {
      ...env, RUNTIME_PLACEMENTS_JSON: JSON.stringify(ambiguous),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "gateway_denied" });
  });
  it("forces list_tasks to the placement project", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { expect(input instanceof Request ? input.url : String(input)).toContain("project_code=mana"); return Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"], assignee_person_id: null, assignee_display_name: null, due_at: null }], next_cursor: null }); });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", { limit: 10, project: "outside" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total_count: null,
      count_status: "not_requested",
      has_more: false,
      read_status: "complete",
      scope: { mode: "current_channel", project_codes: ["mana"] },
    });
  });
  it("preserves exact count metadata and reports partial list reads", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"], assignee_person_id: null, assignee_display_name: null, due_at: null }],
      next_cursor: "next",
      total_count: 37,
      count_status: "exact",
      read_status: "partial",
    }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject({ total_count: 37, count_status: "exact", has_more: true, read_status: "partial" });
  });
  it("implements bounded search_tasks with placement scope and count metadata", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/companion/tasks/search");
      expect(url.searchParams.get("query")).toBe("契約");
      expect(url.searchParams.getAll("project_code")).toEqual(["mana"]);
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.searchParams.get("status")).toBe("pending");
      expect(url.searchParams.get("priority")).toBe("high");
      expect(url.searchParams.get("assignee_person_id")).toBe("person-1");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      return Response.json({ items: [], next_cursor: null, total_count: 0, count_status: "exact", has_more: false, read_status: "complete" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks", { query: "契約", limit: 20, project: "outside", status: "pending", priority: "high", assignee_person_id: "person-1", cursor: "cursor-1" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 0, count_status: "exact", has_more: false, scope: { mode: "current_channel", project_codes: ["mana"] } });
  });
  it("lists tasks across explicitly authorized channels", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      return Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["back-office"] }], next_cursor: null, total_count: 1, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks_across_channels", { channel_ids: ["C_MANA", "C_ACCOUNTING"], limit: 20 }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 1, scope: { mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"], project_codes: ["mana", "back-office"], channels: [
      { channel_id: "C_MANA", project_codes: ["mana"] }, { channel_id: "C_ACCOUNTING", project_codes: ["back-office"] },
    ] } });
  });
  it("searches tasks across explicitly authorized channels", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/companion/tasks/search");
      expect(url.searchParams.get("query")).toBe("請求");
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      expect(url.searchParams.get("status")).toBe("pending");
      expect(url.searchParams.get("priority")).toBe("high");
      expect(url.searchParams.get("assignee_person_id")).toBe("person-1");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      expect(url.searchParams.get("limit")).toBe("12");
      return Response.json({ items: [{ id: "t1", title: "請求確認", status: "pending", priority: "high", version: 1, project_codes: ["back-office"] }], next_cursor: null, total_count: 1, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks_across_channels", {
      channel_names: ["0240-mana-dev", "9960-back-office"], query: "請求", status: "pending", priority: "high",
      assignee_person_id: "person-1", cursor: "cursor-1", limit: 12,
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total_count: 1, scope: { mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"], project_codes: ["mana", "back-office"] } });
  });
  it("keeps channel-id search compatible", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/api/companion/tasks/search");
      expect(url.searchParams.get("query")).toBe("契約");
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      return Response.json({ items: [], next_cursor: null, total_count: 0, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks_across_channels", {
      channel_ids: ["C_MANA", "C_ACCOUNTING"], query: "契約",
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: {
      mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"], project_codes: ["mana", "back-office"],
    } });
  });
  it("resolves canonical channel names and reports ids, names, and projects", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.searchParams.getAll("project_code")).toEqual(["mana", "back-office"]);
      return Response.json({ items: [], next_cursor: null, total_count: 0, count_status: "exact" });
    });
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks_across_channels", {
      channel_names: [" #0240-MANA-DEV ", "9960-back-office"],
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: {
      mode: "authorized_channels", channel_ids: ["C_MANA", "C_ACCOUNTING"],
      channel_names: ["0240-mana-dev", "9960-back-office"],
      channels: [
        { channel_id: "C_MANA", channel_name: "0240-mana-dev", project_codes: ["mana"] },
        { channel_id: "C_ACCOUNTING", channel_name: "9960-back-office", project_codes: ["back-office"] },
      ],
    } });
  });
  it("keeps authorization after channel-name resolution", async () => {
    const restrictedPlacements = JSON.parse(placements) as Array<Record<string, unknown>>;
    restrictedPlacements[1].taskInventoryAllowedUserIds = ["UOTHER"];
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", {
      channel_names: ["9960-back-office"],
    }), { ...env, RUNTIME_PLACEMENTS_JSON: JSON.stringify(restrictedPlacements) });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { channel_names: ["unknown"] },
    { channel_names: ["0240-mana-dev", "#0240-MANA-DEV"] },
    { channel_names: ["0240-mana-dev"], channel_ids: ["C_MANA"] },
  ])("rejects invalid channel-name scope before upstream %#", async (args) => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", args), env);
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  async function expectCrossChannelScopeDenied(channel_ids: string[]) {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids }), env);
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  }
  it("rejects a channel outside the configured inventory scope before upstream", async () => {
    await expectCrossChannelScopeDenied(["C_OTHER"]);
  });
  it("rejects duplicate requested channels before upstream", async () => {
    await expectCrossChannelScopeDenied(["C_MANA", "C_MANA"]);
  });
  it("rejects an empty requested channel scope before upstream", async () => {
    await expectCrossChannelScopeDenied([]);
  });
  it("rejects an actor missing from a target task inventory audience", async () => {
    const restrictedPlacements = JSON.parse(placements) as Array<Record<string, unknown>>;
    restrictedPlacements[1].taskInventoryAllowedUserIds = ["UOTHER"];
    const restricted = JSON.stringify(restrictedPlacements);
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids: ["C_ACCOUNTING"] }), { ...env, RUNTIME_PLACEMENTS_JSON: restricted });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects ambiguous target channel placements before upstream", async () => {
    const ambiguousPlacements = JSON.parse(placements) as Array<Record<string, unknown>>;
    ambiguousPlacements.push({ placementId: "duplicate-accounting", channelId: "C_ACCOUNTING", projectCodes: ["duplicate"] });
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("list_tasks_across_channels", { channel_ids: ["C_ACCOUNTING"] }), {
      ...env, RUNTIME_PLACEMENTS_JSON: JSON.stringify(ambiguousPlacements),
    });
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("disables cross-channel search with the shared kill switch", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("search_tasks_across_channels", { channel_ids: ["C_MANA"], query: "x" }), { ...env, RUNTIME_TASK_SEARCH_ENABLED: "false" });
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects invalid count metadata instead of turning it into zero", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [], next_cursor: null, total_count: null, count_status: "exact" }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks", {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_invalid_response" });
  });
  it.each([
    [{ total_count: 12, count_status: "lower_bound" }, { total_count: 12, count_status: "lower_bound" }],
    [{ total_count: null, count_status: "unavailable" }, { total_count: null, count_status: "unavailable" }],
  ])("preserves non-exact count state %#", async (metadata, expected) => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items: [], next_cursor: null, ...metadata })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject(expected);
  });
  it("keeps an upstream API failure distinct from an empty result", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ code: "upstream" }, { status: 500 })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_failed" });
  });
  it("rejects a search result containing a project outside the placement", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["outside"] }], next_cursor: null, total_count: 1, count_status: "exact", has_more: false }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("search_tasks", { query: "x" }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_scope_violation" });
  });
  it("rejects a cross-channel result containing a project outside the authorized union", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [{ id: "t1", title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["outside"] }], next_cursor: null, total_count: 1, count_status: "exact" }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch)(await request("list_tasks_across_channels", { channel_ids: ["C_MANA", "C_ACCOUNTING"] }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_scope_violation" });
  });
  it("rejects an upstream page larger than the requested limit", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ id: `t${index}`, title: "x", status: "pending", priority: "medium", version: 1, project_codes: ["mana"] }));
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items, next_cursor: null })) as typeof fetch)(await request("list_tasks", { limit: 2 }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_upstream_invalid_response" });
  });
  it("forces partial when the upstream says complete but has a next page", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn(async () => Response.json({ items: [], next_cursor: "next", read_status: "complete" })) as typeof fetch)(await request("list_tasks", {}), env);
    expect(await response.json()).toMatchObject({ has_more: true, read_status: "partial" });
  });
  it("disables gateway search_tasks with the shared task search kill switch", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("search_tasks", { query: "x" }), { ...env, RUNTIME_TASK_SEARCH_ENABLED: "false" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "gateway_tool_disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects delivery outside the placement", async () => {
    const fetchImpl = vi.fn();
    const response = await createRuntimeGatewayProxyHandler(fetchImpl)(await request("send_message", { connector: "slack", channel: "C_OTHER", text: "x" }), env);
    expect(response.status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("routes an authorized Slack delivery through the canonical tenant delivery port", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("direct_slack_fetch_forbidden"); });
    const deliverSlackMessage = vi.fn(async () => ({ channel: "C_MANA", ts: "2.0" }));
    const response = await createRuntimeGatewayProxyHandler(fetchImpl as typeof fetch, {
      deliverSlackMessage,
    })(await request("send_message", {
      connector: "slack", channel: "C_MANA", thread: "1.0", text: "  完了しました  ",
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, channel: "C_MANA", ts: "2.0" });
    expect(deliverSlackMessage).toHaveBeenCalledWith({
      requestId: "Ev1", callIndex: 1, channel: "C_MANA", threadTs: "1.0", text: "完了しました",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects a capability for a non-operator", async () => {
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_tasks", {}, capability("UOTHER")), env);
    expect(response.status).toBe(403);
  });
  it("lists employees without persona and returns an exact employee", async () => {
    const listPlacement = placements.replace('"search_tasks_across_channels","send_message"', '"search_tasks_across_channels","send_message","list_employees","get_employee"');
    const list = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_employees", {}), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await list.json()).toEqual({ employees: [{ name: "critical-reviewer", model: "opus" }] });
    const get = await createRuntimeGatewayProxyHandler(vi.fn())(await request("get_employee", { name: "critical-reviewer" }), { ...env, RUNTIME_PLACEMENTS_JSON: listPlacement });
    expect(await get.json()).toEqual({ name: "critical-reviewer", persona: "private instructions", model: "opus" });
  });
  it("reads sessions only from the placement registry object", async () => {
    const sessionPlacement = placements.replace('"search_tasks_across_channels","send_message"', '"search_tasks_across_channels","send_message","list_sessions","get_session"');
    const fetch = vi.fn(async () => Response.json({ sessions: [{ sessionId: "s1", placementId: "mana-dev-biz" }] }));
    const registry = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch })) };
    const response = await createRuntimeGatewayProxyHandler(vi.fn())(await request("list_sessions", { status: "active" }), { ...env, RUNTIME_PLACEMENTS_JSON: sessionPlacement, RUNTIME_SESSION_REGISTRY: registry });
    expect(response.status).toBe(200);
    expect(registry.idFromName).toHaveBeenCalledWith("mana-dev-biz");
    expect(fetch).toHaveBeenCalledWith("https://session-registry.internal/sessions?status=active");
  });
});
