import { createHash } from "node:crypto";
import { verifySlackRequest } from "./slack.js";
import { readSlackRequestBody, slackRequestBodyErrorResponse } from "./slack-request-body.js";
import {
  MANA_IMPROVEMENT_VIEW_CALLBACK_ID,
  buildManaImprovementAcceptanceMessage,
  buildManaImprovementModal,
  extractManaImprovementRequestFromView,
  type ManaImprovementRequest,
} from "./mana-improvement-request.js";

const SLACK_ID_RE = /^[A-Z0-9_-]{2,64}$/;
const MAX_PRIVATE_METADATA_CHARS = 2_900;

export interface ManaImprovementModalMetadata {
  workspaceId: string;
  channelId: string;
  requesterId: string;
  command: string;
}

export interface ManaImprovementSubmission {
  eventId: string;
  appId: string;
  workspaceId: string;
  channelId: string;
  requesterId: string;
  interactionThreadTs: string;
  request: ManaImprovementRequest;
  receivedAt: string;
}

interface SlackApiPayload {
  ok?: unknown;
  error?: unknown;
  ts?: unknown;
}

function response(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function parseMetadata(value: unknown): ManaImprovementModalMetadata | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PRIVATE_METADATA_CHARS) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Partial<ManaImprovementModalMetadata>;
  if (!SLACK_ID_RE.test(candidate.workspaceId ?? "")
    || !SLACK_ID_RE.test(candidate.channelId ?? "")
    || !SLACK_ID_RE.test(candidate.requesterId ?? "")
    || typeof candidate.command !== "string"
    || !["/vibepro", "/ryoko-develop"].includes(candidate.command)) return undefined;
  return candidate as ManaImprovementModalMetadata;
}

export function manaImprovementModalMetadata(input: ManaImprovementModalMetadata): string {
  const metadata = parseMetadata(JSON.stringify(input));
  if (!metadata) throw new Error("mana_improvement_metadata_invalid");
  return JSON.stringify(metadata);
}

