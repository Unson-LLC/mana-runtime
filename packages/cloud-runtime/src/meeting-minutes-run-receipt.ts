import type { MeetingMinutesRun } from "./meeting-minutes-contracts.js";

export interface RunReceiptV1 {
  contract_version: "run_receipt.v1";
  source: { type: "mana"; workflow_id: string; runtime_target: "cloudflare" };
  run: { project_id: string; external_run_id: string; status: "success"; evidence_state: "confirmed";
    started_at: string; finished_at: string; action_required: "none";
    metrics: { slack_terminal_readback: true }; evidence_refs: Array<{ kind: "url" | "artifact_ref"; ref: string; label?: string }> };
  delivery: { idempotency_key: string; attempt: number; sent_at: string };
}

export interface ConfirmedRunReceiptDelivery { receiptId: string }

export interface MeetingMinutesRunReceiptFailure {
  stage: "run_receipt";
  code: string;
  retryable: boolean;
}

interface RunReceiptIngestResponse {
  status?: unknown;
  run?: { id?: unknown };
  /**
   * Returned by Brainbase only after it has validated the declared case against
   * the receipt project and durably recorded the case-to-receipt relation.
   */
  outcome_case_links?: Array<{ case_id?: unknown; status?: unknown }>;
}

/**
 * Converts only the client-owned, stable receipt boundary into durable
 * diagnostics. In particular, response bodies and arbitrary Error properties
 * remain transient because they can contain upstream content or credentials.
 */
export function classifyMeetingMinutesRunReceiptFailure(error: unknown): MeetingMinutesRunReceiptFailure {
  const message = error instanceof Error ? error.message : "";
  const stage = "run_receipt" as const;
  const exact: Record<string, [string, boolean]> = {
    meeting_minutes_run_receipt_client_unconfigured: ["RUN_RECEIPT_CLIENT_UNCONFIGURED", false],
    meeting_minutes_run_receipt_ingest_url_invalid: ["RUN_RECEIPT_INGEST_URL_INVALID", false],
    meeting_minutes_run_receipt_ingest_response_invalid: ["RUN_RECEIPT_INGEST_RESPONSE_INVALID", false],
    meeting_minutes_run_receipt_outcome_case_link_unconfirmed: ["RUN_RECEIPT_OUTCOME_CASE_LINK_UNCONFIRMED", false],
    meeting_minutes_run_receipt_readback_unconfirmed: ["RUN_RECEIPT_READBACK_UNCONFIRMED", false],
  };
  const classified = exact[message];
  if (classified) return { stage, code: classified[0], retryable: classified[1] };
  if (error instanceof Error && error.name === "TimeoutError") {
    return { stage, code: "RUN_RECEIPT_TIMEOUT", retryable: true };
  }
  const status = Number(message.match(/^meeting_minutes_run_receipt_(?:request|readback)_failed:(\d{3})$/)?.[1]);
  if (Number.isInteger(status)) {
    if (status === 401) return { stage, code: "RUN_RECEIPT_AUTHENTICATION_FAILED", retryable: false };
    if (status === 403) return { stage, code: "RUN_RECEIPT_FORBIDDEN", retryable: false };
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { stage, code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true };
    }
    if (status >= 400) return { stage, code: "RUN_RECEIPT_REQUEST_REJECTED", retryable: false };
  }
  return { stage, code: "RUN_RECEIPT_DELIVERY_FAILED", retryable: true };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function receiptIdentity(projectCode: string, externalRunId: string): Promise<string> {
  return `rr1_${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify([projectCode, "mana", externalRunId]),
  )))}`;
}

/**
 * Builds only a healthy receipt. This is deliberately stricter than the local
 * completed state: incomplete task registration or an unconfirmed source
 * status remains source-owned pending work, never a confirmed receipt.
 */
