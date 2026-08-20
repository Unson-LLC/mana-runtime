import type { RuntimePlacement } from "./runtime-config.js";
import type { SlackQueueEvent } from "./types.js";
import type { QuotaDecision } from "./multitenancy/contracts.js";
import { jcsCanonicalize } from "./multitenancy/jcs.js";
import { TenantBoundaryError } from "./multitenancy/errors.js";
import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";

export type DevelopmentStatus = "progress" | "completed" | "needs_decision" | "needs_input" | "failed" | "timed_out";
export type DevelopmentProgressPhase = "analyzing" | "implementing" | "verifying";

export interface DevelopmentProgressPayload {
  phase: DevelopmentProgressPhase;
  elapsed_sec: number;
  commits: number;
  latest?: string;
}

export interface DevelopmentQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface DevelopmentQuestion {
  id: string;
  question: string;
  options: DevelopmentQuestionOption[];
  allow_free_text: boolean;
}

export interface DevelopmentGate {
  severity: "critical" | "evidence";
  text: string;
}

export interface DevelopmentCommits {
  count: number;
  subjects: string[];
}

export interface DevelopmentCallbackPayload {
  job_id: string;
  event_id: string;
  placement_id: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  requester_id: string;
  status: DevelopmentStatus;
  summary: string;
  quota_decision: QuotaDecision["decision"];
  story_id?: string;
  pr_url?: string;
  progress?: DevelopmentProgressPayload;
  questions?: DevelopmentQuestion[];
  gates?: DevelopmentGate[];
  commits?: DevelopmentCommits;
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

export interface DevelopmentSlackMessage {
  text: string;
  blocks: unknown[];
}

export async function developmentCallbackPayloadHash(payload: DevelopmentCallbackPayload): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(payload)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function parseProgress(value: unknown): DevelopmentProgressPayload | undefined {
  const progress = record(value);
  if (!progress || !["analyzing", "implementing", "verifying"].includes(String(progress.phase))) return undefined;
  if (!Number.isInteger(progress.elapsed_sec) || Number(progress.elapsed_sec) < 0 || Number(progress.elapsed_sec) > 86_400) return undefined;
  if (!Number.isInteger(progress.commits) || Number(progress.commits) < 0 || Number(progress.commits) > 10_000) return undefined;
  const latest = progress.latest === undefined ? undefined : boundedString(progress.latest, 200);
  if (progress.latest !== undefined && !latest) return undefined;
  return {
    phase: progress.phase as DevelopmentProgressPhase,
    elapsed_sec: Number(progress.elapsed_sec),
    commits: Number(progress.commits),
    ...(latest ? { latest } : {}),
  };
}

function parseQuestions(value: unknown): DevelopmentQuestion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
  const ids = new Set<string>();
  const questions: DevelopmentQuestion[] = [];
  for (const raw of value) {
    const question = record(raw);
    const id = boundedString(question?.id, 64);
    const text = boundedString(question?.question, 300);
    if (!id || !/^[a-z0-9_-]+$/i.test(id) || ids.has(id) || !text || !Array.isArray(question?.options)
      || question.options.length > 5 || typeof question.allow_free_text !== "boolean") return undefined;
    ids.add(id);
    const options: DevelopmentQuestionOption[] = [];
    for (const rawOption of question.options) {
      const option = record(rawOption);
      const label = boundedString(option?.label, 80);
      const description = option?.description === undefined ? undefined : boundedString(option.description, 200);
      if (!label || (option?.description !== undefined && !description)
        || (option?.recommended !== undefined && typeof option.recommended !== "boolean")) return undefined;
      options.push({
        label,
        ...(description ? { description } : {}),
        ...(typeof option.recommended === "boolean" ? { recommended: option.recommended } : {}),
      });
    }
    questions.push({ id, question: text, options, allow_free_text: question.allow_free_text });
  }
  return questions;
}

function parseGates(value: unknown): DevelopmentGate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return undefined;
  const gates: DevelopmentGate[] = [];
  for (const raw of value) {
    const gate = record(raw);
    const text = boundedString(gate?.text, 500);
    if (!text || (gate?.severity !== "critical" && gate?.severity !== "evidence")) return undefined;
    gates.push({ severity: gate.severity, text });
  }
  return gates;
}

function parseCommits(value: unknown): DevelopmentCommits | undefined {
  if (value === undefined) return undefined;
  const commits = record(value);
  if (!commits || !Number.isInteger(commits.count) || Number(commits.count) < 0 || Number(commits.count) > 10_000
    || !Array.isArray(commits.subjects) || commits.subjects.length > 5) return undefined;
  const subjects = commits.subjects.map((subject) => boundedString(subject, 200));
  if (subjects.some((subject) => !subject)) return undefined;
  return { count: Number(commits.count), subjects: subjects as string[] };
}

