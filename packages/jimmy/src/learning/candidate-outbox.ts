import { createHash } from "node:crypto";
import { initDb } from "../sessions/registry.js";

export interface LearningTurnInput {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  userContent: string;
  assistantContent: string;
  workspace: string;
  channelId: string;
  actorExternalId: string;
  actorPersonId?: string;
  projectCode?: string;
}

export interface LearningCandidatePayload {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  workspace: string;
  channelId: string;
  actorExternalId: string;
  actorPersonId?: string;
  projectCode?: string;
  snippet: string;
  evidenceHash: string;
  extractorVersion: string;
}

export interface LearningOutboxItem {
  idempotencyKey: string;
  payload: LearningCandidatePayload;
  status: "pending" | "submitting" | "submitted" | "dead";
  requiresReview: boolean;
  candidateIds?: string[];
  lastError?: string;
  attemptCount: number;
  nextRetryAt?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningOutboxRepository {
  enqueue(item: LearningOutboxItem): LearningOutboxItem;
  claimPending(limit?: number, now?: Date): LearningOutboxItem[];
  markSubmitted(idempotencyKey: string, candidateIds: string[]): boolean;
  markFailed(idempotencyKey: string, reasonCode: string, nextRetryAt: string, dead: boolean): boolean;
}

export type LearningSubmitResult =
  | { status: "submitted"; candidateIds: string[] }
  | { status: "unavailable"; reasonCode: string };

export type LearningCandidateSubmitter = (
  item: LearningOutboxItem,
) => Promise<LearningSubmitResult>;

const EXTRACTOR_VERSION = "conversation-turn-v1";
const MAX_ATTEMPTS = 8;

export type CanonicalPersonResolver = (
  externalId: string,
  workspace: string,
) => string | undefined;

export function createStaticPersonResolver(rawJson?: string): CanonicalPersonResolver {
  let mapping: Record<string, string> = {};
  if (rawJson?.trim()) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mapping = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
        );
      }
    } catch {
      mapping = {};
    }
  }
  return (externalId, workspace) => mapping[`${workspace}:${externalId}`] ?? mapping[externalId];
}

/**
 * Durable boundary between a conversation and Graph learning. Capturing a turn
 * only creates review-required evidence; Brainbase owns approval and promotion.
 */
export class LearningCandidateService {
  constructor(private readonly deps: {
    repository: LearningOutboxRepository;
    submit: LearningCandidateSubmitter;
    resolveActorPersonId?: CanonicalPersonResolver;
  }) {}