async function slackJson(
  fetchImpl: typeof fetch,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackApiPayload> {
  const result = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await result.json().catch(() => null) as SlackApiPayload | null;
  if (!result.ok || payload?.ok !== true) {
    const code = typeof payload?.error === "string" ? payload.error : `http_${result.status}`;
    throw new Error(`slack_${method.replace(/\./g, "_")}_failed:${code}`);
  }
  return payload;
}

export async function openManaImprovementModal(input: {
  fetchImpl: typeof fetch;
  triggerId: string;
  metadata: ManaImprovementModalMetadata;
  initialProblem?: string;
}): Promise<string> {
  if (!input.triggerId || input.triggerId.length > 255) throw new Error("mana_improvement_trigger_invalid");
  await slackJson(input.fetchImpl, "views.open", {
    trigger_id: input.triggerId,
    view: buildManaImprovementModal({
      privateMetadata: manaImprovementModalMetadata(input.metadata),
      initialProblem: input.initialProblem,
    }),
  });
  return input.triggerId;
}

export async function postManaImprovementAcceptance(input: {
  fetchImpl: typeof fetch;
  channelId: string;
  requesterId: string;
  request: ManaImprovementRequest;
}): Promise<string> {
  const message = buildManaImprovementAcceptanceMessage(input.request, input.requesterId);
  const payload = await slackJson(input.fetchImpl, "chat.postMessage", {
    channel: input.channelId,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (typeof payload.ts !== "string" || !payload.ts) throw new Error("slack_acceptance_ts_missing");
  return payload.ts;
}

async function interactionEventId(body: string): Promise<string> {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `mana_improvement_${digest}`;
}

export interface ManaImprovementInteractionOptions {
  signingSecret: string;
  expectedAppId?: string;
  placements: ReadonlyArray<{ channelId: string; allowedUserIds: readonly string[] }>;
  nowMs?: number;
  accept(submission: ManaImprovementSubmission): Promise<void>;
  defer?(work: Promise<void>): void;
  onDeferredError?(error: unknown, submission: ManaImprovementSubmission): void;
}

/**
 * Handles only Mana improvement view submissions. Returns null for every
 * other Slack interaction so the existing meeting/task interaction handler
 * can process the original, still-unconsumed Request.
 */
export async function handleManaImprovementInteraction(
  request: Request,
  options: ManaImprovementInteractionOptions,
): Promise<Response | null> {
  let body: string;
  try {
    body = await readSlackRequestBody(request);
  } catch (error) {
    const rejected = slackRequestBodyErrorResponse(error);
    if (rejected) return rejected;
    throw error;
  }
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const verified = await verifySlackRequest({
    body,
    timestamp,
    signature,
    signingSecret: options.signingSecret,
    nowMs: options.nowMs,
  });
  if (!verified) return response("slack_signature_invalid", 401);

  const encoded = new URLSearchParams(body).get("payload");
  if (!encoded) return response("slack_interaction_invalid", 400);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return response("slack_interaction_invalid", 400);
    payload = parsed as Record<string, unknown>;
  } catch {
    return response("slack_interaction_invalid", 400);
  }
  const view = payload.view && typeof payload.view === "object" && !Array.isArray(payload.view)
    ? payload.view as Record<string, unknown>
    : undefined;
  if (view?.callback_id !== MANA_IMPROVEMENT_VIEW_CALLBACK_ID) return null;

  const team = payload.team && typeof payload.team === "object" && !Array.isArray(payload.team)
    ? payload.team as Record<string, unknown>
    : {};
  const user = payload.user && typeof payload.user === "object" && !Array.isArray(payload.user)
    ? payload.user as Record<string, unknown>
    : {};
  const workspaceId = typeof team.id === "string" ? team.id : "";
  const requesterId = typeof user.id === "string" ? user.id : "";
  const appId = typeof payload.api_app_id === "string" ? payload.api_app_id : "";
  const viewId = typeof view.id === "string" ? view.id : "";
  const metadata = parseMetadata(view.private_metadata);
  if (!metadata || metadata.workspaceId !== workspaceId || metadata.requesterId !== requesterId
    || !viewId || !SLACK_ID_RE.test(workspaceId) || !SLACK_ID_RE.test(requesterId)
    || (options.expectedAppId && appId !== options.expectedAppId)) {
    return response("mana_improvement_scope_invalid", 403);
  }
  const placement = options.placements.find((candidate) => candidate.channelId === metadata.channelId);
  if (!placement?.allowedUserIds.includes(requesterId)) {
    return response("mana_improvement_forbidden", 403);
  }

  const state = view.state && typeof view.state === "object" && !Array.isArray(view.state)
    ? view.state as { values?: unknown }
    : {};
  const values = state.values && typeof state.values === "object" && !Array.isArray(state.values)
    ? state.values as Record<string, Record<string, unknown>>
    : {};
  let improvement: ManaImprovementRequest;
  try {
    improvement = extractManaImprovementRequestFromView(values);
  } catch (error) {
    const code = error instanceof Error ? error.message : "mana_improvement_invalid";
    const blockId = code === "mana_improvement_outcome_required"
      ? "mana_improvement_outcome"
      : "mana_improvement_problem";
    return Response.json({
      response_action: "errors",
      errors: { [blockId]: "必須項目を入力してください。" },
    });
  }

  const receivedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const submission: ManaImprovementSubmission = {
    eventId: await interactionEventId(body),
    appId,
    workspaceId,
    channelId: metadata.channelId,
    requesterId,
    interactionThreadTs: viewId,
    request: improvement,
    receivedAt,
  };
  const work = options.accept(submission).catch((error) => {
    options.onDeferredError?.(error, submission);
  });
  if (options.defer) {
    options.defer(work);
  } else {
    await work;
  }
  return new Response("", { status: 200 });
}
