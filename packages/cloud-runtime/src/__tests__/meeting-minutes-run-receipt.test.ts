import { buildMeetingMinutesRunReceipt, classifyMeetingMinutesRunReceiptFailure,
  MeetingMinutesRunReceiptClient } from "../meeting-minutes-run-receipt.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import type { MeetingMinutesRun } from "../meeting-minutes-contracts.js";

function completedRun(overrides: Partial<MeetingMinutesRun> = {}): MeetingMinutesRun {
  return {
    version: 1, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceAppId: "A1",
    sourceChannelId: "C1", sourceThreadTs: "1.1", sourceMessageTs: "1.1",
    file: { id: "F1", name: "minutes.txt" }, status: "completed",
    destination: { id: "brainbase", projectId: "proj_brainbase", contextProjectCode: "brainbase",
      taskProjectCodes: ["brainbase"], taskBoardTargetId: "minutes-brainbase", name: "Brainbase",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "C2",
      github: { owner: "Unson-LLC", repo: "brainbase" } },
    outcomeCaseId: "case_01",
    github: { transcriptPath: "t", minutesPath: "m", transcriptUrl: "https://github.test/t", minutesUrl: "https://github.test/m" },
    slack: { processingTs: "2.1", parentTs: "3.1", postedChunkIndexes: [0] },
    statusProjection: { outcome: "completed", projectedAt: "2026-09-06T00:01:00.000Z" },
    terminalSlackReadback: { outcome: "completed", channel: "C1", ts: "2.1",
      bodyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      confirmedAt: "2026-09-06T00:01:00.000Z" },
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:01:00.000Z", ...overrides,
  };
}

