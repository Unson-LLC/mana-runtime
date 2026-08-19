import type { WorkspaceConnectionSnapshot } from "./contracts.js";
import { TenantBoundaryError } from "./errors.js";
import type {
  SlackInstallationAuthorizationPort,
  SlackInstallationControlPlanePort,
} from "./slack-oauth-installation.js";
import type { SlackInstallationBinding } from "./slack-oauth-installation-state.js";

const CONTROL_PLANE_ORIGIN = "https://slack-installation-control-plane.internal";
const MAX_RESPONSE_BYTES = 64 * 1024;

type ResultEnvelope<T> = { result: T };

export interface SlackInstallationControlPlaneFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function upstreamError(status: number): TenantBoundaryError {
  const code = status === 401 || status === 403
    ? "INSTALLATION_AUTHORIZATION_REQUIRED"
    : status === 409
      ? "WORKSPACE_CONNECTION_CONFLICT"
      : "UPSTREAM_UNAVAILABLE";
  return new TenantBoundaryError("slack_oauth", code);
}

async function readResult<T>(response: Response): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw upstreamError(response.status);
  }
  const text = await response.text();
  if (!response.ok || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw upstreamError(response.status);
  }
  try {
    const body = JSON.parse(text) as Partial<ResultEnvelope<T>>;
    if (!("result" in body)) throw new Error("missing_result");
    return body.result as T;
  } catch {
    throw upstreamError(503);
  }
}

async function post<T>(fetcher: SlackInstallationControlPlaneFetcher, path: string, body: unknown,
  authorization?: string): Promise<T> {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (authorization) headers.set("authorization", authorization);
  const response = await fetcher.fetch(`${CONTROL_PLANE_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return readResult<T>(response);
}

export function createSlackInstallationControlPlaneClient(
  fetcher: SlackInstallationControlPlaneFetcher,
  appId: string,
): SlackInstallationAuthorizationPort & SlackInstallationControlPlanePort {
  return {
    async authorize(request) {
      const authorization = request.headers.get("authorization");
      if (!authorization || authorization.length > 8_192 || /[\r\n]/.test(authorization)) {
        throw new TenantBoundaryError("slack_oauth", "INSTALLATION_AUTHORIZATION_REQUIRED");
      }
      return post<SlackInstallationBinding>(
        fetcher,
        "/api/v1/slack-installations:authorize",
        { app_id: appId },
        authorization,
      );
    },
    exchange_and_register(input) {
      return post<WorkspaceConnectionSnapshot>(
        fetcher,
        "/api/v1/slack-installations:exchange-and-register",
        input,
      );
    },
  };
}
