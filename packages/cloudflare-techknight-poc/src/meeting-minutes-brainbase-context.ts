import type {
  GeneratedMeetingMinutes,
  MeetingMinutesContextMode,
  MeetingMinutesContextReceipt,
  MeetingMinutesContextSourceRef,
  MeetingMinutesTaskCandidate,
} from "./meeting-minutes-contracts.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const RECEIPT_STATUSES = new Set(["resolved", "confirmed_empty", "partial", "unavailable"]);

function nonEmpty(value: unknown, max = 4_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function validateReceipt(value: unknown, expected: MeetingMinutesContextReceipt["identity"]): MeetingMinutesContextReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("meeting_minutes_context_invalid_receipt");
  const receipt = value as Partial<MeetingMinutesContextReceipt>;
  if (receipt.schema_version !== "meeting_minutes_context_receipt.v1" || !nonEmpty(receipt.receipt_id, 200)
    || !nonEmpty(receipt.checksum, 128) || !RECEIPT_STATUSES.has(String(receipt.status))
    || !receipt.identity || receipt.identity.run_id !== expected.run_id
    || receipt.identity.project_code !== expected.project_code
    || receipt.identity.transcript_sha256 !== expected.transcript_sha256) {
    if (receipt.identity && (receipt.identity.run_id !== expected.run_id
      || receipt.identity.project_code !== expected.project_code
      || receipt.identity.transcript_sha256 !== expected.transcript_sha256)) {
      throw new Error("meeting_minutes_context_identity_mismatch");
    }
    throw new Error("meeting_minutes_context_invalid_receipt");
  }
  if (!receipt.context || !Array.isArray(receipt.context.source_refs) || !Array.isArray(receipt.context.open_tasks)) {
    throw new Error("meeting_minutes_context_invalid_receipt");
  }
  return receipt as MeetingMinutesContextReceipt;
}

export class MeetingMinutesBrainbaseContextClient {
  private readonly fetchImpl: FetchLike;
  private readonly brokered: boolean;

  constructor(private readonly baseUrl: string, private readonly token?: string,
    fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.brokered = fetchImpl !== undefined;
  }