  capture(turn: LearningTurnInput): LearningOutboxItem {
    const idempotencyKey = createHash("sha256")
      .update([EXTRACTOR_VERSION, turn.sessionId, turn.userMessageId, turn.assistantMessageId].join(":"))
      .digest("hex");
    const snippet = [
      `User: ${turn.userContent}`,
      `Assistant: ${turn.assistantContent}`,
    ].join("\n").slice(0, 8_000);
    const now = new Date().toISOString();
    const actorPersonId = turn.actorPersonId
      ?? this.deps.resolveActorPersonId?.(turn.actorExternalId, turn.workspace);
    return this.deps.repository.enqueue({
      idempotencyKey,
      payload: {
        sessionId: turn.sessionId,
        userMessageId: turn.userMessageId,
        assistantMessageId: turn.assistantMessageId,
        workspace: turn.workspace,
        channelId: turn.channelId,
        actorExternalId: turn.actorExternalId,
        ...(actorPersonId ? { actorPersonId } : {}),
        ...(turn.projectCode ? { projectCode: turn.projectCode } : {}),
        snippet,
        evidenceHash: createHash("sha256").update(snippet).digest("hex"),
        extractorVersion: EXTRACTOR_VERSION,
      },
      status: "pending",
      requiresReview: true,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async flush(limit = 20): Promise<{ submitted: number; pending: number }> {
    const rows = this.deps.repository.claimPending(limit, new Date());
    let submitted = 0;
    for (const row of rows) {
      try {
        const result = await this.deps.submit(row);
        if (result.status === "submitted") {
          if (this.deps.repository.markSubmitted(row.idempotencyKey, result.candidateIds)) submitted += 1;
        } else {
          this.retry(row, result.reasonCode);
        }
      } catch {
        this.retry(row, "submit_failed");
      }
    }
    return { submitted, pending: rows.length - submitted };
  }

  private retry(row: LearningOutboxItem, reasonCode: string): void {
    // Missing runtime configuration or identity projection can be repaired by
    // operators later; do not permanently discard those candidates.
    const repairable = reasonCode === "not_configured" || reasonCode === "identity_unresolved";
    const dead = !repairable && row.attemptCount >= MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, row.attemptCount - 1));
    this.deps.repository.markFailed(
      row.idempotencyKey,
      reasonCode,
      new Date(Date.now() + delayMs).toISOString(),
      dead,
    );
  }
}

function rowToOutboxItem(row: Record<string, unknown>): LearningOutboxItem {
  return {
    idempotencyKey: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload)) as LearningCandidatePayload,
    status: row.status as LearningOutboxItem["status"],
    requiresReview: Boolean(row.requires_review),
    candidateIds: row.candidate_ids ? JSON.parse(String(row.candidate_ids)) as string[] : undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    attemptCount: Number(row.attempt_count ?? 0),
    nextRetryAt: (row.next_retry_at as string | null) ?? undefined,
    claimedAt: (row.claimed_at as string | null) ?? undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteLearningOutboxRepository implements LearningOutboxRepository {
  enqueue(item: LearningOutboxItem): LearningOutboxItem {
    const database = initDb();
    database.prepare(`
      INSERT OR IGNORE INTO learning_candidate_outbox (
        idempotency_key, payload, status, requires_review, candidate_ids,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      item.idempotencyKey,
      JSON.stringify(item.payload),
      item.status,
      item.requiresReview ? 1 : 0,
      item.createdAt,
      item.updatedAt,
    );
    const row = database.prepare(
      "SELECT * FROM learning_candidate_outbox WHERE idempotency_key = ?",
    ).get(item.idempotencyKey) as Record<string, unknown>;
    return rowToOutboxItem(row);
  }

  claimPending(limit = 20, now = new Date()): LearningOutboxItem[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const database = initDb();
    const nowIso = now.toISOString();
    return database.transaction(() => {
      database.prepare(`
        UPDATE learning_candidate_outbox
        SET status = 'pending', claimed_at = NULL
        WHERE status = 'submitting' AND claimed_at < ?
      `).run(new Date(now.getTime() - 10 * 60_000).toISOString());
      const keys = database.prepare(`
        SELECT idempotency_key
        FROM learning_candidate_outbox
        WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY COALESCE(next_retry_at, created_at) ASC
        LIMIT ?
      `).all(nowIso, safeLimit) as Array<{ idempotency_key: string }>;
      if (keys.length === 0) return [];
      const claim = database.prepare(`
        UPDATE learning_candidate_outbox
        SET status = 'submitting', claimed_at = ?, attempt_count = attempt_count + 1, updated_at = ?
        WHERE idempotency_key = ? AND status = 'pending'
      `);
      const claimed: LearningOutboxItem[] = [];
      for (const { idempotency_key: key } of keys) {
        if (claim.run(nowIso, nowIso, key).changes !== 1) continue;
        const row = database.prepare(
          "SELECT * FROM learning_candidate_outbox WHERE idempotency_key = ?",
        ).get(key) as Record<string, unknown>;
        claimed.push(rowToOutboxItem(row));
      }
      return claimed;
    })();
  }

  markSubmitted(idempotencyKey: string, candidateIds: string[]): boolean {
    const result = initDb().prepare(`
      UPDATE learning_candidate_outbox
      SET status = 'submitted', candidate_ids = ?, last_error = NULL,
          claimed_at = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'submitting'
    `).run(JSON.stringify(candidateIds), new Date().toISOString(), idempotencyKey);
    return result.changes === 1;
  }

  markFailed(idempotencyKey: string, reasonCode: string, nextRetryAt: string, dead: boolean): boolean {
    const result = initDb().prepare(`
      UPDATE learning_candidate_outbox
      SET status = ?, last_error = ?, next_retry_at = ?, claimed_at = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'submitting'
    `).run(
      dead ? "dead" : "pending",
      reasonCode.slice(0, 120),
      nextRetryAt,
      new Date().toISOString(),
      idempotencyKey,
    );
    return result.changes === 1;
  }
}
