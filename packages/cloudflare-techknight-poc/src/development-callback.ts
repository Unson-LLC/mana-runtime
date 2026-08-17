import type { RuntimePlacement } from "./runtime-config.js";
import type { SlackQueueEvent } from "./types.js";

type DevelopmentStatus = "completed" | "needs_decision" | "needs_input" | "failed";
interface DevelopmentCallbackPayload {
  job_id: string; event_id: string; placement_id: string; workspace_id: string; channel_id: string;
  thread_ts: string; requester_id: string; status: DevelopmentStatus; summary: string;
  story_id?: string; pr_url?: string;
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length); let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
function parsePayload(value: unknown): DevelopmentCallbackPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  for (const key of ["job_id", "event_id", "placement_id", "workspace_id", "channel_id", "thread_ts", "requester_id", "status", "summary"] as const) {
    if (typeof p[key] !== "string" || !p[key]) return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(p.job_id as string) || !["completed", "needs_decision", "needs_input", "failed"].includes(p.status as string)) return undefined;
  if ((p.summary as string).length > 12_000) return undefined;
  if (p.story_id !== undefined && (typeof p.story_id !== "string" || p.story_id.length > 200)) return undefined;
  if (p.pr_url !== undefined) {
    if (typeof p.pr_url !== "string") return undefined;
    try { const url = new URL(p.pr_url); if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined; } catch { return undefined; }
  }
  return p as unknown as DevelopmentCallbackPayload;
}
function render(payload: DevelopmentCallbackPayload): string {
  return [`Development: ${payload.status}`, payload.story_id ? `Story: ${payload.story_id}` : undefined,
    payload.pr_url ? `PR: ${payload.pr_url}` : undefined, payload.summary].filter(Boolean).join("\n");
}

export async function handleDevelopmentCallback(request: Request, options: {
  token?: string; workspaceId: string; placements: readonly RuntimePlacement[];
  resolve(event: SlackQueueEvent): Promise<SlackQueueEvent>;
  claim(event: SlackQueueEvent, payload: DevelopmentCallbackPayload): Promise<boolean>;
  complete(eventId: string, responseTs: string, payload: DevelopmentCallbackPayload): Promise<void>;
  release(eventId: string, payload: DevelopmentCallbackPayload): Promise<void>;
  post(event: SlackQueueEvent, text: string): Promise<string>;
}): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!options.token || !safeEqual(bearer, options.token)) return Response.json({ error: "development_callback_unauthorized" }, { status: 401 });
  const payload = parsePayload(await request.json().catch(() => undefined));
  if (!payload) return Response.json({ error: "development_callback_invalid" }, { status: 400 });
  const placement = options.placements.find((candidate) => candidate.placementId === payload.placement_id);
  const allowed = placement?.developmentEnabled === true && payload.workspace_id === options.workspaceId &&
    placement.channelId === payload.channel_id && placement.audience?.allowedUserIds.includes(payload.requester_id) &&
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
  if (!await options.claim(event, payload)) return Response.json({ ok: true, duplicate: true });
  try {
    const responseTs = await options.post(event, render(payload));
    await options.complete(callbackEventId, responseTs, payload);
    return Response.json({ ok: true });
  } catch (error) {
    await options.release(callbackEventId, payload);
    throw error;
  }
}
