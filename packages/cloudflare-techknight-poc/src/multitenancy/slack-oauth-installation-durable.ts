import {
  type SlackInstallationIntent,
  type SlackInstallationIntentPort,
  SlackInstallationIntentStore,
  type SlackInstallationIntentStorage,
} from "./slack-oauth-installation-state.js";
import { TenantBoundaryError } from "./errors.js";

const HOST = "slack-installation-intent.internal";

type DurableObjectStubLike = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export interface SlackInstallationIntentNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

function stateHashFrom(value: SlackInstallationIntent | { state_hash: string }): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value.state_hash)) throw new Error("installation_state_invalid");
  return value.state_hash;
}

async function call<T>(namespace: SlackInstallationIntentNamespace, stateHash: string,
  operation: "create" | "claim", payload: unknown): Promise<T> {
  const stub = namespace.get(namespace.idFromName(stateHash));
  const response = await stub.fetch(`https://${HOST}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => undefined) as { result?: T; error?: string } | undefined;
  if (!response.ok || !body || !("result" in body)) {
    throw new TenantBoundaryError("slack_oauth", body?.error ?? "INSTALLATION_STATE_UNAVAILABLE");
  }
  return body.result as T;
}

export function createDurableSlackInstallationIntentClient(
  namespace: SlackInstallationIntentNamespace,
): SlackInstallationIntentPort {
  return {
    async create(intent) {
      await call(namespace, stateHashFrom(intent), "create", intent);
    },
    claim(input) {
      return call(namespace, stateHashFrom(input), "claim", input);
    },
  };
}

export class SlackInstallationIntentHandler {
  readonly #store: SlackInstallationIntentStore;

  constructor(storage: SlackInstallationIntentStorage) {
    this.#store = new SlackInstallationIntentStore(storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== HOST || request.method !== "POST") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const body = await request.json().catch(() => undefined);
    try {
      if (url.pathname === "/create") {
        await this.#store.create(body as SlackInstallationIntent);
        return Response.json({ result: null });
      }
      if (url.pathname === "/claim") {
        return Response.json({ result: await this.#store.claim(body as {
          state_hash: string; nonce_hash: string; now: string;
        }) });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const code = error instanceof TenantBoundaryError
        ? error.code
        : "INSTALLATION_STATE_INVALID";
      return Response.json({ error: code }, { status: 409 });
    }
  }
}

export function isSlackInstallationIntentRequest(request: Request): boolean {
  return new URL(request.url).hostname === HOST;
}