export async function buildMeetingMinutesRunReceipt(run: MeetingMinutesRun): Promise<RunReceiptV1 | undefined> {
  const destination = run.destination;
  const readback = run.terminalSlackReadback;
  if (!destination || run.status !== "completed" || run.failure || run.projectionFailure
    || run.statusProjection?.outcome !== "completed" || !readback || !run.github
    || run.taskRegistration?.pending || run.taskRegistration?.failure) return undefined;
  // A redo is a new terminal execution even though it intentionally reuses the
  // durable source run id. Keep its immutable receipt identity separate.
  const externalRunId = `mana:meeting-minutes:${run.runId}:revision:${run.revision ?? 0}`;
  // projectId is Mana's internal destination identifier. OutcomeCase links are
  // authorized against the Graph project code, so both the receipt and its
  // identity must use that canonical code.
  const projectCode = destination.contextProjectCode;
  const idempotencyKey = await receiptIdentity(projectCode, externalRunId);
  return { contract_version: "run_receipt.v1",
    source: { type: "mana", workflow_id: "cloudflare:meeting-minutes", runtime_target: "cloudflare" },
    run: { project_id: projectCode, external_run_id: externalRunId, status: "success",
      evidence_state: "confirmed", started_at: run.createdAt, finished_at: readback.confirmedAt,
      action_required: "none", metrics: { slack_terminal_readback: true }, evidence_refs: [
        { kind: "url", ref: run.github.minutesUrl, label: "minutes" },
        { kind: "artifact_ref", ref: `slack:${readback.channel}:${readback.ts}:${readback.bodyHash.slice("sha256:".length)}`,
          label: "source_status_readback" },
        ...(run.outcomeCaseId
          ? [{ kind: "artifact_ref" as const, ref: `outcome_case:${run.outcomeCaseId}`,
            label: "declared_outcome_case" }]
          : []),
      ] },
    delivery: { idempotency_key: idempotencyKey, attempt: 1, sent_at: new Date().toISOString() },
  };
}

export class MeetingMinutesRunReceiptClient {
  constructor(private readonly ingestUrl: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async emit(receipt: RunReceiptV1): Promise<ConfirmedRunReceiptDelivery> {
    if (!this.ingestUrl || !this.token) throw new Error("meeting_minutes_run_receipt_client_unconfigured");
    const response = await this.fetchImpl(this.ingestUrl, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(receipt), signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`meeting_minutes_run_receipt_request_failed:${response.status}`);
    }
    const result = await response.json().catch(() => null) as RunReceiptIngestResponse | null;
    const receiptId = typeof result?.run?.id === "string" ? result.run.id : undefined;
    if ((result?.status !== "created" && result?.status !== "duplicate") || !receiptId) {
      throw new Error("meeting_minutes_run_receipt_ingest_response_invalid");
    }
    const declaredCaseId = receipt.run.evidence_refs.find((reference) => reference.kind === "artifact_ref"
      && reference.ref.startsWith("outcome_case:"))?.ref.slice("outcome_case:".length);
    if (declaredCaseId && !result?.outcome_case_links?.some((link) => link.case_id === declaredCaseId
      && (link.status === "linked" || link.status === "duplicate"))) {
      throw new Error("meeting_minutes_run_receipt_outcome_case_link_unconfirmed");
    }
    const readbackUrl = new URL(this.ingestUrl);
    if (!readbackUrl.pathname.endsWith("/ingest")) {
      throw new Error("meeting_minutes_run_receipt_ingest_url_invalid");
    }
    readbackUrl.pathname = `${readbackUrl.pathname.slice(0, -"/ingest".length)}/${encodeURIComponent(receiptId)}/diagnosis`;
    readbackUrl.searchParams.set("project_id", receipt.run.project_id);
    const readback = await this.fetchImpl(readbackUrl, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    if (readback.status !== 200) throw new Error(`meeting_minutes_run_receipt_readback_failed:${readback.status}`);
    const confirmation = await readback.json().catch(() => null) as {
      receipt?: { run_id?: unknown; external_run_id?: unknown; source_status?: unknown; evidence_state?: unknown };
      diagnosis?: { state?: unknown };
    } | null;
    if (confirmation?.diagnosis?.state !== "healthy" || confirmation.receipt?.run_id !== receiptId
      || confirmation.receipt?.external_run_id !== receipt.run.external_run_id
      || confirmation.receipt?.source_status !== "success" || confirmation.receipt?.evidence_state !== "confirmed") {
      throw new Error("meeting_minutes_run_receipt_readback_unconfirmed");
    }
    return { receiptId };
  }
}