  async resolve(identity: MeetingMinutesContextReceipt["identity"], receiptId?: string): Promise<MeetingMinutesContextReceipt> {
    if (!this.baseUrl || (!this.token && !this.brokered)) throw new Error("meeting_minutes_context_client_unconfigured");
    const url = receiptId
      ? new URL(`/api/meeting-minutes/context-receipts/${encodeURIComponent(receiptId)}`, this.baseUrl)
      : new URL("/api/meeting-minutes/context-receipts", this.baseUrl);
    if (receiptId) {
      url.searchParams.set("run_id", identity.run_id);
      url.searchParams.set("project_code", identity.project_code);
      url.searchParams.set("transcript_sha256", identity.transcript_sha256);
    }
    const response = await this.fetchImpl.call(globalThis, url, {
      method: receiptId ? "GET" : "POST",
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), accept: "application/json",
        ...(receiptId ? {} : { "content-type": "application/json" }) },
      ...(receiptId ? {} : { body: JSON.stringify(identity) }), redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("meeting_minutes_context_redirect_rejected");
    }
    if (!response.ok) throw new Error(`meeting_minutes_context_request_failed:${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("meeting_minutes_context_invalid_response"); }
    const receipt = validateReceipt(payload, identity);
    if (receiptId && receipt.receipt_id !== receiptId) throw new Error("meeting_minutes_context_identity_mismatch");
    return receipt;
  }
}

export function resolveMeetingMinutesContextMode(value: string | undefined): MeetingMinutesContextMode {
  if (value === undefined || value === "" || value === "observe") return "observe";
  if (value === "required") return "required";
  throw new Error("meeting_minutes_context_mode_invalid");
}

export function assertMeetingMinutesContextUsable(receipt: MeetingMinutesContextReceipt,
  mode: MeetingMinutesContextMode): void {
  if (mode === "required" && receipt.status !== "resolved" && receipt.status !== "confirmed_empty") {
    throw new Error(`meeting_minutes_context_${receipt.status}`);
  }
}

function refKey(ref: MeetingMinutesContextSourceRef): string { return `${ref.type}:${ref.id}`; }

export function validateGeneratedMeetingMinutesContext(minutes: GeneratedMeetingMinutes,
  receipt: MeetingMinutesContextReceipt): void {
  if (minutes.brainbase_context_receipt_id !== receipt.receipt_id
    || minutes.brainbase_context_checksum !== receipt.checksum) {
    throw new Error("meeting_minutes_context_output_mismatch");
  }
  const allowed = new Set(receipt.context.source_refs.map(refKey));
  for (const ref of minutes.used_source_refs ?? []) {
    if (!allowed.has(refKey(ref))) throw new Error("meeting_minutes_context_source_ref_unknown");
  }
}

export function bindGeneratedMeetingMinutesContext(minutes: GeneratedMeetingMinutes,
  receipt: MeetingMinutesContextReceipt, mode: MeetingMinutesContextMode = "required"): GeneratedMeetingMinutes {
  const attestation = minutes.brainbase_context_attestation;
  const validSource = attestation?.schema_version === "meeting_minutes_context_attestation.v1"
    ? attestation.tool_name === "mcp__brainbase__brainbase_get_meeting_minutes_context"
    : attestation?.schema_version === "meeting_minutes_context_attestation.v2"
      && attestation.source === "worker_context_receipt";
  if (!attestation || !validSource
    || attestation.receipt_id !== receipt.receipt_id || attestation.checksum !== receipt.checksum
    || attestation.run_id !== receipt.identity.run_id
    || attestation.project_code !== receipt.identity.project_code
    || attestation.transcript_sha256 !== receipt.identity.transcript_sha256) {
    throw new Error("meeting_minutes_context_attestation_mismatch");
  }
  const allowedRefs = new Set(receipt.context.source_refs.map(refKey));
  const allowedIds = new Set(receipt.context.source_refs.map((ref) => ref.id));
  const usedSourceRefs = (minutes.used_source_refs ?? []).filter((ref) => allowedRefs.has(refKey(ref)));
  const hadUnknownRef = usedSourceRefs.length !== (minutes.used_source_refs ?? []).length
    || (minutes.decision_candidates ?? []).some((decision) =>
      (decision.source_ref_ids ?? []).some((id) => !allowedIds.has(id)));
  if (mode === "required" && hadUnknownRef) throw new Error("meeting_minutes_context_source_ref_unknown");
  const decisionCandidates = (minutes.decision_candidates ?? []).map((decision) => ({
    ...decision,
    ...(decision.source_ref_ids
      ? { source_ref_ids: decision.source_ref_ids.filter((id) => allowedIds.has(id)) }
      : {}),
  }));
  const bound = { ...minutes,
    brainbase_context_receipt_id: receipt.receipt_id,
    brainbase_context_checksum: receipt.checksum,
    ...(minutes.used_source_refs ? { used_source_refs: usedSourceRefs } : {}),
    ...(minutes.decision_candidates ? { decision_candidates: decisionCandidates } : {}),
    ...(hadUnknownRef ? { brainbase_context_warnings: ["unknown_source_ref_removed" as const] } : {}),
  };
  validateGeneratedMeetingMinutesContext(bound, receipt);
  return bound;
}

export function validateMeetingMinutesContextReceipt(value: unknown,
  expected: MeetingMinutesContextReceipt["identity"]): MeetingMinutesContextReceipt {
  return validateReceipt(value, expected);
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function bigrams(value: string): Set<string> {
  const chars = Array.from(normalized(value));
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}
function dice(left: string, right: string): number {
  const a = bigrams(left); const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let common = 0; for (const item of a) if (b.has(item)) common += 1;
  return (2 * common) / (a.size + b.size);
}
function taskId(task: Record<string, unknown>): string | undefined {
  return nonEmpty(task.id, 200) ?? nonEmpty(task.task_id, 200);
}

export function reconcileMeetingMinutesTask(candidate: MeetingMinutesTaskCandidate,
  receipt: MeetingMinutesContextReceipt): { outcome: "new" } | { outcome: "reused" | "needs_review"; taskId: string } {
  const title = normalized(candidate.title);
  const tasks = receipt.context.open_tasks.filter((task) => nonEmpty(task.title) && taskId(task));
  const exact = tasks.find((task) => normalized(String(task.title)) === title);
  if (exact) return { outcome: "reused", taskId: taskId(exact)! };
  const similar = tasks.map((task) => ({ task, score: dice(candidate.title, String(task.title)) }))
    .sort((left, right) => right.score - left.score)[0];
  if (similar && similar.score >= 0.45) return { outcome: "needs_review", taskId: taskId(similar.task)! };
  return { outcome: "new" };
}
