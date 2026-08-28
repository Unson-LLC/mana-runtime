export const AUTONOMY_RUN_HISTORY_HOST = "autonomy-run-history.internal";

const RECENT_RUN_LIMIT = 20;
const CHECKPOINT_REFERENCE_LIMIT = 200;
const EVIDENCE_PER_RUN_LIMIT = 20;
const STALE_RUN_MS = 10 * 60 * 1000;
const CLEANUP_GRACE_MS = 60_000;

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface AutonomyRunHistoryNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

interface StorageTransactionLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

interface StorageLike extends StorageTransactionLike {
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
  transaction<T>(closure: (transaction: StorageTransactionLike) => Promise<T>): Promise<T>;
}

export interface AutonomyRunHistoryStateLike {
  storage: StorageLike;
}

export type AutonomyRunEvidenceKind = "task" | "receipt" | "artifact" | "run";

export interface AutonomyRunEvidence {
  kind: AutonomyRunEvidenceKind;
  id: string;
}

export interface AutonomyRunTerminalRecord {
  runId: string;
  sequence: number;
  experimentId: string;
  actorId: string;
  project: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed";
  outcomeCode?: string;
  errorCode?: string;
  evidence: AutonomyRunEvidence[];
}

export interface AutonomyRunCheckpoint {
  compactedRunCount: number;
  firstSequence: number;
  lastSequence: number;
  completedRuns: number;
  failedRuns: number;
  runIds: string[];
  evidence: AutonomyRunEvidence[];
}

export interface AutonomyRunProjection {
  untrustedHistoricalContext: true;
  checkpoint: AutonomyRunCheckpoint | null;
  recentRuns: AutonomyRunTerminalRecord[];
}

export interface AutonomyRunClaim {
  runId: string;
  experimentId: string;
  actorId: string;
  project: string;
  startedAt: number;
  experimentExpiresAt: number;
}

export interface CompleteAutonomyRunInput {
  runId: string;
  completedAt: number;
  outcomeCode?: string;
  evidence?: AutonomyRunEvidence[];
}

export interface FailAutonomyRunInput {
  runId: string;
  completedAt: number;
  errorCode: string;
  evidence?: AutonomyRunEvidence[];
}

interface ActiveAutonomyRun extends AutonomyRunClaim {
  sequence: number;
}

const ACTIVE_KEY = "autonomy-run:active";
const CHECKPOINT_KEY = "autonomy-run:checkpoint";
const EXPERIMENT_KEY = "autonomy-run:experiment";
const NEXT_SEQUENCE_KEY = "autonomy-run:next-sequence";
const RECENT_IDS_KEY = "autonomy-run:recent-ids";

function recordKey(runId: string): string {
  return `autonomy-run:record:${runId}`;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validTimestamp(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validEvidence(value: unknown): value is AutonomyRunEvidence[] {
  if (!Array.isArray(value) || value.length > EVIDENCE_PER_RUN_LIMIT) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const evidence = item as Record<string, unknown>;
    return exactKeys(evidence, ["kind", "id"])
      && ["task", "receipt", "artifact", "run"].includes(String(evidence.kind))
      && validText(evidence.id, 500);
  });
}

function validClaim(value: unknown): value is AutonomyRunClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return exactKeys(claim, ["runId", "experimentId", "actorId", "project", "startedAt", "experimentExpiresAt"])
    && validText(claim.runId, 500)
    && validText(claim.experimentId, 128)
    && validText(claim.actorId, 128)
    && validText(claim.project, 128)
    && validTimestamp(claim.startedAt)
    && validTimestamp(claim.experimentExpiresAt)
    && Number(claim.experimentExpiresAt) > Number(claim.startedAt)
    && Number(claim.experimentExpiresAt) - Number(claim.startedAt) <= 24 * 60 * 60 * 1000;
}

function validComplete(value: unknown): value is CompleteAutonomyRunInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return exactKeys(input, ["runId", "completedAt", "outcomeCode", "evidence"])
    && validText(input.runId, 500)
    && validTimestamp(input.completedAt)
    && (input.outcomeCode === undefined || validCode(input.outcomeCode))
    && (input.evidence === undefined || validEvidence(input.evidence));
}

function validFailure(value: unknown): value is FailAutonomyRunInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return exactKeys(input, ["runId", "completedAt", "errorCode", "evidence"])
    && validText(input.runId, 500)
    && validTimestamp(input.completedAt)
    && validCode(input.errorCode)
    && (input.evidence === undefined || validEvidence(input.evidence));
}

