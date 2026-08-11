import type { PlacementProfile, Session } from "../shared/types.js";
import { getMessages, listSessions } from "../sessions/registry.js";
import type { LearningCandidateService } from "./candidate-outbox.js";

export interface LearningReconciliationResult {
  sessionsScanned: number;
  turnsAttempted: number;
  turnsWithoutAssistant: number;
  sessionsSkippedUnscoped: number;
  sessionsSkippedPlacement: number;
}

export interface LearningReconciliationOptions {
  placementIds: ReadonlySet<string>;
}

export function formatLearningReconciliationLog(result: LearningReconciliationResult): string {
  return `[learning] reconciled durable conversations sessions=${result.sessionsScanned} `
    + `attempted=${result.turnsAttempted} `
    + `without_assistant=${result.turnsWithoutAssistant} `
    + `skipped_unscoped=${result.sessionsSkippedUnscoped} `
    + `skipped_placement=${result.sessionsSkippedPlacement}`;
}

export function parseLearningReconciliationPlacements(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function placementProject(
  placements: PlacementProfile[] | undefined,
  placementId: string | undefined,
): string | undefined {
  if (!placementId) return undefined;
  return placements?.find((placement) => placement.id === placementId)?.projects?.[0];
}

/**
 * Rebuild review-required learning candidates from the durable conversation
 * ledger. This closes the gap where a process interruption happened after the
 * user message was stored but before the normal successful-response hook ran.
 *
 * The candidate service is idempotent, so startup reconciliation is safe to
 * repeat. It never writes Graph or placement memory directly.
 */
export function reconcileLearningCandidates(
  service: LearningCandidateService,
  placements?: PlacementProfile[],
  sessions: Session[] = listSessions(),
  options: LearningReconciliationOptions = { placementIds: new Set() },
): LearningReconciliationResult {
  let turnsAttempted = 0;
  let turnsWithoutAssistant = 0;
  let sessionsSkippedUnscoped = 0;
  let sessionsSkippedPlacement = 0;

  for (const session of sessions) {
    const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
    const workspace = stringValue(meta.team)
      ?? stringValue(meta.workspaceId)
      ?? stringValue(meta.workspace);
    const channelId = stringValue(session.replyContext?.channel) ?? stringValue(meta.channelId);
    if (!workspace || !channelId) {
      sessionsSkippedUnscoped += 1;
      continue;
    }

    const placementId = stringValue(meta.placementId);
    if (!placementId || !options.placementIds.has(placementId)) {
      sessionsSkippedPlacement += 1;
      continue;
    }
    const actorExternalId = stringValue(meta.speakerSlackId)
      ?? stringValue(meta.actorExternalId)
      ?? "unknown";
    const actorPersonId = stringValue(meta.actorPersonId);
    const messages = getMessages(session.id)
      .filter((message) => message.role === "user" || message.role === "assistant");

    // transportMeta describes the most recent inbound speaker, not every
    // historical message. Reconcile only the final user turn so evidence is
    // never attributed to an earlier participant in a multi-user thread.
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) continue;
    const user = messages[userIndex];
    const assistant = messages[userIndex + 1]?.role === "assistant"
      ? messages[userIndex + 1]
      : undefined;

    const projectCode = placementProject(placements, placementId);
    service.capture({
        sessionId: session.id,
        userMessageId: user.id,
        assistantMessageId: assistant?.id ?? `missing:${user.id}`,
        userContent: user.content,
        assistantContent: assistant?.content
          ?? "[No completed assistant response was persisted; review the user evidence directly.]",
        workspace,
        channelId,
        actorExternalId,
        ...(actorPersonId ? { actorPersonId } : {}),
        ...(projectCode ? { projectCode } : {}),
    });
    turnsAttempted += 1;
    if (!assistant) turnsWithoutAssistant += 1;
  }

  return {
    sessionsScanned: sessions.length,
    turnsAttempted,
    turnsWithoutAssistant,
    sessionsSkippedUnscoped,
    sessionsSkippedPlacement,
  };
}
