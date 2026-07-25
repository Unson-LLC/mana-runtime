export interface CriticalRoutingDecision {
  critical: boolean;
  reason?: "explicit-reviewer" | "important-decision" | "high-risk-action";
}

const EXPLICIT_REVIEWER_RE =
  /(?:critical-reviewer|opus\s*\/?\s*xhigh|(?:重要|critical).{0,24}(?:委譲|レビュー|review|delegate))/iu;

const IMPORTANT_DECISION_RE =
  /(?:重要|重大|high[- ]impact|critical).{0,40}(?:判断|決定|承認|設計|レビュー|decision|approve|architecture|review)/iu;

const HIGH_RISK_TOPIC_RE =
  /(?:セキュリティ|プライバシー|コンプライアンス|認証情報|資格情報|秘密情報|トークン|本番|production|security|privacy|compliance|credential|secret|token|破壊的|destructive|不可逆|hard[- ]to[- ]reverse|外部公開|公開物|customer[- ]facing)/iu;

const HIGH_RISK_ACTION_RE =
  /(?:変更|実行|削除|移行|公開|送信|決定|承認|設計|レビュー|deploy|change|execute|delete|remove|migrate|publish|send|decide|approve|design|review)/iu;

/**
 * Deterministic, deliberately conservative gateway classifier.
 *
 * It routes explicit reviewer requests immediately. For implicit routing it
 * requires either an important-decision phrase or both a high-risk topic and
 * an action, so routine status checks and summaries stay on the parent model.
 */
export function classifyCriticalTask(text: string): CriticalRoutingDecision {
  const normalized = text.trim();
  if (!normalized) return { critical: false };

  if (EXPLICIT_REVIEWER_RE.test(normalized)) {
    return { critical: true, reason: "explicit-reviewer" };
  }
  if (IMPORTANT_DECISION_RE.test(normalized)) {
    return { critical: true, reason: "important-decision" };
  }
  if (HIGH_RISK_TOPIC_RE.test(normalized) && HIGH_RISK_ACTION_RE.test(normalized)) {
    return { critical: true, reason: "high-risk-action" };
  }
  return { critical: false };
}

export function buildCriticalReviewPrompt(originalRequest: string): string {
  return [
    "You are the critical reviewer for a Slack parent agent.",
    "Review the original request thoroughly and produce a complete recommendation the parent can integrate into its final Slack answer.",
    "Call out material risks, assumptions, and any verification still required. Do not contact Slack directly.",
    "",
    "Original Slack request:",
    originalRequest,
  ].join("\n");
}
