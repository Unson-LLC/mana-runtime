import { armMeetingMinutesRecovery, MeetingMinutesRecoveryOutcomePersistenceError,
  recoverStaleMeetingMinutesRun } from "../meeting-minutes-recovery.js";
import { loadMeetingMinutesRun, saveMeetingMinutesRun } from "../meeting-minutes-state.js";
import type { MeetingMinutesRun, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import { MemoryFs } from "./meeting-minutes-test-helpers.js";

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

class FailOnWriteFs extends MemoryFs {
  writeCount = 0;
  failOnWrite?: number;
  failWrites?: Set<number>;
  failWritesFrom?: number;

  override async writeFile(path: string, value: string): Promise<void> {
    this.writeCount += 1;
    if (this.failOnWrite === this.writeCount ||
      this.failWrites?.has(this.writeCount) ||
      (this.failWritesFrom !== undefined && this.writeCount >= this.failWritesFrom)) {
      if (this.failOnWrite === this.writeCount) this.failOnWrite = undefined;
      throw new Error("recovery marker unavailable");
    }
    await super.writeFile(path, value);
  }
}

describe("meeting minutes stale recovery", () => {
  it("arms one fixed deadline per Slack action without extending it on Queue retry", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const first = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const second = await armMeetingMinutesRecovery(fs, selection, 60_000);
    expect(second.event).toEqual(first.event);
    expect(first.event).toMatchObject({
      workspaceId: selection.workspaceId,
      channelId: selection.channelId,
      threadTs: selection.threadTs,
      userId: selection.userId,
    });
    expect((await loadMeetingMinutesRun(fs, selection.runId))?.lifecycle?.deadlineAt)
      .toBe(new Date(1_000 + 20 * 60 * 1_000).toISOString());
  });

  it("recovers a stale nonterminal run once and leaves completed or duplicate watchdogs alone", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, { now: () => 1_000 + 20 * 60 * 1_000,
      updateStatus })).toBe("recovered");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "failed",
      failure: { stage: "routed", message: "meeting_minutes_processing_interrupted" },
      lifecycle: { recoveryProjectedAt: expect.any(String) } });
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, { now: () => 9_999_999, updateStatus })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledTimes(1);
  });

  it("does not let an old watchdog fail a newer explicit retry", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const old = await armMeetingMinutesRecovery(fs, selection, 1_000);
    await armMeetingMinutesRecovery(fs, { ...selection, actionTs: "4.1" }, 2_000);
    const updateStatus = vi.fn();
    expect(await recoverStaleMeetingMinutesRun(fs, old.event, { now: () => 9_999_999, updateStatus })).toBe("superseded");
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("treats an already projected failure as terminal without duplicating the Slack projection", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectedAt: new Date(1_000).toISOString() };
    await saveMeetingMinutesRun(fs, failed);
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn();
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000,
      updateStatus,
    })).toBe("terminal");
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("starts a fresh watchdog for a newer explicit retry after an old recovery marker", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectionAttemptedAt: new Date(1_000).toISOString(), recoveryProjectedAt: new Date(1_000).toISOString() };
    await saveMeetingMinutesRun(fs, failed);
    const retried = await armMeetingMinutesRecovery(fs, { ...selection, actionTs: "4.1" }, 2_000);
    expect(retried.terminal).toBe(false);
    expect(retried.delaySeconds).toBe(20 * 60);
    const retriedRun = await loadMeetingMinutesRun(fs, selection.runId);
    expect(retriedRun).toMatchObject({ lifecycle: { actionTs: "4.1" } });
    expect(retriedRun?.lifecycle).not.toHaveProperty("recoveryProjectionAttemptedAt");
    expect(retriedRun?.lifecycle).not.toHaveProperty("recoveryProjectedAt");
  });

  it("uses one non-recursive fallback when stale recovery status projection fails", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockResolvedValue(undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    })).rejects.toThrow("slack update down");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledWith(
      expect.objectContaining({ projectionFailure: expect.objectContaining({
        stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
      }) }), "failed", expect.objectContaining({ stage: "status_projection" }));
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      projectionFailure: { stage: "status_projection", code: "STATUS_PROJECTION_FAILED" },
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String), recoveryFallbackOutcome: "succeeded",
        recoveryProjectedAt: expect.any(String) },
    });
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus, fallbackStatus,
    })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
  });

  it("does not invoke fallback until the recovery claim marker is durable, then retries on redelivery", async () => {
    const fs = new FailOnWriteFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    // Writes 1 and 2 are the fixture and watchdog arm. Write 3 persists the
    // failed run; write 4 is the pre-projection claim marker and is unavailable.
    fs.failOnWrite = 4;
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    })).rejects.toThrow("meeting_minutes_recovery_projection_claim_save_failed");
    expect(updateStatus).not.toHaveBeenCalled();
    expect(fallbackStatus).not.toHaveBeenCalled();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({ status: "failed",
      failure: { stage: "routed", message: "meeting_minutes_processing_interrupted" } });
    expect(await loadMeetingMinutesRun(fs, selection.runId)).not.toHaveProperty("projectionFailure");
    expect(await loadMeetingMinutesRun(fs, selection.runId)).not.toMatchObject({
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String) },
    });

    // Redelivery sees no durable claim, retries the projection, and only then
    // invokes the one-shot fallback after the marker save succeeds.
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus, fallbackStatus,
    })).rejects.toThrow("slack update down");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      projectionFailure: { stage: "status_projection", code: "STATUS_PROJECTION_FAILED" },
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String), recoveryFallbackOutcome: "succeeded",
        recoveryProjectedAt: expect.any(String) },
    });
    consoleError.mockRestore();
  });

  it("marks a failed fallback attempt terminal without masking the original projection error", async () => {
    const fs = new MemoryFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockRejectedValue(new Error("fallback unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    })).rejects.toThrow("slack update down");
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus, fallbackStatus,
    })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String), recoveryFallbackOutcome: "failed" },
    });
    consoleError.mockRestore();
  });

  it("retries the recovery outcome save once without invoking fallback again", async () => {
    const fs = new FailOnWriteFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    fs.failOnWrite = 5;
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockResolvedValue(undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    })).rejects.toThrow("slack update down");
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(fs.writeCount).toBe(6);
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String), recoveryFallbackOutcome: "succeeded",
        recoveryProjectedAt: expect.any(String) },
    });
  });

  it("surfaces an operational error when the claimed fallback outcome cannot be persisted", async () => {
    const fs = new FailOnWriteFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    fs.failWritesFrom = 6;
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcomePromise = recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    });
    await expect(outcomePromise).rejects.toBeInstanceOf(MeetingMinutesRecoveryOutcomePersistenceError);
    await expect(outcomePromise).rejects.toMatchObject({ code: "MEETING_MINUTES_RECOVERY_OUTCOME_PERSIST_FAILED" });
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(fs.writeCount).toBe(8);
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryProjectionAttemptedAt: expect.any(String) },
    });
    expect(await loadMeetingMinutesRun(fs, selection.runId)).not.toMatchObject({
      lifecycle: { recoveryFallbackOutcome: expect.any(String) },
    });
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus, fallbackStatus,
    })).rejects.toBeInstanceOf(MeetingMinutesRecoveryOutcomePersistenceError);
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("redelivery retries a known fallback outcome without re-projecting Slack", async () => {
    const fs = new FailOnWriteFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    // Writes 6 and 7 are the bounded outcome attempts. The best-effort
    // persistence-failure marker at write 8 succeeds with the known outcome.
    fs.failWrites = new Set([6, 7]);
    const updateStatus = vi.fn().mockRejectedValue(new Error("slack update down"));
    const fallbackStatus = vi.fn().mockResolvedValue(undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus, fallbackStatus,
    })).rejects.toBeInstanceOf(MeetingMinutesRecoveryOutcomePersistenceError);
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryFallbackOutcome: "succeeded",
        recoveryFallbackOutcomePersistenceFailedAt: expect.any(String) },
    });

    fs.failWrites = new Set();
    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus, fallbackStatus,
    })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(fallbackStatus).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryFallbackOutcome: "succeeded", recoveryFallbackOutcomePersistedAt: expect.any(String) },
    });
  });

  it("redelivery persists a claimed fallback outcome without re-projecting Slack", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.failure = { stage: "github_save", message: "github down" };
    failed.projectionFailure = { stage: "status_projection", code: "STATUS_PROJECTION_FAILED",
      retryable: true, failedAt: new Date(1_000).toISOString() };
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectionClaimedAt: new Date(1_000).toISOString(),
      recoveryProjectionAttemptedAt: new Date(1_001).toISOString(), recoveryFallbackOutcome: "succeeded" };
    await saveMeetingMinutesRun(fs, failed);
    const updateStatus = vi.fn();
    const fallbackStatus = vi.fn();
    expect(await recoverStaleMeetingMinutesRun(fs, {
      kind: "meeting_minutes_recovery", runId: selection.runId, workspaceId: selection.workspaceId,
      appId: selection.appId, channelId: selection.channelId, threadTs: selection.threadTs,
      userId: selection.userId, actionTs: selection.actionTs,
    }, { now: () => 9_999_999, updateStatus, fallbackStatus })).toBe("terminal");
    expect(updateStatus).not.toHaveBeenCalled();
    expect(fallbackStatus).not.toHaveBeenCalled();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      failure: { stage: "github_save", message: "github down" },
      lifecycle: { recoveryFallbackOutcome: "succeeded", recoveryFallbackOutcomePersistedAt: expect.any(String) },
    });
  });

  it("fails closed when an attempted recovery has no fallback outcome", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.failure = { stage: "github_save", message: "github down" };
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectionAttemptedAt: new Date(1_001).toISOString(),
      recoveryFallbackOutcomePersistedAt: new Date(1_002).toISOString() };
    await saveMeetingMinutesRun(fs, failed);
    const updateStatus = vi.fn();
    const fallbackStatus = vi.fn();
    await expect(recoverStaleMeetingMinutesRun(fs, {
      kind: "meeting_minutes_recovery", runId: selection.runId, workspaceId: selection.workspaceId,
      appId: selection.appId, channelId: selection.channelId, threadTs: selection.threadTs,
      userId: selection.userId, actionTs: selection.actionTs,
    }, { now: () => 9_999_999, updateStatus, fallbackStatus })).rejects
      .toBeInstanceOf(MeetingMinutesRecoveryOutcomePersistenceError);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(fallbackStatus).not.toHaveBeenCalled();
  });

  it("treats a claim-only recovery as indeterminate without re-projecting Slack", async () => {
    const fs = new MemoryFs();
    const failed = run("failed");
    failed.failure = { stage: "routed", message: "meeting_minutes_processing_interrupted" };
    failed.lifecycle = { actionTs: selection.actionTs, deadlineAt: new Date(1_000).toISOString(),
      recoveryProjectionClaimedAt: new Date(1_001).toISOString() };
    await saveMeetingMinutesRun(fs, failed);
    const updateStatus = vi.fn();
    const fallbackStatus = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await recoverStaleMeetingMinutesRun(fs, {
      kind: "meeting_minutes_recovery", runId: selection.runId, workspaceId: selection.workspaceId,
      appId: selection.appId, channelId: selection.channelId, threadTs: selection.threadTs,
      userId: selection.userId, actionTs: selection.actionTs,
    }, { now: () => 9_999_999, updateStatus, fallbackStatus })).toBe("terminal");
    expect(updateStatus).not.toHaveBeenCalled();
    expect(fallbackStatus).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "MEETING_MINUTES_RECOVERY_PROJECTION_INDETERMINATE"));
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryProjectionClaimedAt: expect.any(String) },
    });
    expect(await loadMeetingMinutesRun(fs, selection.runId)).not.toMatchObject({
      lifecycle: { recoveryProjectedAt: expect.any(String) },
    });
    consoleError.mockRestore();
  });

  it("does not duplicate Slack projection when the final completion save fails", async () => {
    const fs = new FailOnWriteFs(); await saveMeetingMinutesRun(fs, run());
    const armed = await armMeetingMinutesRecovery(fs, selection, 1_000);
    // Writes 1-4 persist the fixture, watchdog, failed state, and projection
    // claim. The successful Slack call is followed by the completion save at
    // write 5, which fails once.
    fs.failOnWrite = 5;
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 1_000 + 20 * 60 * 1_000, updateStatus,
    })).rejects.toThrow("recovery marker unavailable");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(await loadMeetingMinutesRun(fs, selection.runId)).toMatchObject({
      lifecycle: { recoveryProjectionClaimedAt: expect.any(String) },
    });

    expect(await recoverStaleMeetingMinutesRun(fs, armed.event, {
      now: () => 9_999_999, updateStatus,
    })).toBe("terminal");
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "MEETING_MINUTES_RECOVERY_PROJECTION_INDETERMINATE"));
    consoleError.mockRestore();
  });
});