function isActiveRun(value: unknown): value is ActiveAutonomyRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return validText(run.runId, 500)
    && validText(run.experimentId, 128)
    && validText(run.actorId, 128)
    && validText(run.project, 128)
    && validTimestamp(run.startedAt)
    && validTimestamp(run.experimentExpiresAt)
    && Number.isInteger(run.sequence)
    && Number(run.sequence) >= 1;
}

function isEvidence(value: unknown): value is AutonomyRunEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return ["task", "receipt", "artifact", "run"].includes(String(evidence.kind))
    && validText(evidence.id, 500);
}

function isTerminalRecord(value: unknown): value is AutonomyRunTerminalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return validText(record.runId, 500)
    && Number.isInteger(record.sequence)
    && Number(record.sequence) >= 1
    && validText(record.experimentId, 128)
    && validText(record.actorId, 128)
    && validText(record.project, 128)
    && validTimestamp(record.startedAt)
    && validTimestamp(record.completedAt)
    && ["completed", "failed"].includes(String(record.status))
    && (record.outcomeCode === undefined || validCode(record.outcomeCode))
    && (record.errorCode === undefined || validCode(record.errorCode))
    && Array.isArray(record.evidence)
    && record.evidence.every(isEvidence);
}

function isCheckpoint(value: unknown): value is AutonomyRunCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return Number.isInteger(checkpoint.compactedRunCount)
    && Number(checkpoint.compactedRunCount) >= 1
    && Number.isInteger(checkpoint.firstSequence)
    && Number(checkpoint.firstSequence) >= 1
    && Number.isInteger(checkpoint.lastSequence)
    && Number(checkpoint.lastSequence) >= Number(checkpoint.firstSequence)
    && Number.isInteger(checkpoint.completedRuns)
    && Number(checkpoint.completedRuns) >= 0
    && Number.isInteger(checkpoint.failedRuns)
    && Number(checkpoint.failedRuns) >= 0
    && Array.isArray(checkpoint.runIds)
    && checkpoint.runIds.every((runId) => validText(runId, 500))
    && Array.isArray(checkpoint.evidence)
    && checkpoint.evidence.every(isEvidence);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => validText(item, 500));
}

function dedupeEvidence(values: AutonomyRunEvidence[]): AutonomyRunEvidence[] {
  const seen = new Set<string>();
  const result: AutonomyRunEvidence[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const evidence = values[index];
    if (!evidence) continue;
    const key = `${evidence.kind}:${evidence.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.unshift(evidence);
    if (result.length >= CHECKPOINT_REFERENCE_LIMIT) break;
  }
  return result;
}

function foldCheckpoint(
  checkpoint: AutonomyRunCheckpoint | null,
  record: AutonomyRunTerminalRecord,
): AutonomyRunCheckpoint {
  const previousRunIds = checkpoint?.runIds ?? [];
  const runIds = [...previousRunIds, record.runId].slice(-CHECKPOINT_REFERENCE_LIMIT);
  return {
    compactedRunCount: (checkpoint?.compactedRunCount ?? 0) + 1,
    firstSequence: checkpoint?.firstSequence ?? record.sequence,
    lastSequence: record.sequence,
    completedRuns: (checkpoint?.completedRuns ?? 0) + (record.status === "completed" ? 1 : 0),
    failedRuns: (checkpoint?.failedRuns ?? 0) + (record.status === "failed" ? 1 : 0),
    runIds,
    evidence: dedupeEvidence([...(checkpoint?.evidence ?? []), ...record.evidence]),
  };
}

async function appendTerminalRecord(
  storage: StorageTransactionLike,
  record: AutonomyRunTerminalRecord,
): Promise<"appended" | "replay"> {
  const existing = await storage.get(recordKey(record.runId));
  if (isTerminalRecord(existing)) return "replay";

  await storage.put(recordKey(record.runId), record);
  const recentIds = stringArray(await storage.get(RECENT_IDS_KEY))
    .filter((runId) => runId !== record.runId);
  recentIds.push(record.runId);

  const checkpointValue = await storage.get(CHECKPOINT_KEY);
  let checkpoint = isCheckpoint(checkpointValue) ? checkpointValue : null;
  while (recentIds.length > RECENT_RUN_LIMIT) {
    const compactedRunId = recentIds.shift();
    if (!compactedRunId) break;
    const compacted = await storage.get(recordKey(compactedRunId));
    if (isTerminalRecord(compacted)) checkpoint = foldCheckpoint(checkpoint, compacted);
  }

  await storage.put(RECENT_IDS_KEY, recentIds);
  if (checkpoint) await storage.put(CHECKPOINT_KEY, checkpoint);
  return "appended";
}

function namespaceKey(experimentId: string): string {
  return `autonomy-run-history:${experimentId}`;
}

function stub(namespace: AutonomyRunHistoryNamespace, experimentId: string): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(namespaceKey(experimentId)));
}

async function responseErrorCode(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === "string" && validCode(payload.error) ? payload.error : fallback;
}

export async function claimAutonomyRun(
  namespace: AutonomyRunHistoryNamespace,
  claim: AutonomyRunClaim,
): Promise<"claimed" | "replay" | "busy"> {
  const response = await stub(namespace, claim.experimentId).fetch(new Request(
    `https://${AUTONOMY_RUN_HISTORY_HOST}/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim),
    },
  ));
  if (response.status === 200) {
    const payload = await response.json().catch(() => null) as { disposition?: unknown } | null;
    if (payload?.disposition === "replay") return "replay";
  }
  if (response.status === 409) return "busy";
  if (response.ok) return "claimed";
  throw new Error(await responseErrorCode(response, "autonomy_run_claim_failed"));
}

