import { TenantBoundaryError } from "./errors.js";
import type { WorkspaceConnectionSnapshot } from "./contracts.js";
import type { SlackInstallationLifecycleEvent } from "./workspace-connection.js";

interface SlackInstallationLifecycleAdapter {
  apply(event: SlackInstallationLifecycleEvent): Promise<WorkspaceConnectionSnapshot>;
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function scopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every((scope) => nonEmptyString(scope, 128))
    && new Set(value).size === value.length;
}

function parseLifecycleEvent(value: unknown): SlackInstallationLifecycleEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (!nonEmptyString(event.kind, 64) || !nonEmptyString(event.expected_revision, 128)) return undefined;
  // Public OAuth callbacks must pass the single-use installation-intent boundary.
  // This authenticated lifecycle endpoint is only for post-installation revisions.
  if (event.kind === "oauth_callback") return undefined;
  if (event.kind === "reauthorized") {
    if (!exactKeys(event, ["kind", "connection_id", "expected_revision", "installation_id", "installer_id",
      "granted_scopes"])
      || !nonEmptyString(event.connection_id, 128) || !nonEmptyString(event.installation_id, 256)
      || !nonEmptyString(event.installer_id, 128) || !scopes(event.granted_scopes)) return undefined;
    return event as unknown as SlackInstallationLifecycleEvent;
  }
  if (event.kind === "scope_changed") {
    if (!exactKeys(event, ["kind", "connection_id", "expected_revision", "granted_scopes"])
      || !nonEmptyString(event.connection_id, 128) || !scopes(event.granted_scopes)) return undefined;
    return event as unknown as SlackInstallationLifecycleEvent;
  }
  if (event.kind === "app_uninstalled" || event.kind === "tokens_revoked") {
    if (!exactKeys(event, ["kind", "connection_id", "expected_revision"])
      || !nonEmptyString(event.connection_id, 128)) return undefined;
    return event as unknown as SlackInstallationLifecycleEvent;
  }
  return undefined;
}

export async function handleSlackInstallationLifecycleRequest(request: Request, options: {
  token?: string;
  adapter: SlackInstallationLifecycleAdapter;
}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (!options.token?.trim()) {
    return Response.json({ error: "slack_installation_lifecycle_unavailable" }, { status: 503 });
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!safeEqual(bearer, options.token)) {
    return Response.json({ error: "slack_installation_lifecycle_unauthorized" }, { status: 401 });
  }
  const event = parseLifecycleEvent(await request.json().catch(() => undefined));
  if (!event) return Response.json({ error: "slack_installation_lifecycle_invalid" }, { status: 400 });
  try {
    const snapshot = await options.adapter.apply(event);
    return Response.json({ ok: true, workspace_connection: snapshot });
  } catch (error) {
    const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
    const status = code === "WORKSPACE_CONNECTION_STALE_REVISION" ? 409 : 503;
    return Response.json({ error: code }, { status });
  }
}
