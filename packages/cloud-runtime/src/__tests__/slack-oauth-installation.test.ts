import { describe, expect, it, vi } from "vitest";
import {
  handleSlackOAuthCallbackRequest,
  handleSlackOAuthStartRequest,
  type SlackInstallationAuthorizationPort,
} from "../multitenancy/slack-oauth-installation.js";
import {
  SlackInstallationIntentStore,
  type SlackInstallationIntentStorage,
  type SlackInstallationIntentTransaction,
} from "../multitenancy/slack-oauth-installation-state.js";
import {
  createDurableSlackInstallationIntentClient,
  SlackInstallationIntentHandler,
} from "../multitenancy/slack-oauth-installation-durable.js";

class MemoryStorage implements SlackInstallationIntentStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async transaction<T>(callback: (transaction: SlackInstallationIntentTransaction) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const binding = {
  installation_intent_id: "insi_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  app_id: "A-MANA",
  expected_workspace_id: "T-A",
  expected_enterprise_id: "E-A",
  initiated_by_person_id: "per_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  expected_connection_revision: "0",
} as const;

const snapshot = {
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "1",
  tenant_id: binding.tenant_id,
  installation_id: "I-A",
  workspace_id: "T-A",
  enterprise_id: "E-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["app_mentions:read", "chat:write"],
  status: "active" as const,
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud" as const,
  credential_mode: "customer_oauth" as const,
  contract_revision: "11",
};

function startRequest(): Request {
  return new Request("https://worker.invalid/slack/installations/oauth/start", {
    method: "POST",
    headers: { authorization: "Bearer admin-session" },
  });
}

describe("Slack OAuth installation boundary", () => {
  it("stores only hashes for a short-lived single-use intent authorized by the control plane", async () => {
    const storage = new MemoryStorage();
    const authorize = vi.fn(async () => binding);
    const randomValues = [new Uint8Array(16).fill(0x11), new Uint8Array(16).fill(0x22)];
    const response = await handleSlackOAuthStartRequest(startRequest(), {
      authorizer: { authorize } satisfies SlackInstallationAuthorizationPort,
      intents: new SlackInstallationIntentStore(storage),
      app_id: "A-MANA",
      client_id: "123.456",
      redirect_uri: "https://worker.invalid/slack/installations/oauth/callback",
      scopes: ["app_mentions:read", "chat:write"],
      now: () => Date.parse("2026-08-19T01:00:00.000Z"),
      random_bytes: () => randomValues.shift()!,
    });

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.any(Request));
    const body = await response.json() as { authorize_url: string; expires_at: string };
    const authorizeUrl = new URL(body.authorize_url);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorizeUrl.searchParams.get("state")?.split(".")).toHaveLength(2);
    expect(body.expires_at).toBe("2026-08-19T01:10:00.000Z");
    const persisted = JSON.stringify([...storage.values.values()]);
    expect(persisted).toContain("sha256:");
    expect(persisted).toContain(binding.tenant_id);
    expect(persisted).not.toContain(authorizeUrl.searchParams.get("state")!);
    expect(persisted).not.toContain("admin-session");
  });

  it("atomically consumes state before exchange and rejects its replay", async () => {
    const storage = new MemoryStorage();
    const intents = new SlackInstallationIntentStore(storage);
    const randomValues = [new Uint8Array(16).fill(0x33), new Uint8Array(16).fill(0x44)];
    const start = await handleSlackOAuthStartRequest(startRequest(), {
      authorizer: { authorize: async () => binding }, intents, app_id: "A-MANA", client_id: "123.456",
      redirect_uri: "https://worker.invalid/slack/installations/oauth/callback", scopes: ["chat:write"],
      now: () => Date.parse("2026-08-19T01:00:00.000Z"), random_bytes: () => randomValues.shift()!,
    });
    const state = new URL((await start.json() as { authorize_url: string }).authorize_url).searchParams.get("state")!;
    const events: string[] = [];
    const exchange_and_register = vi.fn(async () => {
      events.push("exchange");
      const consumed = JSON.stringify([...storage.values.values()]);
      expect(consumed).toContain("consumed_at");
      return snapshot;
    });
    const callback = () => handleSlackOAuthCallbackRequest(new Request(
      `https://worker.invalid/slack/installations/oauth/callback?code=opaque-code&state=${encodeURIComponent(state)}`,
    ), { intents, control_plane: { exchange_and_register }, now: () => Date.parse("2026-08-19T01:00:01.000Z") });

    await expect(callback()).resolves.toMatchObject({ status: 200 });
    await expect(callback()).resolves.toMatchObject({ status: 409 });
    expect(exchange_and_register).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["exchange"]);
  });

  it("rejects expired and nonce-mismatched callbacks before code exchange", async () => {
    const storage = new MemoryStorage();
    const intents = new SlackInstallationIntentStore(storage);
    const randomValues = [new Uint8Array(16).fill(0x55), new Uint8Array(16).fill(0x66)];
    const start = await handleSlackOAuthStartRequest(startRequest(), {
      authorizer: { authorize: async () => binding }, intents, app_id: "A-MANA", client_id: "123.456",
      redirect_uri: "https://worker.invalid/slack/installations/oauth/callback", scopes: ["chat:write"],
      ttl_seconds: 1, now: () => Date.parse("2026-08-19T01:00:00.000Z"),
      random_bytes: () => randomValues.shift()!,
    });
    const state = new URL((await start.json() as { authorize_url: string }).authorize_url).searchParams.get("state")!;
    const [stateValue] = state.split(".");
    const exchange_and_register = vi.fn();
    const mismatch = await handleSlackOAuthCallbackRequest(new Request(
      `https://worker.invalid/slack/installations/oauth/callback?code=x&state=${stateValue}.wrong-nonce`,
    ), { intents, control_plane: { exchange_and_register }, now: () => Date.parse("2026-08-19T01:00:00.500Z") });
    const expired = await handleSlackOAuthCallbackRequest(new Request(
      `https://worker.invalid/slack/installations/oauth/callback?code=x&state=${encodeURIComponent(state)}`,
    ), { intents, control_plane: { exchange_and_register }, now: () => Date.parse("2026-08-19T01:00:02.000Z") });

    expect(mismatch.status).toBe(400);
    expect(expired.status).toBe(410);
    expect(exchange_and_register).not.toHaveBeenCalled();
  });

  it("fails closed when tenant-admin authorization or returned binding is invalid", async () => {
    const intents = new SlackInstallationIntentStore(new MemoryStorage());
    const unauthorized = await handleSlackOAuthStartRequest(startRequest(), {
      authorizer: { authorize: async () => { throw new Error("tenant_admin_mismatch"); } },
      intents, app_id: "A-MANA", client_id: "123.456", redirect_uri: "https://worker.invalid/callback", scopes: ["chat:write"],
    });
    const malformed = await handleSlackOAuthStartRequest(startRequest(), {
      authorizer: { authorize: async () => ({ ...binding, app_id: "" }) },
      intents, app_id: "A-MANA", client_id: "123.456", redirect_uri: "https://worker.invalid/callback", scopes: ["chat:write"],
    });

    expect(unauthorized.status).toBe(403);
    expect(malformed.status).toBe(409);
  });

  it("uses the state hash to address one Durable Object and preserves atomic replay protection", async () => {
    const handler = new SlackInstallationIntentHandler(new MemoryStorage());
    const addressed: string[] = [];
    const client = createDurableSlackInstallationIntentClient({
      idFromName(name) { addressed.push(name); return name; },
      get() { return { fetch: (input, init) => handler.fetch(new Request(input, init)) }; },
    });
    const state_hash = `sha256:${"a".repeat(64)}`;
    const nonce_hash = `sha256:${"b".repeat(64)}`;
    await client.create({
      ...binding, state_hash, nonce_hash,
      issued_at: "2026-08-19T01:00:00.000Z",
      expires_at: "2026-08-19T01:10:00.000Z",
      consumed_at: null,
    });
    await expect(client.claim({ state_hash, nonce_hash, now: "2026-08-19T01:00:01.000Z" }))
      .resolves.toMatchObject({ consumed_at: "2026-08-19T01:00:01.000Z" });
    await expect(client.claim({ state_hash, nonce_hash, now: "2026-08-19T01:00:02.000Z" }))
      .rejects.toThrow("INSTALLATION_STATE_REPLAYED");
    expect(addressed).toEqual([state_hash, state_hash, state_hash]);
  });
});
