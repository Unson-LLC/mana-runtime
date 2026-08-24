import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { armMeetingMinutesRecovery, recoverStaleMeetingMinutesRun } from "../meeting-minutes-recovery.js";
import { MeetingMinutesSlackClient } from "../meeting-minutes-slack.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { MeetingMinutesRun, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

const indexSource = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
const selection: MeetingMinutesSelection = { kind: "meeting_minutes_selection", runId: "Ev1_F1",
  destinationId: "united", workspaceId: "T1", appId: "A1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.1" };

function run(status: MeetingMinutesRun["status"] = "routed"): MeetingMinutesRun {
  return { version: 1, runId: "Ev1_F1", eventId: "Ev1", workspaceId: "T1", sourceAppId: "A1", sourceChannelId: "C1",
    sourceThreadTs: "1.1", sourceMessageTs: "1.1", file: { id: "F1", name: "meeting.txt" }, status,
    destination: { id: "united", projectId: "united", contextProjectCode: "techknight",
      taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-united", name: "United",
      organization: { id: "tech-knight", name: "Tech Knight" },
      slackChannelId: "CD", github: { owner: "o", repo: "r" } },
    slack: { processingTs: "3.1", postedChunkIndexes: [] }, createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z" };
}

describe("index.ts meeting-minutes recovery wiring", () => {
  it("routes the tenant Queue recovery body through the production recovery handler and fallback client", () => {
    const queueStart = indexSource.indexOf("async queue(");
    const recoveryStart = indexSource.indexOf("if (isTenantMeetingMinutesRecoveryBody(message.body))", queueStart);
    const recoveryEnd = indexSource.indexOf("if (isMeetingMinutesRecovery(message.body))", recoveryStart);
    const recoveryQueueBranch = indexSource.slice(recoveryStart, recoveryEnd);
    const handlerStart = indexSource.indexOf("async function processTenantMeetingMinutesRecovery");
    const handlerEnd = indexSource.indexOf("async function processTenantMeetingMinutesRedo", handlerStart);
    const recoveryHandler = indexSource.slice(handlerStart, handlerEnd);

    expect(queueStart).toBeGreaterThan(-1);
    expect(recoveryStart).toBeGreaterThan(queueStart);
    expect(recoveryQueueBranch).toContain("consumeTenantQueueMessage");
    expect(recoveryQueueBranch).toContain("expectedTenantMeetingMinutesRecoveryScope(env, tenantBody)");
    expect(recoveryQueueBranch).toContain("processTenantMeetingMinutesRecovery({");
    expect(recoveryHandler).toContain('effects.boundary("durable_object"');
    expect(recoveryHandler).toContain("recoverStaleMeetingMinutesRun(");
    expect(recoveryHandler).toContain("clients.slack.updateRunStatus(run, \"failed\")");
    expect(recoveryHandler).toContain("clients.slack.fallbackStatus(run, outcome)");
    expect(indexSource).toContain("effects.slack(`source-status:${run.runId}:${outcome}`");
    expect(indexSource).toContain("effects.slack(`source-status-fallback:${run.runId}:${outcome}`");
    expect(indexSource).toContain("projectStatusFailure(run)");
    expect(indexSource).toContain("createTenantCredentialFetch({");
  });

  it("projects stale recovery failure through tenant-scoped effects and Slack fallback without a bearer token", async () => {
    const fs = new MemoryFs();
    await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const effectIds: string[] = [];
    const effectEvents: unknown[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const credentialFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const isStatusUpdate = String(input).endsWith("/assistant.threads.setStatus");
      return Response.json(isStatusUpdate ? { ok: false, error: "status_unavailable" } : { ok: true });
    }) as typeof fetch;
    const sourceSlack = (fetchImpl: typeof fetch) => new MeetingMinutesSlackClient(undefined, fetchImpl);
    const slackEffect = async (effectId: string, event: unknown,
      execute: (fetchImpl: typeof fetch) => Promise<void>): Promise<void> => {
      effectIds.push(effectId);
      effectEvents.push(event);
      await execute(credentialFetch);
    };
    const updateStatus = (recoveryRun: MeetingMinutesRun, outcome: "failed") =>
      slackEffect(`source-status:${recoveryRun.runId}:${outcome}`,
        { kind: "source_status", runId: recoveryRun.runId, outcome },
        (fetchImpl) => sourceSlack(fetchImpl).updateRunStatus(recoveryRun, outcome));
    const fallbackStatus = (recoveryRun: MeetingMinutesRun, outcome: "failed") =>
      slackEffect(`source-status-fallback:${recoveryRun.runId}:${outcome}`,
        { kind: "source_status_fallback", runId: recoveryRun.runId, outcome },
        (fetchImpl) => sourceSlack(fetchImpl).projectStatusFailure(recoveryRun));

    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000,
      updateStatus,
      fallbackStatus,
    })).rejects.toThrow("slack_api_failed:assistant.threads.setStatus:status_unavailable");

    expect(effectIds).toEqual(["source-status:Ev1_F1:failed", "source-status-fallback:Ev1_F1:failed"]);
    expect(effectEvents).toEqual([
      { kind: "source_status", runId: "Ev1_F1", outcome: "failed" },
      { kind: "source_status_fallback", runId: "Ev1_F1", outcome: "failed" },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/assistant.threads.setStatus",
      "https://slack.com/api/chat.update",
    ]);
    expect(requests.every((request) => !JSON.stringify(request.init?.headers ?? {}).includes("Bearer"))).toBe(true);
    const fallbackBody = String(requests[1]?.init?.body);
    expect(fallbackBody).toContain("処理ID: Ev1_F1");
    expect(fallbackBody).toContain("失敗段階: 状態表示");
    expect(fallbackBody).toContain("エラーコード: STATUS_PROJECTION_FAILED");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      projectionFailure: { stage: "status_projection", code: "STATUS_PROJECTION_FAILED" },
      lifecycle: { recoveryFallbackOutcome: "succeeded", recoveryProjectedAt: expect.any(String) },
    });
  });
});