export async function completeAutonomyRun(
  namespace: AutonomyRunHistoryNamespace,
  experimentId: string,
  input: CompleteAutonomyRunInput,
): Promise<void> {
  const response = await stub(namespace, experimentId).fetch(new Request(
    `https://${AUTONOMY_RUN_HISTORY_HOST}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ));
  if (!response.ok) throw new Error(await responseErrorCode(response, "autonomy_run_complete_failed"));
}

export async function failAutonomyRun(
  namespace: AutonomyRunHistoryNamespace,
  experimentId: string,
  input: FailAutonomyRunInput,
): Promise<void> {
  const response = await stub(namespace, experimentId).fetch(new Request(
    `https://${AUTONOMY_RUN_HISTORY_HOST}/fail`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ));
  if (!response.ok) throw new Error(await responseErrorCode(response, "autonomy_run_fail_failed"));
}

export async function readAutonomyRunProjection(
  namespace: AutonomyRunHistoryNamespace,
  experimentId: string,
): Promise<AutonomyRunProjection> {
  const response = await stub(namespace, experimentId).fetch(new Request(
    `https://${AUTONOMY_RUN_HISTORY_HOST}/projection`,
  ));
  if (!response.ok) throw new Error(await responseErrorCode(response, "autonomy_run_projection_failed"));
  return response.json() as Promise<AutonomyRunProjection>;
}

export async function readAutonomyRun(
  namespace: AutonomyRunHistoryNamespace,
  experimentId: string,
  runId: string,
): Promise<AutonomyRunTerminalRecord | null> {
  const response = await stub(namespace, experimentId).fetch(new Request(
    `https://${AUTONOMY_RUN_HISTORY_HOST}/run?runId=${encodeURIComponent(runId)}`,
  ));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await responseErrorCode(response, "autonomy_run_read_failed"));
  return response.json() as Promise<AutonomyRunTerminalRecord>;
}

export async function handleAutonomyRunHistoryRequest(
  state: AutonomyRunHistoryStateLike,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== AUTONOMY_RUN_HISTORY_HOST) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (request.method === "GET" && url.pathname === "/projection") {
    const recentIds = stringArray(await state.storage.get(RECENT_IDS_KEY));
    const recentRuns: AutonomyRunTerminalRecord[] = [];
    for (const runId of recentIds) {
      const record = await state.storage.get(recordKey(runId));
      if (isTerminalRecord(record)) recentRuns.push(record);
    }
    const checkpointValue = await state.storage.get(CHECKPOINT_KEY);
    return Response.json({
      untrustedHistoricalContext: true,
      checkpoint: isCheckpoint(checkpointValue) ? checkpointValue : null,
      recentRuns,
    } satisfies AutonomyRunProjection);
  }

  if (request.method === "GET" && url.pathname === "/run") {
    const runId = url.searchParams.get("runId");
    if (!validText(runId, 500)) return Response.json({ error: "autonomy_run_invalid" }, { status: 400 });
    const record = await state.storage.get(recordKey(runId));
    return isTerminalRecord(record)
      ? Response.json(record)
      : Response.json({ error: "not_found" }, { status: 404 });
  }

  if (request.method === "POST" && url.pathname === "/claim") {
    const body = await request.json().catch(() => null);
    if (!validClaim(body)) return Response.json({ error: "autonomy_run_invalid" }, { status: 400 });

    const outcome = await state.storage.transaction(async (storage) => {
      const storedExperiment = await storage.get(EXPERIMENT_KEY);
      if (storedExperiment !== undefined && storedExperiment !== body.experimentId) return "experiment_mismatch";
      if (storedExperiment === undefined) await storage.put(EXPERIMENT_KEY, body.experimentId);

      const terminal = await storage.get(recordKey(body.runId));
      if (isTerminalRecord(terminal)) return "replay";

      const activeValue = await storage.get(ACTIVE_KEY);
      const active = isActiveRun(activeValue) ? activeValue : null;
      if (active) {
        const elapsed = body.startedAt - active.startedAt;
        if (active.runId === body.runId && elapsed <= STALE_RUN_MS) return "busy";
        if (elapsed <= STALE_RUN_MS) return "busy";
        await appendTerminalRecord(storage, {
          runId: active.runId,
          sequence: active.sequence,
          experimentId: active.experimentId,
          actorId: active.actorId,
          project: active.project,
          startedAt: active.startedAt,
          completedAt: body.startedAt,
          status: "failed",
          errorCode: "autonomy_run_stale",
          evidence: [],
        });
        await storage.put(ACTIVE_KEY, null);
        if (active.runId === body.runId) return "replay";
      }

      const currentSequence = await storage.get(NEXT_SEQUENCE_KEY);
      const sequence = typeof currentSequence === "number" && Number.isInteger(currentSequence)
        ? currentSequence + 1
        : 1;
      await storage.put(NEXT_SEQUENCE_KEY, sequence);
      await storage.put(ACTIVE_KEY, { ...body, sequence } satisfies ActiveAutonomyRun);
      return "claimed";
    });

    if (outcome === "experiment_mismatch") {
      return Response.json({ error: "autonomy_run_experiment_mismatch" }, { status: 403 });
    }
    if (outcome === "replay") return Response.json({ disposition: "replay" });
    if (outcome === "busy") {
      return Response.json({ error: "autonomy_run_in_progress" }, { status: 409 });
    }
    await state.storage.setAlarm(body.experimentExpiresAt + CLEANUP_GRACE_MS);
    return new Response(null, { status: 204 });
  }

  if (request.method === "POST" && (url.pathname === "/complete" || url.pathname === "/fail")) {
    const body = await request.json().catch(() => null);
    const complete = url.pathname === "/complete";
    if ((complete && !validComplete(body)) || (!complete && !validFailure(body))) {
      return Response.json({ error: "autonomy_run_invalid" }, { status: 400 });
    }
    const terminalInput = body as CompleteAutonomyRunInput | FailAutonomyRunInput;
    const outcome = await state.storage.transaction(async (storage) => {
      const existing = await storage.get(recordKey(terminalInput.runId));
      if (isTerminalRecord(existing)) return "replay";

      const activeValue = await storage.get(ACTIVE_KEY);
      if (!isActiveRun(activeValue) || activeValue.runId !== terminalInput.runId) return "not_active";
      if (terminalInput.completedAt < activeValue.startedAt) return "invalid_time";

      const record: AutonomyRunTerminalRecord = complete
        ? {
            runId: activeValue.runId,
            sequence: activeValue.sequence,
            experimentId: activeValue.experimentId,
            actorId: activeValue.actorId,
            project: activeValue.project,
            startedAt: activeValue.startedAt,
            completedAt: terminalInput.completedAt,
            status: "completed",
            outcomeCode: (terminalInput as CompleteAutonomyRunInput).outcomeCode ?? "autonomy_run_completed",
            evidence: (terminalInput as CompleteAutonomyRunInput).evidence ?? [],
          }
        : {
            runId: activeValue.runId,
            sequence: activeValue.sequence,
            experimentId: activeValue.experimentId,
            actorId: activeValue.actorId,
            project: activeValue.project,
            startedAt: activeValue.startedAt,
            completedAt: terminalInput.completedAt,
            status: "failed",
            errorCode: (terminalInput as FailAutonomyRunInput).errorCode,
            evidence: (terminalInput as FailAutonomyRunInput).evidence ?? [],
          };
      await appendTerminalRecord(storage, record);
      await storage.put(ACTIVE_KEY, null);
      return "appended";
    });

    if (outcome === "not_active") {
      return Response.json({ error: "autonomy_run_not_active" }, { status: 409 });
    }
    if (outcome === "invalid_time") {
      return Response.json({ error: "autonomy_run_invalid_time" }, { status: 400 });
    }
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
