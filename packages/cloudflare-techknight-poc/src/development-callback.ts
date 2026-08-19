import type { RuntimePlacement } from "./runtime-config.js";
import type { SlackQueueEvent } from "./types.js";
import type { QuotaDecision } from "./multitenancy/contracts.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";
import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";

export type DevelopmentStatus = "completed" | "needs_decision" | "needs_input" | "failed" | "timed_out";
export interface DevelopmentCallbackPayload {
  job_id: string; event_id: string; placement_id: string; workspace_id: string; channel_id: string;
  thread_ts: string; requester_id: string; status: DevelopmentStatus; summary: string;
  quota_decision: QuotaDecision["decision"];
  story_id?: string; pr_url?: string;
}

export type DevelopmentCallbackDelivery =
  | { state: "delivered"; responseTs: string }
  | { state: "failed" };

export type DevelopmentCallbackClaim =
  | { state: "claimed"; fence?: number }
  | { state: "in_progress" }
  | { state: "accounting_pending"; delivery: DevelopmentCallbackDelivery; fence?: number }
  | { state: "completed"; delivery?: DevelopmentCallbackDelivery; fence?: number }
  | { state: "conflict" };

export async function developmentCallbackPayloadHash(payload: DevelopmentCallbackPayload): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(payload)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length); let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
export function parseDevelopmentCallbackPayload(value: unknown): DevelopmentCallbackPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  for (const key of ["job_id", "event_id", "placement_id", "workspace_id", "channel_id", "thread_ts", "requester_id", "status", "summary"] as const) {
    if (typeof p[key] !== "string" || !p[key]) return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(p.job_id as string)
    || !["completed", "needs_decision", "needs_input", "failed", "timed_out"].includes(p.status as string)
    || !["allowed", "warning"].includes(p.quota_decision as string)) return undefined;
  if ((p.summary as string).length > 12_000) return undefined;
  if (p.story_id !== undefined && (typeof p.story_id !== "string" || p.story_id.length > 200)) return undefined;
  if (p.pr_url !== undefined) {
    if (typeof p.pr_url !== "string") return undefined;
    try { const url = new URL(p.pr_url); if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined; } catch { return undefined; }
  }
  return p as unknown as DevelopmentCallbackPayload;
}
function render(payload: DevelopmentCallbackPayload): string {
  return [`Development: ${payload.status}`,
    payload.story_id ? `Story: ${escapeUntrustedSlackMrkdwn(payload.story_id)}` : undefined,
    payload.pr_url ? `PR: ${payload.pr_url}` : undefined,
    escapeUntrustedSlackMrkdwn(payload.summary),
  ].filter(Boolean).join("\n");
}

export async function handleDevelopmentCallback(request: Request, options: {
  token?: string; placements: readonly RuntimePlacement[];
  resolve(event: SlackQueueEvent): Promise<SlackQueueEvent>;
  claim(event: SlackQueueEvent, payload: DevelopmentCallbackPayload): Promise<DevelopmentCallbackClaim>;
  recordDelivery(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void>;
  complete(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void>;
  release(eventId: string, payload: DevelopmentCallbackPayload, fence?: number): Promise<void>;
  post(event: SlackQueueEvent, text: string): Promise<string>;
}): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!options.token || !safeEqual(bearer, options.token)) return Response.json({ error: "development_callback_unauthorized" }, { status: 401 });
  const payload = parseDevelopmentCallbackPayload(await request.json().catch(() => undefined));
  if (!payload) return Response.json({ error: "development_callback_invalid" }, { status: 400 });
  const placement = options.placements.find((candidate) => candidate.placementId === payload.placement_id);
  const allowed = placement?.developmentEnabled === true
    && placement.channelId === payload.channel_id && placement.audience?.allowedUserIds.includes(payload.requester_id) &&
    placement.deliveryScopes?.some((scope) => scope.connector === "slack" && scope.channelId === payload.channel_id);
  if (!allowed) return Response.json({ error: "development_callback_forbidden" }, { status: 403 });
  const callbackEventId = `development:${payload.job_id}`;
  const unresolvedEvent: SlackQueueEvent = { tenantId: "", eventId: callbackEventId, workspaceId: payload.workspace_id,
    channelId: payload.channel_id, threadTs: payload.thread_ts, messageTs: payload.thread_ts, userId: payload.requester_id,
    eventType: "development_result", text: "", receivedAt: new Date().toISOString() };
  const event = await options.resolve(unresolvedEvent);
  if (!event.tenantId || event.eventId !== unresolvedEvent.eventId || event.workspaceId !== unresolvedEvent.workspaceId
    || event.channelId !== unresolvedEvent.channelId || event.threadTs !== unresolvedEvent.threadTs
    || event.userId !== unresolvedEvent.userId) throw new Error("development_callback_tenant_scope_mismatch");
  const claim = await options.claim(event, payload);
  if (claim.state === "conflict") {
    return Response.json({ error: "development_callback_conflict" }, { status: 403 });
  }
  if (claim.state === "in_progress") {
    return Response.json({ error: "development_callback_in_progress" }, {
      status: 409,
      headers: { "retry-after": "2" },
    });
  }
  if (claim.state === "completed") {
    return Response.json({ ok: true, state: "completed", duplicate: true });
  }
  let delivery: DevelopmentCallbackDelivery;
  if (claim.state === "accounting_pending") {
    delivery = claim.delivery;
  } else {
    try {
      delivery = { state: "delivered", responseTs: await options.post(event, render(payload)) };
    } catch (error) {
      if (error instanceof TenantBoundaryError && error.code === "REPLY_OWNERSHIP_CONFLICT") {
        await options.release(callbackEventId, payload, claim.fence);
        return Response.json({ error: "development_callback_in_progress" }, {
          status: 409,
          headers: { "retry-after": "2" },
        });
      }
      delivery = { state: "failed" };
    }
    if (claim.fence === undefined) await options.recordDelivery(callbackEventId, payload, delivery);
    else await options.recordDelivery(callbackEventId, payload, delivery, claim.fence);
  }
  if (claim.fence === undefined) await options.complete(callbackEventId, payload, delivery);
  else await options.complete(callbackEventId, payload, delivery, claim.fence);
  return Response.json({ ok: true, state: "completed" });
}