export function parseDevelopmentCallbackPayload(value: unknown): DevelopmentCallbackPayload | undefined {
  const payload = record(value);
  if (!payload) return undefined;
  for (const key of [
    "job_id", "event_id", "placement_id", "workspace_id", "channel_id", "thread_ts",
    "requester_id", "status", "summary",
  ] as const) {
    if (!boundedString(payload[key], key === "summary" ? 12_000 : 256)) return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(payload.job_id as string)
    || !["progress", "completed", "needs_decision", "needs_input", "failed", "timed_out"].includes(payload.status as string)
    || !["allowed", "warning"].includes(payload.quota_decision as string)) return undefined;

  const storyId = payload.story_id === undefined ? undefined : boundedString(payload.story_id, 200);
  if (payload.story_id !== undefined && !storyId) return undefined;
  let prUrl: string | undefined;
  if (payload.pr_url !== undefined) {
    if (typeof payload.pr_url !== "string") return undefined;
    try {
      const url = new URL(payload.pr_url);
      if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
      prUrl = url.toString();
    } catch { return undefined; }
  }
  const progress = parseProgress(payload.progress);
  if (payload.status === "progress" && !progress) return undefined;
  if (payload.status !== "progress" && payload.progress !== undefined) return undefined;
  const questions = parseQuestions(payload.questions);
  if (payload.questions !== undefined && !questions) return undefined;
  if (payload.status !== "needs_decision" && payload.questions !== undefined) return undefined;
  const gates = parseGates(payload.gates);
  if (payload.gates !== undefined && !gates) return undefined;
  if (payload.status !== "needs_input" && payload.gates !== undefined) return undefined;
  const commits = parseCommits(payload.commits);
  if (payload.commits !== undefined && !commits) return undefined;

  return {
    job_id: payload.job_id as string,
    event_id: payload.event_id as string,
    placement_id: payload.placement_id as string,
    workspace_id: payload.workspace_id as string,
    channel_id: payload.channel_id as string,
    thread_ts: payload.thread_ts as string,
    requester_id: payload.requester_id as string,
    status: payload.status as DevelopmentStatus,
    summary: payload.summary as string,
    quota_decision: payload.quota_decision as QuotaDecision["decision"],
    ...(storyId ? { story_id: storyId } : {}),
    ...(prUrl ? { pr_url: prUrl } : {}),
    ...(progress ? { progress } : {}),
    ...(questions ? { questions } : {}),
    ...(gates ? { gates } : {}),
    ...(commits ? { commits } : {}),
  };
}

function clean(value: string): string {
  return escapeUntrustedSlackMrkdwn(value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim());
}

function progressLabel(phase: DevelopmentProgressPhase): string {
  if (phase === "verifying") return "確認中";
  if (phase === "implementing") return "変更中";
  return "依頼を整理中";
}