describe("meeting-minutes run receipt", () => {
  it("preserves allowlisted receipt failure codes after a tenant boundary replay", () => {
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TenantBoundaryError("brainbase_proxy", "RUN_RECEIPT_FORBIDDEN"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_FORBIDDEN", retryable: false });
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TenantBoundaryError("brainbase_proxy", "RUN_RECEIPT_UPSTREAM_FAILED"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true });
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TenantBoundaryError("brainbase_proxy", "RUN_RECEIPT_INGEST_TRANSPORT_FAILED"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_INGEST_TRANSPORT_FAILED", retryable: true });
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TenantBoundaryError("brainbase_proxy", "RUN_RECEIPT_AUTHORITY_UNAVAILABLE"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_AUTHORITY_UNAVAILABLE", retryable: true });
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TenantBoundaryError("brainbase_proxy", "RUN_RECEIPT_AUTHORITY_REJECTED"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_AUTHORITY_REJECTED", retryable: false });
    expect(classifyMeetingMinutesRunReceiptFailure(
      new TypeError("fetch failed: authorization=secret-do-not-persist"),
    )).toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true });
  });

  it("builds a stable confirmed receipt only after the terminal Slack readback", async () => {
    const receipt = await buildMeetingMinutesRunReceipt(completedRun());
    expect(receipt).toMatchObject({ contract_version: "run_receipt.v1",
      source: { type: "mana", workflow_id: "cloudflare:meeting-minutes" },
      run: { project_id: "brainbase", status: "success", evidence_state: "confirmed" },
      delivery: { idempotency_key: expect.stringMatching(/^rr1_[a-f0-9]{64}$/) } });
    expect(receipt?.run.evidence_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "url", ref: "https://github.test/m" }),
      expect.objectContaining({ kind: "artifact_ref", ref: expect.stringContaining("slack:") }),
      expect.objectContaining({ kind: "artifact_ref", ref: "outcome_case:case_01" }),
    ]));
  });

  it("does not manufacture a healthy receipt while a task retry or readback is outstanding", async () => {
    await expect(buildMeetingMinutesRunReceipt(completedRun({ terminalSlackReadback: undefined }))).resolves.toBeUndefined();
    await expect(buildMeetingMinutesRunReceipt(completedRun({ taskRegistration: { registered: [],
      failure: { index: 0, message: "down", failedAt: "2026-09-06T00:01:00.000Z" } } }))).resolves.toBeUndefined();
  });

  it("uses a distinct immutable identity for a redo revision", async () => {
    const original = await buildMeetingMinutesRunReceipt(completedRun());
    const redone = await buildMeetingMinutesRunReceipt(completedRun({ revision: 1 }));
    expect(redone?.run.external_run_id).not.toBe(original?.run.external_run_id);
    expect(redone?.delivery.idempotency_key).not.toBe(original?.delivery.idempotency_key);
  });

  it("uses the canonical project code, not Mana's internal destination project ID", async () => {
    const original = await buildMeetingMinutesRunReceipt(completedRun());
    const sameGraphProject = await buildMeetingMinutesRunReceipt(completedRun({
      destination: { ...completedRun().destination!, projectId: "proj_brainbase_migrated" },
    }));
    expect(original?.run.project_id).toBe("brainbase");
    expect(sameGraphProject?.run.project_id).toBe("brainbase");
    expect(sameGraphProject?.delivery.idempotency_key).toBe(original?.delivery.idempotency_key);
  });

  it("marks delivery only after Brainbase reads back the persisted healthy receipt", async () => {
    const receipt = await buildMeetingMinutesRunReceipt(completedRun());
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "created", run: { id: "brainbase-run-1" },
        outcome_case_links: [{ case_id: "case_01", status: "linked" }] }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ receipt: { run_id: "brainbase-run-1",
        external_run_id: receipt!.run.external_run_id, source_status: "success", evidence_state: "confirmed" },
      diagnosis: { state: "healthy" } }));
    await expect(new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", fetchImpl)
      .emit(receipt!)).resolves.toEqual({ receiptId: "brainbase-run-1" });
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ pathname: "/api/run-receipts/brainbase-run-1/diagnosis" }), expect.any(Object));
    expect((fetchImpl.mock.calls[1]![0] as URL).searchParams.get("project_id")).toBe("brainbase");
  });

  it("classifies only the receipt operation and HTTP status for upstream HTTP failures", async () => {
    const receipt = await buildMeetingMinutesRunReceipt(completedRun());
    const ingestFetch = vi.fn().mockResolvedValue(new Response("authorization=must-not-persist", { status: 503 }));
    const ingestError = await new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", ingestFetch)
      .emit(receipt!).catch((error: unknown) => error);
    expect(classifyMeetingMinutesRunReceiptFailure(ingestError)).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
      operation: "ingest", httpStatus: 503,
    });

    const diagnosisFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "created", run: { id: "brainbase-run-1" },
        outcome_case_links: [{ case_id: "case_01", status: "linked" }] }, { status: 201 }))
      .mockResolvedValueOnce(new Response("authorization=must-not-persist", { status: 429 }));
    const diagnosisError = await new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", diagnosisFetch)
      .emit(receipt!).catch((error: unknown) => error);
    expect(classifyMeetingMinutesRunReceiptFailure(diagnosisError)).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_UPSTREAM_FAILED", retryable: true,
      operation: "diagnosis", httpStatus: 429,
    });
    expect(JSON.stringify([ingestError, diagnosisError])).not.toContain("must-not-persist");
  });

  it("keeps a declared OutcomeCase pending until Brainbase confirms its durable link", async () => {
    const receipt = await buildMeetingMinutesRunReceipt(completedRun());
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ status: "created", run: { id: "brainbase-run-1" } },
      { status: 201 }));
    await expect(new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", fetchImpl)
      .emit(receipt!)).rejects.toThrow("meeting_minutes_run_receipt_outcome_case_link_unconfirmed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies ingest and readback transport failures without persisting arbitrary upstream details", async () => {
    const receipt = await buildMeetingMinutesRunReceipt(completedRun());
    const ingestFetch = vi.fn().mockRejectedValue(new TypeError("unsafe transport detail"));
    const ingestError = await new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", ingestFetch)
      .emit(receipt!).catch((error: unknown) => error);
    expect((ingestError as Error).message).toBe("meeting_minutes_run_receipt_request_transport_failed");
    expect(classifyMeetingMinutesRunReceiptFailure(ingestError)).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_INGEST_TRANSPORT_FAILED", retryable: true,
    });

    const readbackFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "created", run: { id: "brainbase-run-1" },
        outcome_case_links: [{ case_id: "case_01", status: "linked" }] }, { status: 201 }))
      .mockRejectedValueOnce(new TypeError("unsafe readback detail"));
    const readbackError = await new MeetingMinutesRunReceiptClient("https://bb.test/api/run-receipts/ingest", "token", readbackFetch)
      .emit(receipt!).catch((error: unknown) => error);
    expect((readbackError as Error).message).toBe("meeting_minutes_run_receipt_readback_transport_failed");
    expect(classifyMeetingMinutesRunReceiptFailure(readbackError)).toEqual({
      stage: "run_receipt", code: "RUN_RECEIPT_READBACK_TRANSPORT_FAILED", retryable: true,
    });
  });

  it("classifies the tenant authority boundary separately from receipt transport", () => {
    expect(classifyMeetingMinutesRunReceiptFailure(new Error("meeting_minutes_run_receipt_authority_unavailable")))
      .toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_AUTHORITY_UNAVAILABLE", retryable: true });
    expect(classifyMeetingMinutesRunReceiptFailure(new Error("meeting_minutes_run_receipt_authority_rejected")))
      .toEqual({ stage: "run_receipt", code: "RUN_RECEIPT_AUTHORITY_REJECTED", retryable: false });
  });
});