export function renderDevelopmentProgress(payload: DevelopmentCallbackPayload): DevelopmentSlackMessage {
  const progress = payload.progress!;
  const minutes = Math.floor(progress.elapsed_sec / 60);
  const latest = progress.latest ? `\n最新: ${clean(progress.latest)}` : "";
  const text = [
    "🔨 Manaの改善を進めています",
    `現在: ${progressLabel(progress.phase)}`,
    `開始から: ${minutes}分`,
    `変更履歴: ${progress.commits}件${latest}`,
  ].join("\n");
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "🔨 *Manaの改善を進めています*" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*現在*\n${progressLabel(progress.phase)}` },
          { type: "mrkdwn", text: `*開始から*\n${minutes}分` },
          { type: "mrkdwn", text: `*変更履歴*\n${progress.commits}件` },
          ...(progress.latest ? [{ type: "mrkdwn", text: `*最新*\n${clean(progress.latest)}` }] : []),
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "merge・本番反映・secret変更は行いません" }] },
    ],
  };
}

export function renderDevelopmentResult(payload: DevelopmentCallbackPayload): DevelopmentSlackMessage {
  const summary = clean(payload.summary);
  const technical = [
    payload.story_id ? `Story: ${clean(payload.story_id)}` : undefined,
    payload.pr_url ? `PR: ${payload.pr_url}` : undefined,
  ].filter(Boolean).join("\n");

  if (payload.status === "completed") {
    const text = ["✅ Manaの改善案ができました", summary, technical].filter(Boolean).join("\n");
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: "✅ *Manaの改善案ができました*" } },
      { type: "section", text: { type: "mrkdwn", text: `*変わること・確認結果*\n${summary}` } },
    ];
    if (payload.commits && payload.commits.count > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [`*ここまでの変更: ${payload.commits.count}件*`, ...payload.commits.subjects.map((item) => `• ${clean(item)}`)].join("\n"),
        },
      });
    }
    if (payload.pr_url) {
      blocks.push({ type: "actions", elements: [{
        type: "button",
        text: { type: "plain_text", text: "Draft PRを見る" },
        url: payload.pr_url,
      }] });
    }
    if (technical) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: technical }] });
    return { text, blocks };
  }

  if (payload.status === "needs_decision") {
    const questions = payload.questions ?? [];
    const text = ["🙋 改善を続けるために判断が必要です", ...questions.map((item) => item.question), technical].filter(Boolean).join("\n");
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: `🙋 *改善を続けるために判断が必要です*\n${summary}` } },
    ];
    questions.forEach((question, index) => {
      const choices = question.options.map((option) => {
        const recommendation = option.recommended ? "（Manaの推奨）" : "";
        const description = option.description ? ` — ${clean(option.description)}` : "";
        return `• ${clean(option.label)}${recommendation}${description}`;
      });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: [`*${index + 1}. ${clean(question.question)}*`, ...choices].join("\n") },
      });
    });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "現時点では安全のため停止しています。回答内容を添えてManaへ再依頼してください。" }],
    });
    if (technical) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: technical }] });
    return { text, blocks };
  }

  if (payload.status === "needs_input") {
    const gates = payload.gates ?? [];
    const critical = gates.filter((gate) => gate.severity === "critical").length;
    const text = ["⏸ 改善は進みましたが、確認が必要なため停止しました", summary, technical].filter(Boolean).join("\n");
    const blocks: unknown[] = [
      { type: "section", text: { type: "mrkdwn", text: "⏸ *改善は進みましたが、確認が必要なため停止しました*" } },
      { type: "section", text: { type: "mrkdwn", text: summary } },
    ];
    if (payload.commits) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*ここまでの変更*\n${payload.commits.count}件` },
      });
    }
    if (gates.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [`*残っている確認: ${gates.length}件（重要 ${critical}件）*`,
            ...gates.slice(0, 3).map((gate) => `• ${clean(gate.text)}`)].join("\n"),
        },
      });
    }
    if (technical) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: technical }] });
    return { text, blocks };
  }

  const timedOut = payload.status === "timed_out";
  const heading = timedOut ? "⌛ 改善処理が時間内に完了しませんでした" : "⚠️ 改善処理を安全に停止しました";
  const text = [heading, summary, technical].filter(Boolean).join("\n");
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${heading}*` } },
      { type: "section", text: { type: "mrkdwn", text: summary } },
      { type: "context", elements: [{ type: "mrkdwn", text: "PR作成・merge・deploy・secret変更は行われていません" }] },
      ...(technical ? [{ type: "context", elements: [{ type: "mrkdwn", text: technical }] }] : []),
    ],
  };
}

export async function handleDevelopmentCallback(request: Request, options: {
  token?: string;
  placements: readonly RuntimePlacement[];
  resolve(event: SlackQueueEvent): Promise<SlackQueueEvent>;
  claim(event: SlackQueueEvent, payload: DevelopmentCallbackPayload): Promise<DevelopmentCallbackClaim>;
  recordDelivery(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void>;
  complete(eventId: string, payload: DevelopmentCallbackPayload,
    delivery: DevelopmentCallbackDelivery, fence?: number): Promise<void>;
  release(eventId: string, payload: DevelopmentCallbackPayload, fence?: number): Promise<void>;
  post(event: SlackQueueEvent, text: string, blocks?: unknown[]): Promise<string>;
  update?(event: SlackQueueEvent, text: string, blocks?: unknown[]): Promise<void>;
}): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!options.token || !safeEqual(bearer, options.token)) {
    return Response.json({ error: "development_callback_unauthorized" }, { status: 401 });
  }
  const payload = parseDevelopmentCallbackPayload(await request.json().catch(() => undefined));
  if (!payload) return Response.json({ error: "development_callback_invalid" }, { status: 400 });
  const placement = options.placements.find((candidate) => candidate.placementId === payload.placement_id);
  const allowed = placement?.developmentEnabled === true
    && placement.channelId === payload.channel_id
    && placement.audience?.allowedUserIds.includes(payload.requester_id)
    && placement.deliveryScopes?.some((scope) => scope.connector === "slack" && scope.channelId === payload.channel_id);
  if (!allowed) return Response.json({ error: "development_callback_forbidden" }, { status: 403 });

  const callbackEventId = payload.status === "progress"
    ? `development-progress:${payload.job_id}`
    : `development:${payload.job_id}`;
  const unresolvedEvent: SlackQueueEvent = {
    tenantId: "",
    eventId: callbackEventId,
    workspaceId: payload.workspace_id,
    channelId: payload.channel_id,
    threadTs: payload.thread_ts,
    messageTs: payload.thread_ts,
    userId: payload.requester_id,
    eventType: payload.status === "progress" ? "development_progress" : "development_result",
    text: "",
    receivedAt: new Date().toISOString(),
  };
  const event = await options.resolve(unresolvedEvent);
  if (!event.tenantId || event.eventId !== unresolvedEvent.eventId || event.workspaceId !== unresolvedEvent.workspaceId
    || event.channelId !== unresolvedEvent.channelId || event.threadTs !== unresolvedEvent.threadTs
    || event.userId !== unresolvedEvent.userId) throw new Error("development_callback_tenant_scope_mismatch");

  if (payload.status === "progress") {
    const message = renderDevelopmentProgress(payload);
    if (options.update) await options.update(event, message.text, message.blocks);
    return Response.json({ ok: true, state: "progress" });
  }

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
      const message = renderDevelopmentResult(payload);
      delivery = { state: "delivered", responseTs: await options.post(event, message.text, message.blocks) };
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
